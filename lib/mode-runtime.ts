// pi-mode-switcher · 模式运行时
// 职责：虚拟 default/full 模式、有效模式解析、工具合并与过滤、
//       模式应用（即时生效）、技能块重建、模式状态持久化（pi.appendEntry）
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_TOOLS, runtime, resolveMode, resolvePackagePromptPath, resolveSkillPath, parseFrontmatter,
  type ModeConfig, type SkillRef,
} from "./shared.ts";

export const STATE_TYPE = "mode-state";

// ---------- 跨扩展桥（Pi 将每个扩展文件加载为独立模块实例，module 级共享不可靠） ----------
const BRIDGE_KEY = "__piModeSwitcherBridge";

export interface ModeBridge {
  pi: ExtensionAPI | null;
  commands: Map<string, { description: string; handler: (args: string, ctx: any) => Promise<void> }>;
}

function isStale(pi: ExtensionAPI | null): boolean {
  if (!pi) return true;
  try {
    pi.getActiveTools();
    return false;
  } catch {
    return true; // /reload 或会话替换后旧 pi 失效
  }
}

export function ensureBridge(pi: ExtensionAPI): ModeBridge {
  const g = globalThis as any;
  let b: ModeBridge = g[BRIDGE_KEY];
  if (!b || isStale(b.pi)) {
    b = { pi: null, commands: new Map() };
    g[BRIDGE_KEY] = b;
  }
  if (!b.pi) b.pi = pi;
  return b;
}

export function getBridge(): ModeBridge | null {
  const b = (globalThis as any)[BRIDGE_KEY] as ModeBridge | undefined;
  return b && !isStale(b.pi) ? b : null;
}

/** 注册模式命令（跨扩展去重：同一 id 只通过桥注册一次，避免 Pi 生成 /id:1 后缀）。 */
export function registerModeCommandShared(
  pi: ExtensionAPI,
  id: string,
  description: string,
  handler: (args: string, ctx: any) => Promise<void>,
): void {
  const bridge = ensureBridge(pi);
  if (bridge.commands.has(id)) return;
  bridge.commands.set(id, { description, handler });
  bridge.pi?.registerCommand(id, { description, handler });
}

// ---------- 工具计算 ----------
function registeredToolNames(pi: ExtensionAPI): Set<string> {
  try {
    return new Set(pi.getAllTools().map((t: any) => t.name));
  } catch {
    return new Set(DEFAULT_TOOLS);
  }
}

/** 计算模式最终工具列表（过滤未注册工具，核心 4 工具固定）。 */
export function computeTools(pi: ExtensionAPI, modeId: string, config: ModeConfig | null): { tools: string[]; unknown: string[] } {
  const registered = registeredToolNames(pi);
  let wanted: string[];
  if (config?.autoLoad === "all") {
    wanted = [...registered]; // full：当前运行时所有已注册工具
  } else if (modeId === "default" || !config) {
    wanted = [...DEFAULT_TOOLS];
  } else {
    wanted = [...new Set([...DEFAULT_TOOLS, ...(config.addTools ?? [])])];
  }
  const tools = wanted.filter((t) => registered.has(t));
  const unknown = wanted.filter((t) => !registered.has(t));
  return { tools, unknown };
}

/** 模式有效资源统计（/modes 页脚使用）。 */
export function effectiveStats(
  pi: ExtensionAPI,
  id: string,
  cwd: string,
): { tools: number; skills: number | "all"; packages: number; warnings: string[] } {
  if (id === "default") {
    return { tools: DEFAULT_TOOLS.length, skills: 0, packages: 0, warnings: [] };
  }
  if (id === "full") {
    let tools = 0;
    try {
      tools = pi.getAllTools().length;
    } catch { /* ignore */ }
    return { tools, skills: "all", packages: 0, warnings: [] };
  }
  const r = resolveMode(id, cwd);
  if (!r.config) return { tools: DEFAULT_TOOLS.length, skills: 0, packages: 0, warnings: r.warnings };
  const registered = registeredToolNames(pi);
  const effectiveTools = [...new Set([...DEFAULT_TOOLS, ...(r.config.addTools ?? [])])].filter((t) => registered.has(t));
  const effectiveSkills = (r.config.addSkills ?? []).filter((s) => !!resolveSkillPath(s, cwd));
  return {
    tools: effectiveTools.length,
    skills: effectiveSkills.length,
    packages: (r.config.packages ?? []).length,
    warnings: r.warnings,
  };
}

// ---------- 模式状态（pi.appendEntry 会话级持久化） ----------
export function readStateFromBranch(ctx: any): string | null {
  try {
    const entries = ctx.sessionManager.getBranch() ?? [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e?.type === "custom" && e.customType === STATE_TYPE && e.data?.modeId) return e.data.modeId;
    }
  } catch { /* ignore */ }
  return null;
}

export function saveState(pi: ExtensionAPI, modeId: string): void {
  try {
    pi.appendEntry(STATE_TYPE, { modeId });
  } catch { /* ignore */ }
}

// ---------- 模式应用 ----------
function fullFallback(): ModeConfig {
  return { name: "全功能", autoLoad: "all", inherit: null, addTools: [], addSkills: [], packages: [], prompts: [], systemPrompt: "" };
}

