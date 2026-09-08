// pi-mode-switcher · 模式运行时
// 职责：虚拟 default/full 模式、有效模式解析、工具合并与过滤、
//       模式应用（即时生效）、技能块重建、模式状态持久化（pi.appendEntry）
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_TOOLS, bumpRuntimeRev, runtime, resolveMode, resolvePackagePromptPath, resolveSkillPath, parseFrontmatter,
  listInstalledPackages,
  type ModeConfig, type SkillRef,
} from "./shared.ts";

export const STATE_TYPE = "mode-state";

// ---------- 工具计算 ----------
function registeredToolNames(pi: ExtensionAPI): Set<string> {
  try {
    return new Set(pi.getAllTools().map((t: any) => t.name));
  } catch {
    return new Set(DEFAULT_TOOLS);
  }
}

/** 计算模式最终工具列表（过滤未注册工具，8 个内置工具固定）。 */
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

/** 模式有效资源统计（/mode show 页脚使用）。 */
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
    // full 语义是 autoLoad:"all"（隐式包含运行时全部包），不走 packages[] 列表；
    // 显示已安装包数，避免树上出现容易误解的 包0。
    let packages = 0;
    try {
      packages = listInstalledPackages(cwd).length;
    } catch { /* ignore */ }
    return { tools, skills: "all", packages, warnings: [] };
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
      // 只有当前模式失效时才回落；切换到不存在的模式不能破坏当前模式。
      const wasCurrent = runtime.currentMode === modeId;
      if (wasCurrent) {
        runtime.currentMode = "default";
        bumpRuntimeRev(); // /mode show 高亮等面板需要重绘
        const fb = computeTools(pi, "default", null);
        pi.setActiveTools(fb.tools);
        saveState(pi, "default");
        ctx.ui.setStatus("mode", `default · 工具${fb.tools.length}`);
      }
      return `❌ 模式「${modeId}」配置无效${wasCurrent ? "，已回落默认模式" : ""}。请修复配置或 /mode use 切换其他模式`;
    }
    config = r.config;
    warnings.push(...r.warnings);
  }

  const { tools, unknown } = computeTools(pi, modeId, config);
  pi.setActiveTools(tools); // 全量替换（即时生效）
  runtime.currentMode = modeId;
  bumpRuntimeRev(); // /modes 高亮实时移动
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
    let fullPackages = 0;
    try {
      fullPackages = listInstalledPackages(ctx.cwd).length;
    } catch { /* ignore */ }
    parts.push(`工具${tools.length}`, `技能全部`, `包${fullPackages}`);
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
