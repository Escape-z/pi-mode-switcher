// pi-mode-switcher · 模式切换核心
// 命令：/full /default + 动态注册用户模式命令
// 功能：工具门控、技能块过滤、模式提示词注入、会话级状态持久化、页脚显示
import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RESERVED, runtime, loadMode, resolveMode, scanModeFiles } from "../lib/shared.ts";
import {
  applyMode, buildSkillsBlock, collectPromptPaths, computeTools, ensureBridge,
  readStateFromBranch, registerModeCommandShared, replaceSkillsBlock, saveState,
  stripSkillsBlock, type ModeBridge,
} from "../lib/mode-runtime.ts";

const STATE_TYPE = "mode-state";

export default function (pi: ExtensionAPI) {
  const bridge: ModeBridge = ensureBridge(pi);

  // 从会话文件（JSONL）读取最后一个 mode-state entry（fork 恢复用）
  function lastStateFromFile(file: string): string | null {
    try {
      let found: string | null = null;
      for (const line of readFileSync(file, "utf-8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (e?.type === "custom" && e.customType === STATE_TYPE && e.data?.modeId) found = e.data.modeId;
        } catch { /* 跳过坏行 */ }
      }
      return found;
    } catch {
      return null;
    }
  }

  function registerDynamicCommands(cwd: string) {
    const { modes } = scanModeFiles(cwd);
    for (const m of modes) {
      if (RESERVED.includes(m.id)) continue; // 保留名跳过（full 有内置命令）
      // 坏配置跳过注册（决策 18），诊断在 /modes 中显示
      const r = loadMode(m.id, cwd);
      if (r.broken || !r.config) continue;
      registerModeCommandShared(pi, m.id, `切换到模式 ${m.id}`, async (_args, ctx) => {
        const msg = applyMode(pi, ctx, m.id);
        ctx.ui.notify(msg, msg.startsWith("❌") ? "error" : "info");
      });
    }
  }

  // ---------- 内置命令 ----------
  pi.registerCommand("full", {
    description: "切换到全功能模式（当前运行时全部已注册工具与技能）",
    handler: async (_args, ctx) => {
      const msg = applyMode(pi, ctx, "full");
      ctx.ui.notify(msg, msg.startsWith("❌") ? "error" : "info");
    },
  });

  pi.registerCommand("default", {
    description: "回到默认最小模式（4 个核心工具）",
    handler: async (_args, ctx) => {
      const msg = applyMode(pi, ctx, "default");
      ctx.ui.notify(msg, msg.startsWith("❌") ? "error" : "info");
    },
  });

  // ---------- 事件 ----------
  // 会话启动：注册动态命令 + 按会话类型恢复模式
  //   new → 默认最小模式
  //   fork → 继承原会话模式（读原会话文件最后的 mode-state）
  //   resume/reload/startup → 从当前会话分支恢复
  pi.on("session_start", async (event, ctx) => {
    runtime.projectTrusted = typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : true;
    registerDynamicCommands(ctx.cwd);

    let restore: string | null = null;
    if (event.reason === "new") {
      restore = null;
    } else if (event.reason === "fork" && event.previousSessionFile) {
      restore = lastStateFromFile(event.previousSessionFile) ?? readStateFromBranch(ctx);
    } else {
      restore = readStateFromBranch(ctx);
    }

    const id = restore ?? "default";
    if (id === "default") {
      // 静默进入默认模式（不打扰新会话）
      const { tools } = computeTools(pi, "default", null);
      pi.setActiveTools(tools);
      runtime.currentMode = "default";
      saveState(pi, "default");
      ctx.ui.setStatus("mode", `default · 工具${tools.length}`);
      return;
    }

    const msg = applyMode(pi, ctx, id);
    if (msg.startsWith("❌")) {
      ctx.ui.notify(msg, "warning");
    } else {
      ctx.ui.notify(`↩️ 已恢复上次模式 ${msg.replace("✅ 已切换到", "")}`, "info");
    }
  });

  // 提示模板贡献：当前模式挂载的 prompts（结构化引用）→ resources_discover 注入。
  // 注意：模板发现只在启动 /reload 时发生，切换模式后需 /reload 生效（决策 23）。
  pi.on("resources_discover", async (event, ctx) => {
    runtime.projectTrusted = typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : runtime.projectTrusted;
    const id = runtime.currentMode;
    if (!id || id === "default") return;
    const r = resolveMode(id, event.cwd);
    if (!r.config) return;
    const promptPaths = collectPromptPaths(r.config, event.cwd);
    if (promptPaths.length === 0) return;
    return { promptPaths };
  });

  // 注入模式提示词 + 技能过滤（每次请求前）
  pi.on("before_agent_start", async (event, ctx) => {
    runtime.projectTrusted = typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : runtime.projectTrusted;
    const id = runtime.currentMode ?? "default";

    // 默认最小模式：剥离自动发现技能块，保持最小 token
    if (id === "default") {
      const stripped = stripSkillsBlock(event.systemPrompt);
      return stripped === event.systemPrompt ? undefined : { systemPrompt: stripped };
    }

    const r = resolveMode(id, ctx.cwd);
    const config = r.config ?? (id === "full" ? { name: "全功能", autoLoad: "all" as const } : null);
    if (!config) {
      // 配置被外部删除/损坏时，当前运行状态也必须回落，不能继续使用旧工具集合。
      const wasCurrent = runtime.currentMode === id;
      const msg = applyMode(pi, ctx as any, id);
      if (wasCurrent) ctx.ui.notify(msg, "warning");
      const stripped = stripSkillsBlock(event.systemPrompt);
      return stripped === event.systemPrompt ? undefined : { systemPrompt: stripped };
    }

    // full 模式：保留全部自动发现技能；systemPrompt 非空时追加（决策 4）
    if (config.autoLoad === "all") {
      const sp = config.systemPrompt?.trim();
      if (!sp) return;
      return { systemPrompt: event.systemPrompt + "\n\n" + sp };
    }

    // 自定义模式：技能块替换为模式指定的技能（渐进式，只含描述）；追加模式提示词
    let base = replaceSkillsBlock(event.systemPrompt, buildSkillsBlock(config.addSkills ?? [], ctx.cwd));
    const sp = config.systemPrompt?.trim();
    if (sp) base = base + "\n\n" + sp;
    return base === event.systemPrompt ? undefined : { systemPrompt: base };
  });

  // 清理页脚状态
  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus("mode", undefined);
  });
}