/**
 * 应用模式：解析 → 计算工具 → setActiveTools → 持久化 → 页脚。
 * 返回用户可见消息；当前模式失效时自动回落默认（决策 50）。
 */
export function applyMode(pi: ExtensionAPI, ctx: ExtensionCommandContext, modeId: string): string {
  let config: ModeConfig | null = null;
  const warnings: string[] = [];

  if (modeId === "default") {
    config = null;
  } else if (modeId === "full") {
    const r = resolveMode("full", ctx.cwd);
    config = r.config ?? fullFallback();
    warnings.push(...r.warnings);
  } else {
    const r = resolveMode(modeId, ctx.cwd);
    if (!r.config) {
      // 只有当前模式失效时才回落；调用一个已经删除的旧命令不能破坏当前模式。
      const wasCurrent = runtime.currentMode === modeId;
      if (wasCurrent) {
        runtime.currentMode = "default";
        const fb = computeTools(pi, "default", null);
        pi.setActiveTools(fb.tools);
        saveState(pi, "default");
        ctx.ui.setStatus("mode", `default · 工具${fb.tools.length}`);
      }
      return `❌ 模式「${modeId}」配置无效${wasCurrent ? "，已回落默认模式" : ""}。请修复配置或执行 /reload 刷新命令列表`;
    }
    config = r.config;
    warnings.push(...r.warnings);
  }

  const { tools, unknown } = computeTools(pi, modeId, config);
  pi.setActiveTools(tools); // 全量替换（即时生效）
  runtime.currentMode = modeId;
  saveState(pi, modeId);
  ctx.ui.setStatus("mode", `${modeId} · 工具${tools.length}`);

  // 技能有效性校验（自定义模式）
  let invalidSkills = 0;
  if (config && config.autoLoad !== "all" && modeId !== "default") {
    for (const s of config.addSkills ?? []) {
      if (!resolveSkillPath(s, ctx.cwd)) invalidSkills++;
    }
  }

  const parts: string[] = [];
  if (config && config.autoLoad !== "all" && modeId !== "default") {
    parts.push(`工具${tools.length}`, `技能${(config.addSkills ?? []).length}`, `包${(config.packages ?? []).length}`);
  } else if (modeId === "full") {
    parts.push(`工具${tools.length}`, `技能全部`);
  } else {
    parts.push(`工具${tools.length}`);
  }
  const name = config?.name ?? modeId;
  let msg = `✅ 已切换到「${name}」(${parts.join(" ")})`;
  const warnLines: string[] = [];
  if (warnings.length) warnLines.push(...warnings);
  if (unknown.length) warnLines.push(`工具不可用：${unknown.join(", ")}`);
  if (invalidSkills > 0) warnLines.push(`${invalidSkills} 个技能文件不存在，已跳过`);
  if (warnLines.length) msg += `\n⚠️ ${warnLines.join("；")}`;
  return msg;
}

// ---------- 系统提示词：技能块处理 ----------
const SKILL_START_MARKER = "The following skills provide specialized instructions for specific tasks.";
const SKILL_END_MARKER = "</available_skills>";

/** 剥离系统提示词中的自动发现技能块。 */
export function stripSkillsBlock(systemPrompt: string): string {
  const start = systemPrompt.indexOf(SKILL_START_MARKER);
  if (start === -1) return systemPrompt;
  const end = systemPrompt.indexOf(SKILL_END_MARKER, start);
  if (end === -1) return systemPrompt;
  return systemPrompt.slice(0, start) + systemPrompt.slice(end + SKILL_END_MARKER.length);
}

function escapeXml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** 为模式指定的技能构建 <available_skills> 块（渐进式：只含名称/描述/位置）。 */
export function buildSkillsBlock(refs: SkillRef[], cwd: string): string {
  const entries: string[] = [];
  for (const ref of refs) {
    const file = resolveSkillPath(ref, cwd);
    if (!file) continue;
    const fm = parseFrontmatter(file) ?? {};
    const name = fm.name ?? ref.name;
    const description = fm.description ?? "";
    entries.push(
      [
        "  <skill>",
        `    <name>${escapeXml(name)}</name>`,
        `    <description>${escapeXml(description)}</description>`,
        `    <location>${escapeXml(file)}</location>`,
        "  </skill>",
      ].join("\n"),
    );
  }
  if (entries.length === 0) return "";
  return [
    "",
    "",
    SKILL_START_MARKER,
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
    ...entries,
    "</available_skills>",
  ].join("\n");
}

/** 用新模式技能块替换原自动发现技能块；newBlock 为空时整体剥离。 */
export function replaceSkillsBlock(systemPrompt: string, newBlock: string): string {
  const stripped = stripSkillsBlock(systemPrompt);
  if (!newBlock) return stripped;
  return stripped + newBlock;
}

// ---------- 提示模板贡献 ----------
export function collectPromptPaths(config: ModeConfig, cwd: string): string[] {
  const paths: string[] = [];
  for (const p of config.prompts ?? []) {
    if (!p.package) continue;
    const path = resolvePackagePromptPath(p, cwd);
    if (path) paths.push(path);
  }
  return paths;
}
