// pi-mode-switcher · 模式管理
// 命令：/mode（show/clear/use/add/edit/del/init/cleanup）与 /link（add/del/show/clear）
// 全部管理命令仅支持交互式 TUI/RPC 模式（ctx.hasUI 守卫）
import { join, dirname } from "node:path";
import { existsSync, copyFileSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  globalModesDir, globalSettingsFile, projectModesDir, DEFAULT_TOOLS, MODE_ID_RE,
  runtime, bumpRuntimeRev, scanModeFiles, scanModes, scanNestedModeFiles, scanSkillRefs, loadMode, loadModeConfig, saveModeConfig,
  modeLocation, listInstalledPackages, findPackageDir, inspectPackage, isPackageResourceAllowed, getOrphanPackages, checkInheritDirection,
  readJson, writeJson, type ModeConfig, type SkillRef, type PromptRef, type ManagedResources, type ManagedPackageResources,
} from "../lib/shared.ts";
import {
  applyMode, effectiveStats,
} from "../lib/mode-runtime.ts";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");

export default function (pi: ExtensionAPI) {
  const CANCEL = "__mode-switcher-cancel__";
  const CANCEL_LABEL = "❌ 取消";
  type SelectItem = string | { value: string; label: string };

  const skillRefKey = (r: SkillRef) => JSON.stringify(r);
  const promptRefKey = (r: PromptRef) => JSON.stringify(r);

  function syncProjectTrust(ctx: any): void {
    runtime.projectTrusted = typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : true;
    if (typeof ctx?.cwd === "string" && ctx.cwd) runtime.cwd = ctx.cwd;
  }

  function hasUI(ctx: ExtensionCommandContext): boolean {
    if (ctx.hasUI === false) {
      ctx.ui.notify("该命令需要在交互式 TUI/RPC 模式中使用", "error");
      return false;
    }
    return true;
  }

  function getSessionId(ctx: any): string {
    try {
      return ctx.sessionManager.getSessionId() ?? "default";
    } catch {
      return "default";
    }
  }

  // ---------- 多选组件 ----------
  async function loopMultiSelect(
    ctx: ExtensionCommandContext, title: string, items: SelectItem[], current: string[] = [],
  ): Promise<string[] | null> {
    const selected = [...current];
    const DONE = "✅ 完成选择";
    for (;;) {
      const remaining = items.filter((i) => !selected.includes(typeof i === "string" ? i : i.value));
      const hint = selected.length > 0 ? `（已选: ${selected.join(", ")}）` : "";
      const choice = await ctx.ui.select(`${title}${hint}`, [...remaining, DONE, CANCEL_LABEL]);
      if (choice === CANCEL_LABEL) return null;
      if (!choice || choice === DONE) break;
      selected.push(choice);
    }
    return selected;
  }

  // TUI 多选组件不可用时的回退提示（每个进程只提示一次，避免刷屏）。
  let multiFallbackWarned = false;
  function warnMultiFallback(ctx: ExtensionCommandContext, count: number) {
    if (multiFallbackWarned || count <= 5) return;
    multiFallbackWarned = true;
    try {
      ctx.ui.notify("滚动多选组件不可用，已回退逐项选择：在插件目录执行 npm install 可恢复", "warning");
    } catch { /* 通知失败不影响选择流程 */ }
  }

  async function settingsMultiSelect(
    ctx: ExtensionCommandContext, title: string, items: SelectItem[], current: string[] = [],
  ): Promise<string[] | null> {
    const norm: { value: string; label: string }[] = items.map((i) =>
      typeof i === "string" ? { value: i, label: i } : i,
    );
    const byValue = new Map(norm.map((i) => [i.value, i.label]));
    for (const c of current) if (!byValue.has(c)) byValue.set(c, `${c} (未安装/未注册)`);
    const entries = [...byValue.entries()].map(([value, label]) => ({ value, label }));
    if (entries.length === 0) return current.length > 0 ? [...current] : [];

    // RPC 模式不支持 ctx.ui.custom()/真实 TUI 组件；使用官方支持的 select 对话框模拟多选。
    if (ctx.mode !== "tui") {
      const labels = entries.map((e) => e.label);
      const currentLabels = current.map((value) => byValue.get(value) ?? value);
      const r = await loopMultiSelect(ctx, title, labels, currentLabels);
      return r === null ? null : r.map((label) => entries.find((e) => e.label === label)?.value ?? label);
    }

    let tuiMod: any, caMod: any;
    try {
      tuiMod = await import("@earendil-works/pi-tui");
      caMod = await import("@earendil-works/pi-coding-agent");
      if (!tuiMod.SettingsList || !caMod.getSettingsListTheme) throw new Error("ui unavailable");
    } catch (e) {
      // 本地路径安装时 Pi 不会自动安装 peer 依赖，@earendil-works/pi-tui 缺失会走到这里。
      warnMultiFallback(ctx, entries.length);
      const labels = entries.map((e) => e.label);
      const currentLabels = current.map((value) => byValue.get(value) ?? value);
      const r = await loopMultiSelect(ctx, title, labels, currentLabels);
      // 回退路径返回 label → 映射回 value（结构化引用的 value 是 JSON）
      return r === null ? null : r.map((label) => entries.find((e) => e.label === label)?.value ?? label);
    }

    const { Container, SettingsList, Text } = tuiMod;
    const { getSettingsListTheme } = caMod;
    const selected = new Set(current);
    const displayTitle = `${title}  [空格=开/关 回车=下一步 Esc=取消]`;

    // SettingsList 自身没有“完成”概念（回车/空格都是切换值），回车=下一步由外层拦截实现。
    const isConfirmKey = (kb: any, data: any): boolean => {
      try {
        if (kb && typeof kb.matches === "function" && kb.matches(data, "tui.select.confirm")) return true;
      } catch { /* 忽略 keybinding 匹配失败，走原始按键判断 */ }
      return data === "\r" || data === "\n";
    };

    const result = await ctx.ui.custom((_tui: any, theme: any, kb: any, done: any) => {
      const container = new Container();
      container.addChild(new Text(theme.fg("accent", theme.bold(displayTitle)), 1, 1));
      const settingItems = entries.map((it) => ({
        id: it.value,
        label: it.label,
        currentValue: selected.has(it.value) ? "on" : "off",
        values: ["on", "off"],
      }));
      const list = new SettingsList(
        settingItems,
        Math.min(settingItems.length + 2, 15),
        getSettingsListTheme(),
        (id: string, newValue: string) => {
          if (newValue === "on") selected.add(id);
          else selected.delete(id);
        },
        () => done(CANCEL),
        { enableSearch: true },
      );
      container.addChild(list);
      return {
        render: (w: number) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data: any) => {
          if (isConfirmKey(kb, data)) {
            done([...selected]);
            return;
          }
          list.handleInput?.(data);
        },
      };
    });

    if (result === CANCEL) return null;
    return [...selected];
  }

  // ---------- 工具/包辅助 ----------
  function commandExists(pi: ExtensionAPI, id: string): boolean {
    try {
      return pi.getCommands().some((c: any) => c.name === id || c.name === `${id}:1`);
    } catch {
      return false;
    }
  }

  function packageIdentity(source: string): string {
    if (source.startsWith("npm:")) {
      const name = source.slice(4).match(/^(@[^/]+\/[^@]+|[^@/]+)(?:@.*)?$/)?.[1];
      return name ? `npm:${name}` : source;
    }
    if (source.startsWith("git:")) return source.replace(/@[^/]+$/, "");
    return source;
  }

  function sourceMatches(siSource: string, pkg: { source: string; name: string }): boolean {
    const s = siSource.replaceAll("\\", "/").trim();
    if (s === pkg.source || s === pkg.name) return true;
    if (s.endsWith(pkg.source) || s.endsWith(pkg.name)) {
      const prev = s[s.length - Math.min(s.length, Math.max(pkg.source.length, pkg.name.length)) - 1];
      if (prev === undefined || ":/".includes(prev)) return true;
    }
    return false;
  }

  /** 指定包注册的工具（按 sourceInfo 匹配，只统计 Pi 当前已注册的）。 */
  function packageToolNames(pi: ExtensionAPI, pkg: { source: string; name: string }, cwd: string): string[] {
    const out: string[] = [];
    for (const t of pi.getAllTools() as any[]) {
      const si = t.sourceInfo;
      if (!si || si.origin !== "package") continue;
      if (!sourceMatches(String(si.source ?? ""), pkg)) continue;
      // 遵循 Pi settings 中对该包 extensions 的过滤；旧版本 sourceInfo 没有 path 时保持兼容。
      if (si.path && !isPackageResourceAllowed(pkg.source, cwd, "extensions", String(si.path), t.name)) continue;
      out.push(t.name);
    }
    return out;
  }

  function toolOptions(pi: ExtensionAPI): { value: string; label: string }[] {
    return (pi.getAllTools() as any[])
      .filter((t) => !DEFAULT_TOOLS.includes(t.name))
      .map((t) => {
        const si = t.sourceInfo;
        const src = si?.origin === "package" && si?.source ? ` — ${si.source}` : "";
        return { value: t.name, label: `${t.name}${src}` };
      });
  }

  function packagePromptRefs(pkgs: { source: string }[], cwd: string): PromptRef[] {
    const out: PromptRef[] = [];
    for (const p of pkgs) {
      for (const n of inspectPackage(p.source, cwd).prompts) out.push({ package: p.source, name: n });
    }
    return out;
  }

  /**
   * 统一维护包资源 owner。mode add/mode edit/link add 必须使用同一套规则，
   * 否则 unlink 无法判断哪些资源可以安全清理。
   */
  function reconcileManagedResources(
    config: ModeConfig,
    packages: string[],
    chosenPkgs: { source: string }[],
    pi: ExtensionAPI,
    cwd: string,
    previous?: ModeConfig,
  ): void {
    const managed: ManagedResources = JSON.parse(JSON.stringify(config.managedResources ?? {}));
    const packageSet = new Set(packages);
    const toolSet = new Set(config.addTools ?? []);
    const skillKeys = new Set((config.addSkills ?? []).map(skillRefKey));
    const promptKeys = new Set((config.prompts ?? []).map(promptRefKey));

    const hasPreviousOwner = (kind: "tools" | "skills" | "prompts", key: string): boolean => {
      for (const [source, res] of Object.entries(previous?.managedResources ?? {})) {
        if (source === "__manual__") continue;
        const list = kind === "tools" ? res.tools ?? [] : kind === "skills" ? (res.skills ?? []).map(skillRefKey) : (res.prompts ?? []).map(promptRefKey);
        if (list.includes(key)) return true;
      }
      return false;
    };
    const wasPresent = (kind: "tools" | "skills" | "prompts", key: string): boolean => {
      if (!previous) return false;
      return kind === "tools" ? (previous.addTools ?? []).includes(key)
        : kind === "skills" ? (previous.addSkills ?? []).some((x) => skillRefKey(x) === key)
        : (previous.prompts ?? []).some((x) => promptRefKey(x) === key);
    };
    const add = (source: string, kind: "tools" | "skills" | "prompts", value: string | SkillRef | PromptRef) => {
      const own = (managed[source] ??= {});
      const list: any[] = kind === "tools" ? (own.tools ??= []) : kind === "skills" ? (own.skills ??= []) : (own.prompts ??= []);
      const key = kind === "tools" ? String(value) : JSON.stringify(value);
      if (!list.some((x) => (kind === "tools" ? String(x) : JSON.stringify(x)) === key)) list.push(value);
      // 旧配置中没有来源记录的资源按手动资源保留。
      if (previous && wasPresent(kind, key) && !hasPreviousOwner(kind, key)) {
        const manual = (managed.__manual__ ??= {});
        const ml: any[] = kind === "tools" ? (manual.tools ??= []) : kind === "skills" ? (manual.skills ??= []) : (manual.prompts ??= []);
        if (!ml.some((x) => (kind === "tools" ? String(x) : JSON.stringify(x)) === key)) ml.push(value);
      }
    };

    // 删除已经取消挂载的包 owner，并裁剪仍存在的资源。
    for (const [source, res] of Object.entries(managed)) {
      if (source !== "__manual__" && !packageSet.has(source)) {
        delete managed[source];
        continue;
      }
      res.tools = (res.tools ?? []).filter((x) => toolSet.has(x));
      res.skills = (res.skills ?? []).filter((x) => skillKeys.has(skillRefKey(x)));
      res.prompts = (res.prompts ?? []).filter((x) => promptKeys.has(promptRefKey(x)));
    }

    for (const pkg of chosenPkgs) {
      for (const t of packageToolNames(pi, pkg, cwd)) if (toolSet.has(t)) add(pkg.source, "tools", t);
      for (const s of inspectPackage(pkg.source, cwd).skills) {
        const ref: SkillRef = { scope: "package", package: pkg.source, name: s };
        if (skillKeys.has(skillRefKey(ref))) add(pkg.source, "skills", ref);
      }
      for (const p of inspectPackage(pkg.source, cwd).prompts) {
        const ref: PromptRef = { package: pkg.source, name: p };
        if (promptKeys.has(promptRefKey(ref))) add(pkg.source, "prompts", ref);
      }
    }

    for (const [source, res] of Object.entries(managed)) {
      if (!(res.tools?.length ?? 0) && !(res.skills?.length ?? 0) && !(res.prompts?.length ?? 0)) delete managed[source];
    }
    if (Object.keys(managed).length) config.managedResources = managed;
    else delete config.managedResources;
  }

  // ---------- 继承校验 ----------
  function createsCycle(id: string, parentId: string, cwd: string): boolean {
    let cur: string | null | undefined = parentId;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      if (cur === id) return true;
      seen.add(cur);
      cur = loadModeConfig(cur, cwd)?.inherit ?? null;
    }
    return false;
  }

  /** 立即刷新当前模式（link add/link del/mode edit 后调用）。 */
  function refreshIfCurrent(pi: ExtensionAPI, ctx: ExtensionCommandContext, modeId: string) {
    if (runtime.currentMode === modeId) {
      const msg = applyMode(pi, ctx, modeId);
      if (!msg.startsWith("❌")) ctx.ui.notify(`🔄 已即时生效：${msg.split("\n")[0]}`, "info");
    }
  }

  // ---------- 实时面板：脏检测 + 活体组件 ----------
  // pi 的 setWidget 工厂只调用一次生成组件，之后每帧只重绘组件本身；
  // 因此把数据采集放进组件 render()，配合 rev/文件指纹脏检测实现面板实时更新。
  function dirFingerprint(dir: string): string {
    try {
      return readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => {
          try { return `${f}:${statSync(join(dir, f)).mtimeMs}`; } catch { return `${f}:x`; }
        })
        .join(",");
    } catch { return "-"; }
  }

  function panelSignature(cwd: string): string {
    let settingsMtime = "-";
    try { settingsMtime = String(statSync(globalSettingsFile).mtimeMs); } catch { /* 不存在 */ }
    return [
      String(runtime.rev),
      dirFingerprint(globalModesDir),
      runtime.projectTrusted ? dirFingerprint(projectModesDir(cwd)) : "",
      settingsMtime,
    ].join("|");
  }

  /**
   * 折叠上限：优先用终端真实高度自适应（完全展示），拿不到时退回 pi 官方的 10 行。
   * 预留 12 行给编辑器、页脚/状态区和对话区；终端 resize 会触发 requestRender，
   * render() 重新读 rows 自动跟随。
   */
  const WIDGET_FALLBACK_LINES = 10;
  const WIDGET_RESERVE_ROWS = 12;
  const WIDGET_MIN_LINES = 4;
  function widgetMaxLines(tui: any): number {
    try {
      const rows = tui?.terminal?.rows;
      if (typeof rows === "number" && rows > 0) return Math.max(WIDGET_MIN_LINES, rows - WIDGET_RESERVE_ROWS);
    } catch { /* ignore */ }
    return WIDGET_FALLBACK_LINES;
  }
  function clampWidgetLines(lines: string[], maxLines: number): string[] {
    if (lines.length <= maxLines) return lines;
    if (maxLines < 4) return lines.slice(0, maxLines);
    const visible = maxLines - 2;
    const hidden = lines.length - visible - 1;
    return [
      ...lines.slice(0, visible),
      `  …（还有 ${hidden} 行未显示，终端高度不足）`,
      lines[lines.length - 1],
    ];
  }

  /**
   * 活体组件：render 时按脏检测重新采集数据。
   * - rev（进程内变更）变化 → 立即重建
   * - 外部变更（pi install/remove、手改 JSON）→ 文件指纹发现
   * 指纹仅需几次 readdir/stat，每次渲染检查代价可忽略。
   */
  function liveWidget(tui: any, cwd: string, build: () => string[]) {
    let lastSig = "";
    let lines: string[] = [];
    return {
      render(_width: number): string[] {
        const sig = panelSignature(cwd);
        if (sig !== lastSig) {
          try { lines = clampWidgetLines(build(), widgetMaxLines(tui)); lastSig = sig; } catch { /* 采集失败沿用旧内容 */ }
        }
        return lines;
      },
      invalidate() {},
    };
  }

  // ---------- /mode init：生成内置模板 ----------
  async function cmdInit(_args: string, ctx: ExtensionCommandContext) {
    if (!hasUI(ctx)) return;
    syncProjectTrust(ctx);
    const target = join(globalModesDir, "full.json");
    const template = join(pkgRoot, "templates", "modes", "full.json");
    if (!existsSync(target)) {
      try {
        copyFileSync(template, target);
        bumpRuntimeRev();
        ctx.ui.notify("✅ 已生成 modes/full.json（/mode use full 即刻可用）", "info");
        } catch {
          ctx.ui.notify("❌ 模板复制失败", "error");
        }
        return;
      }
      const r = loadMode("full", ctx.cwd);
      if (r.broken) {
        const ok = await ctx.ui.confirm("full.json 已损坏", "是否备份为 full.json.bak 并重新生成默认模板?");
        if (!ok) return;
        try {
          copyFileSync(target, `${target}.bak`);
          rmSync(target);
          copyFileSync(template, target);
          bumpRuntimeRev();
          ctx.ui.notify("✅ 已备份并重新生成 modes/full.json", "info");
        } catch {
          ctx.ui.notify("❌ 修复失败", "error");
        }
        return;
      }
      const ok = await ctx.ui.confirm("full.json 已存在", "是否覆盖为默认模板?");
      if (!ok) {
        ctx.ui.notify("已保留现有 full.json", "info");
        return;
      }
      try {
        copyFileSync(template, target);
        bumpRuntimeRev();
        ctx.ui.notify("✅ 已覆盖 modes/full.json", "info");
      } catch {
        ctx.ui.notify("❌ 模板复制失败", "error");
      }
  }

  // ---------- /mode add：创建模式 ----------
  async function cmdAddMode(_args: string, ctx: ExtensionCommandContext) {
    if (!hasUI(ctx)) return;
      syncProjectTrust(ctx);
      // ① 命令标识
      const id = await ctx.ui.input("命令标识 (小写字母/数字/连字符):", "");
      if (!id) return;
      if (!MODE_ID_RE.test(id)) {
        ctx.ui.notify("❌ 标识只允许小写字母/数字，单个连字符分段", "error");
        return;
      }
      if (id === "default") {
        ctx.ui.notify("❌ default 是虚拟内置模式，请换一个标识", "error");
        return;
      }
      if (id === "full") {
        ctx.ui.notify("❌ full 是内置模式，请用 /mode edit full 修改", "error");
        return;
      }
      if (commandExists(pi, id)) {
        ctx.ui.notify(`❌ ${id} 与已有命令重名，请换一个标识`, "error");
        return;
      }

      // ② 显示名
      const name = await ctx.ui.input("显示名称:", id);
      if (!name) return;

      // ③ 创建位置
      const loc = await ctx.ui.select("创建位置:", ["全局（所有项目可用）", "当前项目（仅此目录）"]);
      if (!loc) return;
      const location = loc.startsWith("全局") ? "global" : "project";

      // ③b 同名校验（决策 15：全局拒绝任意同名；项目级仅项目内同名拒绝）
      const globalPath = join(globalModesDir, `${id}.json`);
      const projectPath = join(projectModesDir(ctx.cwd), `${id}.json`);
      if (location === "global" && (existsSync(globalPath) || existsSync(projectPath))) {
        ctx.ui.notify(`❌ ${id} 已存在，请换名或用 /mode edit`, "error");
        return;
      }
      if (location === "project" && existsSync(projectPath)) {
        ctx.ui.notify(`❌ 项目级 ${id} 已存在，请换名或用 /mode edit`, "error");
        return;
      }

      // ④ 父模式（继承，含虚拟 default）
      const modeIds = scanModes(ctx.cwd).filter((m) => m !== "full" && m !== id);
      const parent = await ctx.ui.select("父模式 (继承):", ["无（独立模式）", "default（虚拟根模式）", ...modeIds]);
      if (!parent) return;
      const parentId = parent.startsWith("无") ? null : parent.startsWith("default") ? "default" : parent;
      if (parentId && parentId !== "default") {
        const err = checkInheritDirection(location, parentId, ctx.cwd);
        if (err) {
          ctx.ui.notify(`❌ ${err}`, "error");
          return;
        }
        if (createsCycle(id, parentId, ctx.cwd)) {
          ctx.ui.notify(`❌ 循环继承：「${parentId}」的祖先链已包含 ${id}`, "error");
          return;
        }
      }

      // ⑤ 父提示词处理方式（决策 35）
      let promptMode: "append" | "override" = "override";
      if (parentId) {
        const pm = await ctx.ui.select("父模式提示词:", ["追加父模式提示词", "覆盖父模式提示词"]);
        if (!pm) return;
        promptMode = pm.startsWith("追加") ? "append" : "override";
      }

      // ⑥ 挂载包
      const pkgList = listInstalledPackages(ctx.cwd);
      const pkgLabels = pkgList.map((p) => ({
        value: p.source,
        label: `${p.source}${p.scope === "project" ? "（项目）" : "（全局）"}`,
      }));
      const packages = pkgLabels.length > 0
        ? await settingsMultiSelect(ctx, "挂载包（默认全关=跳过）", pkgLabels)
        : [];
      if (packages === null) return ctx.ui.notify("已取消", "info");
      const chosenPkgs = pkgList.filter((p) => packages.includes(p.source));
      if (chosenPkgs.length > 0) ctx.ui.notify("📦 包内工具/技能/提示已自动带出，请在后续步骤勾选", "info");

      // ⑦ 工具（核心 4 个固定，不在列表中；包内工具自动预勾）
      const autoTools = [...new Set(chosenPkgs.flatMap((p) => packageToolNames(pi, p, ctx.cwd)))];
      const tools = await settingsMultiSelect(ctx, "工具（核心 4 工具固定；包内工具已自动勾选）", toolOptions(pi), autoTools);
      if (tools === null) return ctx.ui.notify("已取消", "info");

      // ⑧ 技能（结构化引用；包内技能自动预勾）
      const skillItems: SelectItem[] = scanSkillRefs(ctx.cwd).map((ref) => ({
        value: skillRefKey(ref),
        label: `${ref.name}（${ref.scope === "project" ? "项目" : "全局"}）`,
      }));
      const pkgSkillRefs: SkillRef[] = [];
      for (const p of chosenPkgs) {
        for (const s of inspectPackage(p.source, ctx.cwd).skills) {
          const ref: SkillRef = { scope: "package", package: p.source, name: s };
          pkgSkillRefs.push(ref);
          if (!skillItems.some((i) => (typeof i === "string" ? i : i.value) === skillRefKey(ref))) {
            skillItems.push({ value: skillRefKey(ref), label: `${s} — ${p.source}` });
          }
        }
      }
      const skills = await settingsMultiSelect(ctx, "技能（包内技能已自动勾选；渐进式加载）", skillItems, pkgSkillRefs.map(skillRefKey));
      if (skills === null) return ctx.ui.notify("已取消", "info");

      // ⑨ 提示模板（包内提示自动预勾；/reload 后生效）
      const promptRefs = packagePromptRefs(chosenPkgs, ctx.cwd);
      const promptItems: SelectItem[] = promptRefs.map((r) => ({
        value: promptRefKey(r),
        label: `${r.package}/${r.name}`,
      }));
      const prompts = promptItems.length > 0
        ? await settingsMultiSelect(ctx, "提示模板（/reload 后生效）", promptItems, promptItems.map((i) => (typeof i === "string" ? i : i.value)))
        : [];
      if (prompts === null) return ctx.ui.notify("已取消", "info");

      // ⑩ 系统提示词
      const prompt = await ctx.ui.editor("系统提示词:", `你是${name}模式...`);
      if (prompt === undefined) return;

      // 空模式警告
      if (!parentId && tools.length === 0 && skills.length === 0 && packages.length === 0 && prompts.length === 0) {
        const ok = await ctx.ui.confirm("空模式警告", "该模式未配置任何资源，确认创建?");
        if (!ok) return;
      }

      const config: ModeConfig = {
        name,
        inherit: parentId,
        promptMode: parentId ? promptMode : undefined,
        addTools: tools,
        addSkills: skills.map((v) => JSON.parse(v) as SkillRef),
        packages,
        prompts: prompts.map((v) => JSON.parse(v) as PromptRef),
        systemPrompt: prompt,
      };
      reconcileManagedResources(config, packages, chosenPkgs, pi, ctx.cwd);
      const dir = location === "global" ? globalModesDir : projectModesDir(ctx.cwd);
      if (!writeJson(join(dir, `${id}.json`), config)) return ctx.ui.notify("❌ 写入失败", "error");
      bumpRuntimeRev(); // /mode show、/link show 面板实时出现新模式

      ctx.ui.notify(`✅ 模式「${name}」已创建，/mode use ${id} 即可切换${prompts.length > 0 ? "；提示模板需 /reload 生效" : ""}`, "info");
  }

  // ---------- /modes：数据采集 + 渲染（命令与活体面板共用） ----------
  interface ModesData {
    modeIds: string[];
    diagnostics: string[];
    configs: Map<string, ModeConfig | null>;
    warningsByMode: Map<string, string[]>;
    childrenOf: Map<string, string[]>;
    roots: string[];
    current: string | null;
    stats: Map<string, ReturnType<typeof effectiveStats>>;
  }

  /** 每次调用都重新扫描磁盘/运行时，保证拿到最新数据（活体面板每帧调用）。 */
  function collectModesData(pi: ExtensionAPI, cwd: string, readCurrent: () => string | null): ModesData {
    const { modes: files, diagnostics, nested } = scanModeFiles(cwd);
    const modeIds = [...new Set(["default", "full", ...files.map((f) => f.id)])];
    const configs = new Map<string, ModeConfig | null>();
    const warningsByMode = new Map<string, string[]>();
    for (const id of modeIds) {
      if (id === "default") configs.set(id, null);
      else if (id === "full") configs.set(id, loadMode("full", cwd).config ?? null);
      else {
        const r = loadMode(id, cwd);
        configs.set(id, r.config);
        if (r.broken) diagnostics.push(`modes/${id}.json：JSON 解析失败，已跳过`);
        else warningsByMode.set(id, r.warnings);
      }
    }
    const orphanModes = Object.entries(getOrphanPackages(files.map((f) => f.id), cwd));
    if (orphanModes.length > 0) {
      for (const [id, pkgs] of orphanModes) diagnostics.push(`/${id} 引用了已卸载的包：${pkgs.join(", ")}（运行 /mode cleanup 清理，/reload 清除残留代码）`);
    }
    if (nested.length > 0) for (const n of nested) diagnostics.push(`嵌套文件无效（不会被注册）：${n} → 请移到 modes/ 顶层`);

    // 继承树（递归；default 为虚拟根）
    const childrenOf = new Map<string, string[]>();
    const roots: string[] = [];
    const validParent = (pid: string | null | undefined): boolean =>
      typeof pid === "string" && (pid === "default" || (modeIds.includes(pid) && pid !== "full"));
    for (const id of modeIds) {
      if (id === "default" || id === "full") continue;
      const inh = configs.get(id)?.inherit;
      if (validParent(inh)) {
        const list = childrenOf.get(inh as string) ?? [];
        list.push(id);
        childrenOf.set(inh as string, list);
      } else {
        roots.push(id);
      }
    }
    // 循环继承的成员不挂在任何树上 → 追加到 roots 保证可见
    const placed = new Set<string>(["default", "full", ...roots]);
    const markTree = (id: string) => {
      if (placed.has(id)) return;
      placed.add(id);
      for (const k of childrenOf.get(id) ?? []) markTree(k);
    };
    for (const r of roots) markTree(r);
    for (const id of modeIds) {
      if (placed.has(id)) continue;
      roots.push(id);
      markTree(id);
    }

    const current = readCurrent() ?? runtime.currentMode;
    const stats = new Map<string, ReturnType<typeof effectiveStats>>();
    for (const id of modeIds) stats.set(id, effectiveStats(pi, id, cwd));
    return { modeIds, diagnostics, configs, warningsByMode, childrenOf, roots, current, stats };
  }

  function buildModesLines(data: ModesData, theme?: any): string[] {
    const { modeIds, diagnostics, configs, warningsByMode, childrenOf, roots, current, stats } = data;
    const lines: string[] = [];
    const line = (s: string) => lines.push(s);
    const validParent = (pid: string | null | undefined): boolean =>
      typeof pid === "string" && (pid === "default" || (modeIds.includes(pid) && pid !== "full"));

    const renderLine = (id: string, prefix: string, th: any) => {
      const c = configs.get(id);
      const st = stats.get(id)!;
      const isFull = c?.autoLoad === "all" || id === "full";
      const bits: string[] = [`工具${st.tools}`, st.skills === "all" ? "技能全部" : `技能${st.skills}`, `包${st.packages}`];
      let colored: string;
      if (id === current) colored = th.fg("accent", th.bold(`● ${id}`));
      else if (isFull) colored = th.fg("success", `◆ ${id}`);
      else colored = th.fg("text", `○ ${id}`);
      const namePart = c?.name ? th.fg("muted", `  ${c.name}`) : id === "default" ? th.fg("muted", "  默认（最小）") : id === "full" ? th.fg("muted", "  全功能") : "";
      const inh = c?.inherit;
      const inheritNote = typeof inh === "string" && !validParent(inh)
        ? th.fg("warning", `  ← ${inh}（缺失/内置，视作根）`)
        : "";
      const warn = warningsByMode.get(id) ?? [];
      const warnNote = warn.length ? th.fg("warning", `  ⚠️${warn.length}`) : "";
      line(`${prefix}${colored}${namePart}${th.fg("dim", ` · ${bits.join(" ")}`)}${inheritNote}${warnNote}`);
    };

    const rendered = new Set<string>(); // 循环继承防无限递归
    const walk = (id: string, prefix: string, isLast: boolean, isRoot: boolean) => {
      if (rendered.has(id)) return;
      rendered.add(id);
      const kids = childrenOf.get(id) ?? [];
      renderLine(id, prefix, theme ?? dummyTheme);
      kids.forEach((kid, i) => {
        const last = i === kids.length - 1;
        const childPrefix = isRoot ? (last ? "  └─ " : "  ├─ ") : isLast ? `${prefix}   └─ ` : `${prefix}   ├─ `;
        walk(kid, childPrefix, last, false);
      });
    };
    walk("default", "  ", true, true);
    if (!childrenOf.get("default")?.length) walk("full", "  ", true, true);
    else walk("full", "  ", true, true);
    for (const r of roots) walk(r, "  ", true, true);
    if (diagnostics.length) {
      line("");
      line(theme?.fg?.("warning", "⚠️ 诊断:") ?? "⚠️ 诊断:");
      for (const d of diagnostics) line(theme?.fg?.("warning", `  ${d}`) ?? `  ${d}`);
    }
    line("");
    const diagNote = diagnostics.length ? ` · ⚠️${diagnostics.length} 条诊断` : "";
    line(theme?.fg?.("dim", `  当前: ${current ?? "默认（最小）"}${diagNote} · ●=当前 ◆=full · /mode clear 关闭面板`) ?? `  当前: ${current ?? "默认（最小）"}${diagNote}`);
    return lines;
  }

  async function showModes(ctx: ExtensionCommandContext) {
      syncProjectTrust(ctx);
      const cwd = ctx.cwd;
      // 活体面板在 render 时重新采集，这里只捕获稳定的采集依赖
      const readCurrent = () => readCurrentFromBranchCompat(ctx);
      let tui: any = null;
      try {
        tui = await import("@earendil-works/pi-tui");
      } catch { /* 回退纯文本 */ }

      if (tui?.Container && tui?.Text) {
        ctx.ui.setWidget("modes", (t: any, theme: any) =>
          liveWidget(t, cwd, () => buildModesLines(collectModesData(pi, cwd, readCurrent), theme)));
      } else {
        const lines = ["📂 模式:", ...buildModesLines(collectModesData(pi, cwd, readCurrent))];
        ctx.ui.setWidget("modes", lines);
      }
      const data = collectModesData(pi, cwd, readCurrent);
      ctx.ui.notify(`共 ${data.modeIds.length} 个模式${data.diagnostics.length ? `，${data.diagnostics.length} 条诊断` : ""}`, data.diagnostics.length ? "warning" : "info");
  }

  function readCurrentFromBranchCompat(ctx: any): string | null {
    try {
      const entries = ctx.sessionManager.getBranch() ?? [];
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e?.type === "custom" && e.customType === "mode-state" && e.data?.modeId) return e.data.modeId;
      }
    } catch { /* ignore */ }
    return null;
  }

  // ---------- /mode cleanup：清理孤儿包引用（含包管理的资源） ----------
  async function cmdCleanup(_args: string, ctx: ExtensionCommandContext) {
      if (!hasUI(ctx)) return;
      syncProjectTrust(ctx);
      const ids = scanModes(ctx.cwd);
      const orphans = getOrphanPackages(ids, ctx.cwd);
      const entries = Object.entries(orphans);
      if (entries.length === 0) return ctx.ui.notify("没有孤儿引用，一切正常", "info");
      const ok = await ctx.ui.confirm(
        "清理孤儿引用",
        `将移除 ${entries.length} 个模式中的失效包引用及其管理的资源，确认?`,
      );
      if (!ok) return;
      let cleaned = 0;
      for (const [id, pkgs] of entries) {
        const c = loadModeConfig(id, ctx.cwd);
        if (!c) continue;
        for (const pkg of pkgs) {
          cleaned += removePackageResources(c, pkg);
          c.packages = (c.packages ?? []).filter((p) => p !== pkg);
          if (c.packages?.length === 0) delete c.packages;
        }
        saveModeConfig(id, ctx.cwd, c);
        refreshIfCurrent(pi, ctx, id);
      }
      ctx.ui.notify(`✅ 已清理 ${cleaned} 处孤儿引用；残留扩展代码需 /reload 清除`, "info");
  }

  /** 从模式中移除某个包及其管理的资源（owner-aware，手动资源保留）。返回清理条数。 */
  function removePackageResources(c: ModeConfig, pkgSource: string): number {
    let count = 0;
    const managed: ManagedResources = { ...(c.managedResources ?? {}) };
    const own = managed[pkgSource];
    // 收集其他包管理的资源（保留判定用）
    const otherOwned = new Set<string>();
    for (const [p, res] of Object.entries(managed)) {
      if (p === pkgSource) continue;
      for (const t of res.tools ?? []) otherOwned.add(`tool:${t}`);
      for (const s of res.skills ?? []) otherOwned.add(`skill:${skillRefKey(s)}`);
      for (const pr of res.prompts ?? []) otherOwned.add(`prompt:${promptRefKey(pr)}`);
    }
    const isOwnedElsewhere = (k: string) => otherOwned.has(k);
    const hasManualRecord = (kind: "tools" | "skills" | "prompts", key: string): boolean => {
      // 无 managed 记录的资源视为手动资源 → 保留
      const list = kind === "tools" ? c.addTools : kind === "skills" ? (c.addSkills ?? []).map(skillRefKey) : (c.prompts ?? []).map(promptRefKey);
      const ownList = kind === "tools" ? own?.tools ?? [] : kind === "skills" ? (own?.skills ?? []).map(skillRefKey) : (own?.prompts ?? []).map(promptRefKey);
      return list.includes(key) && !ownList.includes(key);
    };

    for (const t of own?.tools ?? []) {
      const key = `tool:${t}`;
      if (isOwnedElsewhere(key) || hasManualRecord("tools", key)) continue;
      const before = c.addTools?.length ?? 0;
      c.addTools = (c.addTools ?? []).filter((x) => x !== t);
      if ((c.addTools?.length ?? 0) < before) count++;
    }
    for (const s of own?.skills ?? []) {
      const key = `skill:${skillRefKey(s)}`;
      if (isOwnedElsewhere(key) || hasManualRecord("skills", key)) continue;
      const before = c.addSkills?.length ?? 0;
      c.addSkills = (c.addSkills ?? []).filter((x) => skillRefKey(x) !== skillRefKey(s));
      if ((c.addSkills?.length ?? 0) < before) count++;
    }
    const prefix = `${pkgSource}/`;
    for (const pr of own?.prompts ?? []) {
      const key = `prompt:${promptRefKey(pr)}`;
      if (isOwnedElsewhere(key) || hasManualRecord("prompts", key)) continue;
      const before = c.prompts?.length ?? 0;
      c.prompts = (c.prompts ?? []).filter((x) => !(x.package === pr.package && x.name === pr.name));
      if ((c.prompts?.length ?? 0) < before) count++;
    }
    if (c.addTools?.length === 0) delete c.addTools;
    if (c.addSkills?.length === 0) delete c.addSkills;
    if (c.prompts?.length === 0) delete c.prompts;
    delete managed[pkgSource];
    if (Object.keys(managed).length === 0) delete c.managedResources;
    else c.managedResources = managed;
    return count;
  }

  // ---------- /mode del：删除模式（作用域选择 + 顺延 + 当前模式回落） ----------
  async function cmdDelMode(args: string, ctx: ExtensionCommandContext) {
      if (!hasUI(ctx)) return;
      syncProjectTrust(ctx);
      const ids = scanModes(ctx.cwd);
      if (ids.length === 0) return ctx.ui.notify("没有模式可删除", "warning");
      let id = args || (await ctx.ui.select("删除哪个模式?", ids));
      if (!id) return;
      if (!ids.includes(id) && id !== "full") {
        ctx.ui.notify(`❌ 模式「${id}」不存在`, "error");
        return;
      }
      if (id === "full") {
        const ok = await ctx.ui.confirm("删除 full.json", "full 是内置模式，删除后 /mode use full 仍可用（内置兜底）。删除 full.json?", );
        if (!ok) return;
        const p = join(globalModesDir, "full.json");
        if (existsSync(p)) rmSync(p);
        bumpRuntimeRev();
        ctx.ui.notify("✅ 已删除 full.json（/mode use full 仍以内置配置可用）", "info");
        return;
      }
      if (id === "default") {
        ctx.ui.notify(`❌ ${id} 是内置模式，不能删除`, "error");
        return;
      }

      // 作用域选择（决策 11）
      const globalPath = join(globalModesDir, `${id}.json`);
      const projectPath = join(projectModesDir(ctx.cwd), `${id}.json`);
      const hasGlobal = existsSync(globalPath);
      const hasProject = existsSync(projectPath);
      let removeGlobal = false;
      let removeProject = false;
      if (hasGlobal && hasProject) {
        const scope = await ctx.ui.select(`「${id}」存在两个同名模式:`, [
          "删除当前项目级模式（全局自动恢复可用）",
          "删除全局模式",
          "同时删除两者",
          "取消",
        ]);
        if (!scope || scope.startsWith("取消")) return;
        removeProject = scope.startsWith("删除当前项目") || scope.startsWith("同时删除");
        removeGlobal = scope.startsWith("删除全局") || scope.startsWith("同时删除");
      } else {
        removeGlobal = hasGlobal;
        removeProject = hasProject;
      }

      const config = loadModeConfig(id, ctx.cwd);
      // 删除一个作用域的同名文件后，另一个作用域仍会接管该 id，不能错误改写子模式继承。
      const modeRemains = (hasGlobal && !removeGlobal) || (hasProject && !removeProject);
      const children = modeRemains ? [] : ids.filter((m) => m !== id && loadModeConfig(m, ctx.cwd)?.inherit === id);
      const fallbackInherit: string | null = (config?.inherit as string | null) ?? null;
      const fallbackLabel = fallbackInherit ?? "无（变为独立模式）";

      const stateCurrent = readCurrentFromBranchCompat(ctx) ?? runtime.currentMode;
      const isCurrent = stateCurrent === id && !modeRemains;

      const parts: string[] = [];
      if (children.length) parts.push(`${id} 被 ${children.join(", ")} 继承，删除后顺延至「${fallbackLabel}」`);
      if (isCurrent) parts.push(`${id} 是当前使用的模式，删除后回落到默认`);
      const ok = await ctx.ui.confirm("删除模式", parts.length ? parts.join("；") : `确认删除模式 ${id}?`);
      if (!ok) return;

      if (removeGlobal) rmSync(globalPath);
      if (removeProject) rmSync(projectPath);

      for (const child of children) {
        const c = loadModeConfig(child, ctx.cwd);
        if (c) {
          c.inherit = c.inherit === id ? fallbackInherit : c.inherit;
          saveModeConfig(child, ctx.cwd, c);
        }
      }
      bumpRuntimeRev(); // /mode show 树实时移除节点、顺延继承

      if (isCurrent) {
        const msg = applyMode(pi, ctx, "default");
        ctx.ui.notify(msg, "info");
      }

      ctx.ui.notify(
        `✅ 已删除 ${id}${children.length ? `，${children.join(", ")} 已顺延` : ""}${isCurrent ? "，当前已回落默认" : ""}`,
        "info",
      );
  }

  // ---------- /mode edit：编辑模式（立即生效；full 可编辑不可删） ----------
  async function cmdEditMode(args: string, ctx: ExtensionCommandContext) {
      if (!hasUI(ctx)) return;
      syncProjectTrust(ctx);
      const ids = scanModes(ctx.cwd);
      if (ids.length === 0) return ctx.ui.notify("没有模式可编辑", "warning");
      const id = args || (await ctx.ui.select("编辑哪个模式?", ids));
      if (!id) return;
      if (!ids.includes(id) && id !== "full") {
        ctx.ui.notify(`❌ 模式「${id}」不存在`, "error");
        return;
      }
      const isFull = id === "full";
      const cur = loadMode(id, ctx.cwd);
      if (cur.broken) return ctx.ui.notify(`❌ ${id}.json 配置损坏，请先修复或删除该文件`, "error");
      const config = cur.config ?? { name: "全功能", autoLoad: "all" as const, systemPrompt: "" };
      const previousConfig: ModeConfig = JSON.parse(JSON.stringify(config));
      const location = modeLocation(id, ctx.cwd);

      if (isFull) {
        // full：只编辑显示名与提示词
        const name = await ctx.ui.input("显示名称:", config.name ?? "全功能");
        if (!name) return;
        const prompt = await ctx.ui.editor("系统提示词（留空=不注入）:", config.systemPrompt ?? "");
        if (prompt === undefined) return;
        const saved: ModeConfig = { ...config, name, systemPrompt: prompt };
        if (writeJson(join(globalModesDir, "full.json"), { ...saved, schemaVersion: 2 })) {
          bumpRuntimeRev();
          ctx.ui.notify("✅ 已保存 full.json，下次请求生效", "info");
        } else ctx.ui.notify("❌ 保存失败", "error");
        return;
      }

      // 显示名
      const name = await ctx.ui.input("显示名称:", config.name ?? id);
      if (!name) return;

      // 父模式
      const modeIds = scanModes(ctx.cwd).filter((m) => m !== "full" && m !== id);
      const parent = await ctx.ui.select("父模式 (继承):", ["无（独立模式）", "default（虚拟根模式）", ...modeIds]);
      if (!parent) return;
      const parentId = parent.startsWith("无") ? null : parent.startsWith("default") ? "default" : parent;
      if (parentId && parentId !== "default") {
        const err = checkInheritDirection(location ?? "global", parentId, ctx.cwd);
        if (err) return ctx.ui.notify(`❌ ${err}`, "error");
        if (createsCycle(id, parentId, ctx.cwd)) return ctx.ui.notify(`❌ 循环继承：「${parentId}」的祖先链已包含 ${id}`, "error");
      }

      // 父提示词处理方式
      let promptMode: "append" | "override" = config.promptMode ?? "override";
      if (parentId) {
        const pm = await ctx.ui.select("父模式提示词:", [promptMode === "append" ? "追加父模式提示词" : "覆盖父模式提示词", promptMode === "append" ? "覆盖父模式提示词" : "追加父模式提示词"]);
        if (!pm) return;
        promptMode = pm.startsWith("追加") ? "append" : "override";
      }

      // 位置迁移（目标存在需确认，决策 55）
      const locChoice = await ctx.ui.select("位置:", ["保持当前位置", "移到全局", "移到当前项目"]);
      if (!locChoice) return;

      // 包
      const pkgList = listInstalledPackages(ctx.cwd);
      const pkgLabels = pkgList.map((p) => ({
        value: p.source,
        label: `${p.source}${p.scope === "project" ? "（项目）" : "（全局）"}`,
      }));
      const packages = await settingsMultiSelect(ctx, "挂载包", pkgLabels, config.packages ?? []);
      if (packages === null) return;
      const chosenPkgs = pkgList.filter((p) => packages.includes(p.source));
      // 仅新挂载的包自动预勾：已挂载包的手动取消保持不动，避免覆盖用户之前的选择。
      const prevPackages = new Set(previousConfig.packages ?? []);
      const newPkgs = chosenPkgs.filter((p) => !prevPackages.has(p.source));
      if (newPkgs.length > 0) {
        const probeTools = new Set(newPkgs.flatMap((p) => packageToolNames(pi, p, ctx.cwd)));
        const probeSkills = newPkgs.flatMap((p) => inspectPackage(p.source, ctx.cwd).skills);
        const probePrompts = packagePromptRefs(newPkgs, ctx.cwd);
        ctx.ui.notify(
          probeTools.size + probeSkills.length + probePrompts.length > 0
            ? `📦 新挂载包的工具/技能/提示已自动预勾，可在后续步骤再取消` 
            : `⚠️ 新挂载的包暂无可注册工具/技能/提示，仅记录包引用`,
          "info",
        );
      }

      // 工具（预填旧值 + 新包工具，过滤核心 4）
      const preTools = [...new Set([
        ...(config.addTools ?? []).filter((t) => !DEFAULT_TOOLS.includes(t)),
        ...newPkgs.flatMap((p) => packageToolNames(pi, p, ctx.cwd)),
      ])];
      const tools = await settingsMultiSelect(ctx, "工具（核心 4 工具固定）", toolOptions(pi), preTools);
      if (tools === null) return;

      // 技能（结构化，预填）
      const skillItems: SelectItem[] = scanSkillRefs(ctx.cwd).map((ref) => ({
        value: skillRefKey(ref),
        label: `${ref.name}（${ref.scope === "project" ? "项目" : "全局"}）`,
      }));
      for (const p of chosenPkgs) {
        for (const s of inspectPackage(p.source, ctx.cwd).skills) {
          const ref: SkillRef = { scope: "package", package: p.source, name: s };
          if (!skillItems.some((i) => (typeof i === "string" ? i : i.value) === skillRefKey(ref))) {
            skillItems.push({ value: skillRefKey(ref), label: `${s} — ${p.source}` });
          }
        }
      }
      const preSkills = [...new Set([
        ...(config.addSkills ?? []).map(skillRefKey),
        ...newPkgs.flatMap((p) =>
          inspectPackage(p.source, ctx.cwd).skills.map((s) =>
            skillRefKey({ scope: "package", package: p.source, name: s } as SkillRef),
          ),
        ),
      ])];
      const skills = await settingsMultiSelect(ctx, "技能", skillItems, preSkills);
      if (skills === null) return;

      // 提示模板（预填）
      const promptRefs = packagePromptRefs(chosenPkgs, ctx.cwd);
      const promptItems: SelectItem[] = promptRefs.map((r) => ({ value: promptRefKey(r), label: `${r.package}/${r.name}` }));
      for (const r of config.prompts ?? []) {
        const key = promptRefKey(r);
        if (!promptItems.some((i) => (typeof i === "string" ? i : i.value) === key)) {
          promptItems.push({ value: key, label: `${r.package ?? "(无包)"}/${r.name}${r.package ? "" : "（未安装）"}` });
        }
      }
      const prePrompts = [...new Set([
        ...(config.prompts ?? []).map(promptRefKey),
        ...packagePromptRefs(newPkgs, ctx.cwd).map(promptRefKey),
      ])];
      const prompts = await settingsMultiSelect(ctx, "提示模板（/reload 后生效）", promptItems, prePrompts);
      if (prompts === null) return;

      // 系统提示词
      const prompt = await ctx.ui.editor("系统提示词:", config.systemPrompt ?? "");
      if (prompt === undefined) return;

      const newConfig: ModeConfig = {
        ...config,
        schemaVersion: 2,
        name,
        inherit: parentId,
        promptMode: parentId ? promptMode : undefined,
        packages,
        addTools: tools,
        addSkills: skills.map((v) => JSON.parse(v) as SkillRef),
        prompts: prompts.map((v) => JSON.parse(v) as PromptRef),
        systemPrompt: prompt,
      };
      reconcileManagedResources(newConfig, packages, chosenPkgs, pi, ctx.cwd, previousConfig);

      const curLoc = location ?? "global";
      const targetLoc = locChoice.startsWith("移到全局") ? "global" : locChoice.startsWith("移到当前项目") ? "project" : curLoc;
      const targetPath = targetLoc === "global" ? join(globalModesDir, `${id}.json`) : join(projectModesDir(ctx.cwd), `${id}.json`);
      if (targetLoc !== curLoc && existsSync(targetPath)) {
        const ok = await ctx.ui.confirm("目标已存在", `目标位置已存在 ${id}.json，是否覆盖?`);
        if (!ok) return ctx.ui.notify("已取消迁移", "info");
      }
      if (!writeJson(targetPath, newConfig)) return ctx.ui.notify("❌ 保存失败", "error");
      bumpRuntimeRev();
      if (targetLoc !== curLoc) {
        for (const p of [join(globalModesDir, `${id}.json`), join(projectModesDir(ctx.cwd), `${id}.json`)]) {
          if (p !== targetPath && existsSync(p)) rmSync(p);
        }
      }

      refreshIfCurrent(pi, ctx, id);
      const hasPrompts = (newConfig.prompts ?? []).length > 0;
      ctx.ui.notify(
        `✅ 已保存 ${id}（${targetLoc === "global" ? "全局" : "项目级"}）${hasPrompts ? "；提示模板需 /reload 生效" : ""}`,
        "info",
      );
  }

  // ---------- /link add：挂载包/资源（整包 / 单工具 / 单技能 / 单提示） ----------
  async function cmdLink(args: string, ctx: ExtensionCommandContext) {
      if (!hasUI(ctx)) return;
      syncProjectTrust(ctx);
      const pkgList = listInstalledPackages(ctx.cwd);
      if (pkgList.length === 0) return ctx.ui.notify("没有已安装的包（先 pi install）", "warning");

      // ① 选择包（支持参数，严格校验）
      let pkg: { source: string; name: string; scope: string } | undefined;
      if (args) {
        const key = args.trim();
        const identity = packageIdentity(key);
        pkg = pkgList.find((p) => p.source === key || p.name === key || packageIdentity(p.source) === identity || p.name === key.replace(/^npm:/, "").replace(/@.*$/, ""));
        if (!pkg) return ctx.ui.notify(`❌ 未找到已安装的包「${key}」，请先 pi install`, "error");
      } else {
        const labels = pkgList.map((p) => ({ value: p.source, label: `${p.source}${p.scope === "project" ? "（项目）" : "（全局）"}` }));
        const picked = await ctx.ui.select("选择包:", labels.map((l) => l.label));
        if (!picked) return;
        const value = picked.replace(/（项目）$|（全局）$/, "");
        pkg = pkgList.find((p) => p.source === value);
        if (!pkg) return;
      }

      // ② 挂载粒度（两级挂载；单扩展不支持——Pi 无运行时扩展加载 API）
      const contents = inspectPackage(pkg.source, ctx.cwd);
      const pkgTools = packageToolNames(pi, pkg, ctx.cwd);
      const opts: string[] = ["📦 整个包（全部资源）"];
      for (const t of pkgTools) opts.push(`🔧 ${t}`);
      for (const s of contents.skills) opts.push(`🎯 ${s}`);
      for (const p of contents.prompts) opts.push(`📝 ${p}`);
      let option: string | undefined;
      if (opts.length === 1) {
        ctx.ui.notify(`⚠️ ${pkg.source} 当前没有已注册工具/技能/提示，将仅记录包引用`, "warning");
        option = opts[0];
      } else {
        option = await ctx.ui.select(`${pkg.source} 的挂载内容:`, opts);
        if (!option) return;
      }

      // ③ 目标模式
      const modeIds = scanModes(ctx.cwd).filter((m) => m !== "full");
      if (modeIds.length === 0) return ctx.ui.notify("没有模式，先 /mode add 创建", "warning");
      const mode = await ctx.ui.select("挂载到哪个模式?", modeIds);
      if (!mode) return;
      const config = loadModeConfig(mode, ctx.cwd);
      if (!config) return;

      let okMsg = "";
      let conflictMsg = "";
      const managed: ManagedResources = { ...(config.managedResources ?? {}) };
      const own = (managed[pkg.source] ??= {});

      const addOwner = (kind: "tools" | "skills" | "prompts", key: string, apply: () => boolean): boolean => {
        const ownList: string[] = kind === "tools" ? (own.tools ??= []) : kind === "skills" ? ((own.skills ??= []) as any) : ((own.prompts ??= []) as any);
        const ownKeys = ownList.map((x: any) => (kind === "tools" ? x : JSON.stringify(x)));
        if (ownKeys.includes(key)) {
          return false; // 已由该包挂载
        }
        // 检查是否已由其他包或手动添加
        const allList = kind === "tools" ? (config.addTools ?? []) : kind === "skills" ? (config.addSkills ?? []).map((x) => JSON.stringify(x)) : (config.prompts ?? []).map((x) => JSON.stringify(x));
        const existsInList = allList.includes(key);
        if (existsInList) {
          // 已存在但不是本包挂载：只追加 owner 记录，不重复添加；
          // 同时登记 __manual__ 手动来源声明，保证 link del/mode cleanup 不误删原配置（决策 Q7/A）
          const manual = (managed["__manual__"] ??= {});
          const manualList: any[] = kind === "tools" ? (manual.tools ??= []) : kind === "skills" ? ((manual.skills ??= []) as any) : ((manual.prompts ??= []) as any);
          const manualKeys = manualList.map((x: any) => (kind === "tools" ? x : JSON.stringify(x)));
          if (!manualKeys.includes(key)) manualList.push(kind === "tools" ? key : JSON.parse(key));
          ownList.push(kind === "tools" ? key : JSON.parse(key));
          return true;
        }
        if (!apply()) return false;
        ownList.push(kind === "tools" ? key : JSON.parse(key));
        return true;
      };

      if (option.startsWith("🔧 ")) {
        const toolName = option.slice(3);
        config.addTools ??= [];
        if (!addOwner("tools", toolName, () => {
          config.addTools = [...new Set([...(config.addTools ?? []), toolName])];
          return true;
        })) conflictMsg = `${toolName} 已由该包挂载到 /${mode}`;
        else okMsg = "工具已即时生效";
      } else if (option.startsWith("🎯 ")) {
        const skillName = option.slice(3);
        const ref: SkillRef = { scope: "package", package: pkg.source, name: skillName };
        const key = JSON.stringify(ref);
        config.addSkills ??= [];
        if (!addOwner("skills", key, () => {
          config.addSkills = [...(config.addSkills ?? []), ref];
          return true;
        })) conflictMsg = `${skillName} 已由该包挂载到 /${mode}`;
        else okMsg = "技能描述将随下次请求注入（渐进式）";
      } else if (option.startsWith("📝 ")) {
        const promptName = option.slice(3);
        const ref: PromptRef = { package: pkg.source, name: promptName };
        const key = JSON.stringify(ref);
        config.prompts ??= [];
        if (!addOwner("prompts", key, () => {
          config.prompts = [...(config.prompts ?? []), ref];
          return true;
        })) conflictMsg = `${promptName} 已由该包挂载到 /${mode}`;
        else okMsg = "/reload 后生效";
      } else {
        // 整包
        if ((config.packages ?? []).includes(pkg.source)) {
          conflictMsg = `${pkg.source} 已挂载到 /${mode}`;
        } else {
          config.packages = [...(config.packages ?? []), pkg.source];
          const addedTools = packageToolNames(pi, pkg, ctx.cwd);
          for (const t of addedTools) {
            config.addTools ??= [];
            addOwner("tools", t, () => {
              config.addTools = [...new Set([...(config.addTools ?? []), t])];
              return true;
            });
          }
          for (const s of contents.skills) {
            const ref: SkillRef = { scope: "package", package: pkg.source, name: s };
            config.addSkills ??= [];
            addOwner("skills", JSON.stringify(ref), () => {
              config.addSkills = [...(config.addSkills ?? []), ref];
              return true;
            });
          }
          for (const p of contents.prompts) {
            const ref: PromptRef = { package: pkg.source, name: p };
            config.prompts ??= [];
            addOwner("prompts", JSON.stringify(ref), () => {
              config.prompts = [...(config.prompts ?? []), ref];
              return true;
            });
          }
          const bits: string[] = [];
          if (addedTools.length) bits.push(`工具${addedTools.length}`);
          if (contents.skills.length) bits.push(`技能${contents.skills.length}`);
          if (contents.prompts.length) bits.push(`提示${contents.prompts.length}`);
          okMsg = bits.length
            ? `已展开 ${bits.join(" · ")}（工具即时生效，技能下次请求注入，提示 /reload 后生效）`
            : "该包未发现可用资源，仅记录包引用";
        }
      }
      // 清理空的 managed 条目
      for (const [p, v] of Object.entries(managed)) {
        if (!(v.tools?.length ?? 0) && !(v.skills?.length ?? 0) && !(v.prompts?.length ?? 0)) delete managed[p];
      }
      if (Object.keys(managed).length > 0) config.managedResources = managed;
      else delete config.managedResources;

      if (saveModeConfig(mode, ctx.cwd, config)) {
        refreshIfCurrent(pi, ctx, mode);
        ctx.ui.notify(
          conflictMsg
            ? `✅ ${option} → /${mode}（⚠️ ${conflictMsg}）`
            : `✅ ${option} → /${mode}（${okMsg}）`,
          conflictMsg ? "warning" : "info",
        );
      } else {
        ctx.ui.notify("❌ 写入失败", "error");
      }
  }

  // ---------- /link show：挂载关系面板（命令与活体面板共用） ----------
  /** 每次调用都重新扫描磁盘，返回有配置的模式行。 */
  function collectLinkedRows(cwd: string): { id: string; c: ModeConfig }[] {
    return scanModes(cwd)
      .map((id) => ({ id, c: loadModeConfig(id, cwd) }))
      .filter((r): r is { id: string; c: ModeConfig } => !!r.c);
  }

  function buildLinkedLines(rows: { id: string; c: ModeConfig }[], theme?: any): string[] {
    const lines: string[] = [];
    const addChild = (s: string) => lines.push(s);
    addChild(theme?.fg?.("accent", theme?.bold?.("🔗 挂载关系")) ?? "🔗 挂载关系:");
    for (const { id, c } of rows) {
      const whole = new Set(c.packages ?? []);
      const managed = c.managedResources ?? {};
      // 按包归组单独挂载的资源；整包挂载的只显示 📦（整包），不再展开包内明细
      const perPkg = new Map<string, string[]>();
      const own = (pkg: string | null, item: string) => {
        const key = pkg ?? "__manual__";
        let list = perPkg.get(key);
        if (!list) { list = []; perPkg.set(key, list); }
        list.push(item);
      };
      for (const [pkg, res] of Object.entries(managed)) {
        if (pkg === "__manual__" || whole.has(pkg)) continue;
        for (const t of res.tools ?? []) own(pkg, `🔧 ${t}`);
        for (const s of res.skills ?? []) own(pkg, `🎯 ${s.name}`);
        for (const p of res.prompts ?? []) own(pkg, `📝 ${p.name}`);
      }
      // 无 owner 记录的资源按手动资源归组（包括被整包覆盖的：由整包行代表，不重复）
      const ownedBy = (pred: (r: ManagedPackageResources) => boolean) => Object.values(managed).some(pred);
      for (const t of c.addTools ?? []) {
        if (!ownedBy((r) => (r.tools ?? []).includes(t))) own(null, `🔧 ${t}`);
      }
      for (const s of c.addSkills ?? []) {
        const key = JSON.stringify(s);
        if (!ownedBy((r) => (r.skills ?? []).some((x) => JSON.stringify(x) === key)))
          own(null, s.scope === "package" && s.package ? `🎯 ${s.package}/${s.name}` : `🎯 ${s.name}（${s.scope}）`);
      }
      for (const p of c.prompts ?? []) {
        const key = JSON.stringify(p);
        if (!ownedBy((r) => (r.prompts ?? []).some((x) => JSON.stringify(x) === key)))
          own(null, `📝 ${p.package ? `${p.package}/${p.name}` : p.name}`);
      }
      if (whole.size === 0 && perPkg.size === 0) continue;
      addChild(theme?.fg?.("text", `  ${id}`) ?? `  ${id}`);
      for (const p of c.packages ?? []) addChild(`    📦 ${p}（整包）`);
      for (const [pkg, items] of perPkg) {
        if (items.length === 0) continue;
        if (pkg === "__manual__") addChild(`    ${items.join(" · ")}`);
        else addChild(`    📦 ${pkg} → ${items.join(" · ")}`);
      }
    }
    return lines;
  }

  async function showLinked(ctx: ExtensionCommandContext) {
      const cwd = ctx.cwd;
      const rows = collectLinkedRows(cwd);
      if (rows.length === 0) return ctx.ui.notify("没有模式，先 /mode add 创建", "warning");
      const hasAny = rows.some((r) =>
        (r.c.packages?.length ?? 0) + (r.c.addTools?.length ?? 0) + (r.c.addSkills?.length ?? 0) + (r.c.prompts?.length ?? 0) > 0,
      );
      if (!hasAny) return ctx.ui.notify("暂无挂载，用 /link add 添加", "warning");

      let tui: any = null;
      try {
        tui = await import("@earendil-works/pi-tui");
      } catch { /* 回退 */ }

      if (tui?.Container && tui?.Text) {
        ctx.ui.setWidget("linked", (t: any, theme: any) =>
          liveWidget(t, cwd, () => buildLinkedLines(collectLinkedRows(cwd), theme)));
      } else {
        ctx.ui.setWidget("linked", buildLinkedLines(rows));
      }
      ctx.ui.notify("✅ 已更新挂载面板（/link clear 关闭）", "info");
  }

  // ---------- /link del：解除挂载（参数 + 向导；owner-aware 级联） ----------
  async function cmdUnlink(args: string, ctx: ExtensionCommandContext) {
      if (!hasUI(ctx)) return;
      syncProjectTrust(ctx);
      const modeIds = scanModes(ctx.cwd);
      if (modeIds.length === 0) return ctx.ui.notify("没有模式", "warning");

      // 参数形式：/link del <pkg> → 查找挂载该包的模式
      let mode: string | undefined;
      let targetPkg: string | undefined;
      if (args) {
        const key = args.trim();
        const identity = packageIdentity(key);
        const packageMatches = (p: string) => p === key || p.endsWith(`/${key}`) || packageIdentity(p) === identity || p.replace(/^npm:/, "") === key.replace(/^npm:/, "");
        const mounted = modeIds.filter((id) => {
          const c = loadModeConfig(id, ctx.cwd);
          return (c?.packages ?? []).some(packageMatches)
            || Object.keys(c?.managedResources ?? {}).some((p) => p !== "__manual__" && packageMatches(p));
        });
        if (mounted.length === 0) return ctx.ui.notify(`❌ 没有模式挂载包「${key}」`, "error");
        if (mounted.length === 1) mode = mounted[0];
        else mode = await ctx.ui.select(`「${key}」被多个模式挂载，从哪个移除?`, mounted);
        if (!mode) return;
        const cfg = loadModeConfig(mode, ctx.cwd);
        targetPkg = cfg?.packages?.find(packageMatches)
          ?? Object.keys(cfg?.managedResources ?? {}).find((p) => p !== "__manual__" && packageMatches(p));
        if (!targetPkg) return ctx.ui.notify(`❌ /${mode} 未挂载包「${key}」`, "error");
      } else {
        mode = await ctx.ui.select("从哪个模式移除?", modeIds);
        if (!mode) return;
      }
      const config = loadModeConfig(mode, ctx.cwd);
      if (!config) return;

      // 选项：整包 + 包内资源 + 手动资源
      const options: string[] = [];
      for (const p of config.packages ?? []) options.push(`📦 ${p}（含其资源）`);
      for (const t of config.addTools ?? []) options.push(`🔧 ${t}`);
      for (const s of config.addSkills ?? []) options.push(`🎯 ${skillRefKey(s)}`);
      for (const p of config.prompts ?? []) options.push(`📝 ${promptRefKey(p)}`);
      if (options.length === 0) return ctx.ui.notify(`/${mode} 没有挂载任何内容`, "warning");

      let item: string | undefined;
      if (targetPkg) {
        item = `📦 ${targetPkg}（含其资源）`;
      } else {
        item = await ctx.ui.select("移除哪个?", options);
        if (!item) return;
      }

      if (item.startsWith("📦 ")) {
        const p = item.slice(3).replace(/（含其资源）$/, "");
        const promptsBefore = config.prompts?.length ?? 0;
        removePackageResources(config, p);
        config.packages = (config.packages ?? []).filter((x) => x !== p);
        if (config.packages?.length === 0) delete config.packages;
        if (saveModeConfig(mode, ctx.cwd, config)) {
          refreshIfCurrent(pi, ctx, mode);
          const promptsGone = (config.prompts?.length ?? 0) < promptsBefore;
          ctx.ui.notify(`✅ 已从 /${mode} 移除 📦 ${p}（含其管理的资源；手动资源已保留${promptsGone ? "；移除的提示模板需 /reload 后消失" : ""}）`, "info");
        }
        return;
      }

      if (item.startsWith("🔧 ")) {
        const t = item.slice(3);
        const owners = Object.entries(config.managedResources ?? {}).filter(([p, v]) => p !== "__manual__" && (v.tools ?? []).includes(t));
        const manual = (config.managedResources?.__manual__?.tools ?? []).includes(t);
        if (owners.length > 1) {
          return ctx.ui.notify(`⚠️ ${t} 由多个包拥有，请使用 /link del <pkg> 逐个解除`, "warning");
        }
        if (!manual) {
          config.addTools = (config.addTools ?? []).filter((x) => x !== t);
          if (config.addTools.length === 0) delete config.addTools;
        }
        if (config.managedResources) {
          for (const v of Object.values(config.managedResources)) v.tools = (v.tools ?? []).filter((x) => x !== t);
        }
      } else if (item.startsWith("🎯 ")) {
        const ref = JSON.parse(item.slice(3)) as SkillRef;
        const key = skillRefKey(ref);
        const owners = Object.entries(config.managedResources ?? {}).filter(([p, v]) => p !== "__manual__" && (v.skills ?? []).some((x) => skillRefKey(x) === key));
        const manual = (config.managedResources?.__manual__?.skills ?? []).some((x) => skillRefKey(x) === key);
        if (owners.length > 1) return ctx.ui.notify(`⚠️ ${ref.name} 由多个包拥有，请使用 /link del <pkg> 逐个解除`, "warning");
        if (!manual) {
          config.addSkills = (config.addSkills ?? []).filter((x) => skillRefKey(x) !== key);
          if (config.addSkills.length === 0) delete config.addSkills;
        }
        if (config.managedResources) {
          for (const v of Object.values(config.managedResources)) v.skills = (v.skills ?? []).filter((x) => skillRefKey(x) !== key);
        }
      } else if (item.startsWith("📝 ")) {
        const ref = JSON.parse(item.slice(3)) as PromptRef;
        const key = promptRefKey(ref);
        const owners = Object.entries(config.managedResources ?? {}).filter(([p, v]) => p !== "__manual__" && (v.prompts ?? []).some((x) => promptRefKey(x) === key));
        const manual = (config.managedResources?.__manual__?.prompts ?? []).some((x) => promptRefKey(x) === key);
        if (owners.length > 1) return ctx.ui.notify(`⚠️ ${ref.name} 由多个包拥有，请使用 /link del <pkg> 逐个解除`, "warning");
        if (!manual) {
          config.prompts = (config.prompts ?? []).filter((x) => promptRefKey(x) !== key);
          if (config.prompts.length === 0) delete config.prompts;
        }
        if (config.managedResources) {
          for (const v of Object.values(config.managedResources)) v.prompts = (v.prompts ?? []).filter((x) => promptRefKey(x) !== key);
        }
      }
      if (config.managedResources) {
        for (const [p, v] of Object.entries(config.managedResources)) {
          if (!(v.tools?.length ?? 0) && !(v.skills?.length ?? 0) && !(v.prompts?.length ?? 0)) delete config.managedResources![p];
        }
        if (Object.keys(config.managedResources).length === 0) delete config.managedResources;
      }
      if (saveModeConfig(mode, ctx.cwd, config)) {
        refreshIfCurrent(pi, ctx, mode);
        const eff = item.startsWith("🔧 ") ? "（已即时生效）"
          : item.startsWith("🎯 ") ? "（下次请求生效）"
          : item.startsWith("📝 ") ? "（需 /reload 后消失）" : "";
        ctx.ui.notify(`✅ 已从 /${mode} 移除 ${item.slice(0, 40)}${eff}`, "info");
      }
  }

  // ---------- /mode 与 /link：子命令分发 + 两级补全 ----------
  type Sub = { value: string; label: string; description: string };
  type CompletionItem = { value: string; label: string; description?: string };

  const MODE_SUBS: Sub[] = [
    { value: "show", label: "show", description: "打开模式面板" },
    { value: "clear", label: "clear", description: "关闭模式面板" },
    { value: "use", label: "use", description: "切换模式（/mode use <id>）" },
    { value: "add", label: "add", description: "创建模式（向导）" },
    { value: "edit", label: "edit", description: "编辑模式（/mode edit <id>）" },
    { value: "del", label: "del", description: "删除模式（/mode del <id>）" },
    { value: "init", label: "init", description: "生成/修复 full.json 模板" },
    { value: "cleanup", label: "cleanup", description: "清理已卸载包的引用" },
  ];

  const LINK_SUBS: Sub[] = [
    { value: "add", label: "add", description: "挂载包/工具/技能/提示到模式（/link add <pkg>）" },
    { value: "del", label: "del", description: "解除挂载（/link del <pkg>）" },
    { value: "show", label: "show", description: "打开挂载关系面板" },
    { value: "clear", label: "clear", description: "关闭挂载面板" },
  ];

  function completionCwd(): string | null {
    const cwd = runtime.cwd;
    return typeof cwd === "string" && cwd ? cwd : null;
  }

  /**
   * 两级补全：argumentText 是命令名之后的完整参数文本，返回 item.value 会整体替换它。
   * - 无尾随空格且 ≤1 个 token → 过滤第一级子命令
   * - 尾随空格 / 2 个 token → 进入第二级（secondLevel 返回的 value 已带「子命令 」前缀）
   */
  function subcommandCompletions(
    argumentText: string,
    subs: Sub[],
    secondLevel: (sub: string) => CompletionItem[] | null,
  ): CompletionItem[] | null {
    try {
      const trailing = /\s$/.test(argumentText);
      const tokens = argumentText.trim().split(/\s+/).filter(Boolean);
      if (!trailing && tokens.length <= 1) {
        const prefix = tokens[0] ?? "";
        const filtered = subs.filter((s) => s.value.startsWith(prefix));
        return filtered.length > 0 ? filtered : null;
      }
      if (tokens.length === 0) return subs;
      const sub = tokens[0];
      if (!subs.some((s) => s.value === sub)) return null;
      const rest = trailing ? "" : (tokens[1] ?? "");
      const items = secondLevel(sub) ?? [];
      const filtered = items.filter((i) => i.value.slice(sub.length + 1).startsWith(rest));
      return filtered.length > 0 ? filtered : null;
    } catch {
      return null;
    }
  }

  /** /mode use|edit|del 的第二级候选：实时扫描模式文件，新配置免 reload 即可补全。 */
  function modeIdCompletions(sub: string): CompletionItem[] | null {
    const cwd = completionCwd();
    if (!cwd || !(sub === "use" || sub === "edit" || sub === "del")) return null;
    // scanModes 已含 full.json（用户可 /mode init 生成），与内置 full 去重
    const ids = sub === "del"
      ? [...new Set(["full", ...scanModes(cwd)])]
      : [...new Set(["default", "full", ...scanModes(cwd)])];
    const items = ids.map((id) => {
      const c = id === "default" ? null : loadModeConfig(id, cwd);
      const name = id === "default" ? "默认（最小）" : (c?.name ?? (id === "full" ? "全功能" : id));
      return { value: `${sub} ${id}`, label: id, description: name };
    });
    return items.length > 0 ? items : null;
  }

  // /link add 的包扫描较重（node_modules 遍历 + manifest 读取），用短 TTL memo 平滑连续按键
  const PKG_CACHE_TTL = 2000;
  let pkgCache: { key: string; at: number; items: CompletionItem[] } | null = null;

  /** /link add|del 的第二级候选；del 只列当前被任意模式挂载的包。 */
  function packageCompletions(sub: string): CompletionItem[] | null {
    const cwd = completionCwd();
    if (!cwd || (sub !== "add" && sub !== "del")) return null;
    try {
      if (sub === "del") {
        const mounted = new Map<string, string[]>();
        for (const id of scanModes(cwd)) {
          const c = loadModeConfig(id, cwd);
          const pkgs = new Set([
            ...(c?.packages ?? []),
            ...Object.keys(c?.managedResources ?? {}).filter((p) => p !== "__manual__"),
          ]);
          for (const p of pkgs) {
            const list = mounted.get(p) ?? [];
            list.push(id);
            mounted.set(p, list);
          }
        }
        if (mounted.size === 0) return null;
        return [...mounted.entries()].map(([p, modes]) => ({
          value: `del ${p}`,
          label: p,
          description: `挂载于 ${modes.join(", ")}`,
        }));
      }
      const now = Date.now();
      if (pkgCache && pkgCache.key === cwd && now - pkgCache.at < PKG_CACHE_TTL) return pkgCache.items;
      const items = listInstalledPackages(cwd).map((p) => ({
        value: `add ${p.source}`,
        label: p.source,
        description: `${p.name}${p.scope === "project" ? "（项目）" : "（全局）"}`,
      }));
      pkgCache = { key: cwd, at: now, items };
      return items.length > 0 ? items : null;
    } catch {
      return null;
    }
  }

  // ---------- /mode：模式管理入口 ----------
  pi.registerCommand("mode", {
    description: "模式管理：show/clear/use/add/edit/del/init/cleanup（/mode 空格查看子命令）",
    getArgumentCompletions: (argumentText: string) =>
      subcommandCompletions(argumentText, MODE_SUBS, modeIdCompletions),
    handler: async (args, ctx) => {
      syncProjectTrust(ctx);
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const sub = tokens[0] ?? "show";
      const rest = tokens.slice(1).join(" ");
      switch (sub) {
        case "show":
          await showModes(ctx);
          break;
        case "clear":
          ctx.ui.setWidget("modes", undefined);
          break;
        case "use": {
          let id = rest;
          if (!id) {
            if (!hasUI(ctx)) return;
            const ids = [...new Set(["default", "full", ...scanModes(ctx.cwd)])];
            id = (await ctx.ui.select("切换到哪个模式?", ids)) ?? "";
            if (!id) return;
          }
          if (id !== "default" && id !== "full" && !scanModes(ctx.cwd).includes(id)) {
            ctx.ui.notify(`❌ 模式「${id}」不存在，/mode use 查看可用模式`, "error");
            return;
          }
          const msg = applyMode(pi, ctx, id);
          ctx.ui.notify(msg, msg.startsWith("❌") ? "error" : "info");
          break;
        }
        case "add":
          await cmdAddMode("", ctx);
          break;
        case "edit":
          await cmdEditMode(rest, ctx);
          break;
        case "del":
          await cmdDelMode(rest, ctx);
          break;
        case "init":
          await cmdInit("", ctx);
          break;
        case "cleanup":
          await cmdCleanup("", ctx);
          break;
        default:
          ctx.ui.notify(`❌ 未知子命令「${sub}」。可用：${MODE_SUBS.map((s) => s.value).join(" / ")}`, "error");
      }
    },
  });

  // ---------- /link：挂载管理入口 ----------
  pi.registerCommand("link", {
    description: "挂载管理：add/del/show/clear（/link 空格查看子命令）",
    getArgumentCompletions: (argumentText: string) =>
      subcommandCompletions(argumentText, LINK_SUBS, packageCompletions),
    handler: async (args, ctx) => {
      syncProjectTrust(ctx);
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const sub = tokens[0] ?? "show";
      const rest = tokens.slice(1).join(" ");
      switch (sub) {
        case "show":
          await showLinked(ctx);
          break;
        case "clear":
          ctx.ui.setWidget("linked", undefined);
          break;
        case "add":
          await cmdLink(rest, ctx);
          break;
        case "del":
          await cmdUnlink(rest, ctx);
          break;
        default:
          ctx.ui.notify(`❌ 未知子命令「${sub}」。可用：${LINK_SUBS.map((s) => s.value).join(" / ")}`, "error");
      }
    },
  });
}

const dummyTheme: any = {
  fg: (_c: string, s: string) => s,
  bold: (s: string) => s,
  dim: (s: string) => s,
  warning: (s: string) => s,
  accent: (s: string) => s,
  muted: (s: string) => s,
  success: (s: string) => s,
  text: (s: string) => s,
};
