// pi-mode-switcher 测试台 v2：strip TS → 替换 agentDir → mock pi/ctx → 跑断言
// 用法：npm test（node .testenv/harness.mjs）
import { stripTypeScriptTypes } from "node:module";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, cpSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(".testenv");
const PKG = join(ROOT, "pkg");
const AGENT = join(ROOT, "agent"); // 伪 ~/.pi/agent
const PROJECT = join(ROOT, "project");

// ---------- 0. 重建沙箱 ----------
for (const d of ["pkg", "agent", "project"]) rmSync(join(ROOT, d), { recursive: true, force: true });
mkdirSync(join(PKG, "lib"), { recursive: true });
mkdirSync(join(PKG, "extensions"), { recursive: true });
cpSync(resolve("templates"), join(PKG, "templates"), { recursive: true });
mkdirSync(join(AGENT, "modes"), { recursive: true });
mkdirSync(join(AGENT, "skills", "java-review"), { recursive: true });
mkdirSync(join(PROJECT, ".pi", "modes"), { recursive: true });
mkdirSync(join(AGENT, "npm", "node_modules", "pi-fake-pkg", "skills", "skill-a"), { recursive: true });
mkdirSync(join(AGENT, "npm", "node_modules", "pi-fake-pkg", "prompts"), { recursive: true });
mkdirSync(join(AGENT, "git", "github.com", "someone", "pi-git-pkg"), { recursive: true });
mkdirSync(join(AGENT, "npm", "node_modules", "@company", "scoped-pkg", "prompts"), { recursive: true });
mkdirSync(join(AGENT, "npm", "node_modules", "pi-path-pkg", "resources", "skills", "nested"), { recursive: true });
mkdirSync(join(AGENT, "npm", "node_modules", "pi-path-pkg", "templates"), { recursive: true });

// ---------- 1. strip TS 并改写 ----------
globalThis.__AGENT_ROOT__ = AGENT;
const strip = (src, from, to) =>
  stripTypeScriptTypes(src, { mode: "strip" }).replaceAll(from, to);
writeFileSync(
  join(PKG, "lib", "shared.mjs"),
  strip(readFileSync("lib/shared.ts", "utf8"),
    'import { CONFIG_DIR_NAME as PI_CONFIG_DIR_NAME, getAgentDir as piGetAgentDir } from "@earendil-works/pi-coding-agent";',
    'const PI_CONFIG_DIR_NAME = ".pi"; const piGetAgentDir = () => globalThis.__AGENT_ROOT__;')
    .replaceAll('import { homedir } from "node:os";\n', 'const homedir = () => process.env.HOME ?? process.env.USERPROFILE ?? "";\n'),
);
writeFileSync(
  join(PKG, "lib", "mode-runtime.mjs"),
  strip(readFileSync("lib/mode-runtime.ts", "utf8"), './shared.ts"', './shared.mjs"'),
);
for (const f of ["mode-switcher", "mode-manager"]) {
  writeFileSync(
    join(PKG, "extensions", `${f}.mjs`),
    strip(readFileSync(`extensions/${f}.ts`, "utf8"), '"../lib/shared.ts"', '"../lib/shared.mjs"')
      .replaceAll('"../lib/mode-runtime.ts"', '"../lib/mode-runtime.mjs"'),
  );
}
// 单一入口（package.json 显式指向包根 index.ts；模拟 pi 真实加载行为）
writeFileSync(
  join(PKG, "index.mjs"),
  strip(readFileSync("index.ts", "utf8"), '"./extensions/mode-manager.ts"', '"./extensions/mode-manager.mjs"')
    .replaceAll('"./extensions/mode-switcher.ts"', '"./extensions/mode-switcher.mjs"'),
);

// ---------- 2. fixtures ----------
const w = (p, o) => writeFileSync(p, typeof o === "string" ? o : JSON.stringify(o, null, 2));
writeFileSync(join(AGENT, "skills", "java-review", "SKILL.md"),
  "---\nname: java-review\ndescription: 检查代码规范\n---\n# Java Review\n完整的技能正文内容XYZ");
w(join(AGENT, "npm", "node_modules", "pi-fake-pkg", "package.json"), {
  name: "pi-fake-pkg", keywords: ["pi-package"],
  pi: { extensions: ["./index.ts"], skills: ["./skills"], prompts: ["./prompts/p.md"] },
});
w(join(AGENT, "npm", "node_modules", "pi-fake-pkg", "skills", "skill-a", "SKILL.md"),
  "---\nname: skill-a\ndescription: 来自包的技能\n---\n# Skill A");
w(join(AGENT, "npm", "node_modules", "pi-fake-pkg", "prompts", "p.md"), "提示模板内容");
w(join(AGENT, "git", "github.com", "someone", "pi-git-pkg", "package.json"), {
  name: "pi-git-pkg", keywords: ["pi-package"], pi: {},
});
w(join(AGENT, "npm", "node_modules", "@company", "scoped-pkg", "package.json"), {
  name: "@company/scoped-pkg", keywords: ["pi-package"],
  pi: { extensions: ["./index.ts"], prompts: ["./prompts"] },
});
w(join(AGENT, "npm", "node_modules", "@company", "scoped-pkg", "prompts", "guide.md"), "Scoped 包提示模板");
w(join(AGENT, "npm", "node_modules", "pi-path-pkg", "package.json"), {
  name: "pi-path-pkg", pi: { skills: ["./resources/skills/**/SKILL.md"], prompts: ["./templates/**/*.md"] },
});
w(join(AGENT, "npm", "node_modules", "pi-path-pkg", "resources", "skills", "nested", "SKILL.md"),
  "---\nname: nested-review\ndescription: 自定义路径技能\n---\n正文");
w(join(AGENT, "npm", "node_modules", "pi-path-pkg", "templates", "api.md"), "自定义路径提示");

const modesDir = join(AGENT, "modes");
const SKILL_JAVA = { scope: "global", name: "java-review" };
w(join(modesDir, "dev.json"), {
  name: "开发", inherit: "base", promptMode: "append",
  addTools: ["ls", "grep"], addSkills: [], packages: [], systemPrompt: "DEV_BASE_PROMPT",
});
w(join(modesDir, "base.json"), { name: "基础", inherit: null, addTools: ["bash"], systemPrompt: "BASE_PROMPT" });
w(join(modesDir, "java.json"), {
  name: "Java", inherit: "dev", promptMode: "append",
  addTools: ["web_search"], addSkills: [SKILL_JAVA], packages: [], systemPrompt: "JAVA_PROMPT",
});
w(join(modesDir, "cycle-a.json"), { name: "环A", inherit: "cycle-b" });
w(join(modesDir, "cycle-b.json"), { name: "环B", inherit: "cycle-a" });
w(join(modesDir, "orphan2.json"), { name: "孤儿继承", inherit: "nonexistent-parent", addTools: ["grep"], systemPrompt: "ORPHAN_PROMPT" });
// 旧格式（迁移测试）
w(join(modesDir, "legacy.json"), {
  name: "旧版", addSkills: ["java-review"], packages: ["pi-fake-pkg"], prompts: ["pi-fake-pkg/p.md"],
});
w(join(PROJECT, ".pi", "modes", "projmode.json"), {
  name: "项目模式", inherit: null, addTools: ["grep"], systemPrompt: "PROJ_PROMPT",
});

// ---------- 3. mock pi / ctx ----------
class MockPi {
  commands = new Map();
  handlers = new Map();
  entries = []; // 会话 custom entries（mode-state）
  tools = [
    { name: "read" }, { name: "write" }, { name: "edit" }, { name: "bash" },
    { name: "powershell" }, { name: "grep" }, { name: "find" }, { name: "ls" },
    { name: "web_search", sourceInfo: { source: "npm:pi-fake-pkg", origin: "package" } },
    { name: "fetch_content", sourceInfo: { source: "npm:pi-fake-pkg", origin: "package" } },
    { name: "git_tool", sourceInfo: { source: "git:github.com/someone/pi-git-pkg", origin: "package" } },
  ];
  activeTools = [];
  getAllTools = () => this.tools;
  getActiveTools = () => [...this.activeTools];
  setActiveTools = (names) => { this.activeTools = [...names]; };
  registerCommand = (name, def) => this.commands.set(name, def);
  getCommands = () => [...this.commands.keys()].map((name) => ({ name }));
  appendEntry = (customType, data) => {
    this.entries.push({ type: "custom", customType, data, timestamp: Date.now() });
  };
  on = (ev, fn) => {
    const list = this.handlers.get(ev) ?? [];
    list.push(fn);
    this.handlers.set(ev, list);
  };
  fire(ev, event, ctx) {
    return Promise.all((this.handlers.get(ev) ?? []).map((fn) => fn(event, ctx)));
  }
  async cmd(name, args, ctx) {
    const def = this.commands.get(name);
    if (!def) throw new Error(`命令 ${name} 未注册`);
    return await def.handler(args ?? "", ctx);
  }
  lastState() {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].customType === "mode-state") return this.entries[i].data.modeId;
    }
    return null;
  }
}

function makeCtx(pi, opts = {}) {
  const log = { notify: [], status: {}, widgets: {}, widgetComps: {}, answers: [] };
  const ui = {
    notify: (msg, level) => {
      log.notify.push({ msg, level });
      if (process.env.DEBUG_NOTIFY) console.log("    [notify]", String(msg).split("\n")[0]);
    },
    setStatus: (k, v) => { v === undefined ? delete log.status[k] : (log.status[k] = v); },
    setWidget: (k, v) => {
      if (v === undefined) { delete log.widgets[k]; return; }
      if (typeof v === "function") {
        // TUI 组件工厂（如 /modes、/linked）：用桩 theme 真实渲染，顺带覆盖组件路径
        try {
          const stubTheme = new Proxy({}, { get: (_t, p) => (...a) => (a.length ? String(a[a.length - 1]) : "") });
          const comp = v(null, stubTheme);
          log.widgetComps[k] = comp; // 保留组件引用，供活体面板测试重复 render
          log.widgets[k] = comp && typeof comp.render === "function" ? comp.render(80) : [String(comp)];
        } catch (e) {
          log.widgets[k] = [`<widget-render-failed: ${e.message}>`];
        }
        return;
      }
      log.widgets[k] = v;
    },
    select: async (title, items) => {
      const a = log.answers.shift();
      if (!a) return undefined;
      const found = items.find((it) => (a.exact ? it === a.match : it.startsWith(a.match)));
      return found ?? undefined;
    },
    confirm: async () => log.answers.shift()?.value ?? false,
    input: async (_t, ph) => log.answers.shift()?.value ?? ph ?? "",
    editor: async (_t, pre) => log.answers.shift()?.value ?? pre ?? "",
    custom: async () => undefined,
  };
  return {
    cwd: PROJECT, ui, log, hasUI: opts.hasUI ?? true,
    sessionManager: { getSessionId: () => "sess-1", getBranch: () => pi.entries },
    isProjectTrusted: () => opts.projectTrusted ?? true,
  };
}
const answer = (ctx, spec) => ctx.log.answers.push(spec);
const lastNotify = (ctx) => ctx.log.notify[ctx.log.notify.length - 1]?.msg ?? "";
const notifyAll = (ctx) => ctx.log.notify.map((n) => n.msg).join(" | ");
const DONE = { exact: true, match: "✅ 完成选择" };
const CANCEL = { exact: true, match: "❌ 取消" };

// ---------- 4. 断言器 ----------
let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra !== undefined ? ` — ${JSON.stringify(extra).slice(0, 240)}` : ""}`); }
};

// ---------- 5. 运行 ----------
// 通过单一入口 index.mjs 注册（对应 pi 只加载一个扩展）
const { default: run } = await import("file://" + join(PKG, "index.mjs").replaceAll("\\", "/"));
const shared = await import("file://" + join(PKG, "lib", "shared.mjs").replaceAll("\\", "/"));

const pi = new MockPi();
run(pi);
const ctx = makeCtx(pi);

// 模拟 Pi 0.84.4 在 before_agent_start 之前已构建好的系统提示词（含技能块）
const SYS_WITH_SKILLS = [
  "BASE_SYS", "",
  "The following skills provide specialized instructions for specific tasks.",
  "Use the read tool to load a skill's file when the task matches its description.",
  "",
  "<available_skills>",
  "  <skill>",
  "    <name>auto-skill-x</name>",
  "    <description>自动技能X</description>",
  "    <location>/tmp/auto-x/SKILL.md</location>",
  "  </skill>",
  "</available_skills>",
  "", "Current working directory: ...",
].join("\n");
const SKILL_MARKER = "The following skills provide specialized instructions";
const getSys = (ret, ev) => (ret ?? []).find((r) => r && r.systemPrompt !== undefined)?.systemPrompt ?? ev.systemPrompt;

console.log("\n== 启动（新会话 → 默认最小模式）==");
await pi.fire("session_start", { reason: "startup" }, ctx);
check("默认激活 8 个核心工具", pi.activeTools.join() === "read,write,edit,bash,powershell,grep,find,ls", pi.activeTools);
check("仅注册 /mode 与 /link 两个命令", pi.commands.size === 2 && pi.commands.has("mode") && pi.commands.has("link"), [...pi.commands.keys()]);
check("状态已写入会话 entry（default）", pi.lastState() === "default");

console.log("\n== 包扫描（Pi 官方规则，项目级优先）==");
const pkgs = shared.listInstalledPackages(PROJECT);
check("npm 包扫描到（source 为 npm: 前缀）", pkgs.some((p) => p.source === "npm:pi-fake-pkg"), pkgs.map((p) => p.source));
check("git 包 source 含完整路径", pkgs.some((p) => p.source === "git:github.com/someone/pi-git-pkg"), pkgs.map((p) => p.source));
check("scoped 包扫描到", pkgs.some((p) => p.source === "npm:@company/scoped-pkg"));
check("findPackageDir 项目级优先", !!shared.findPackageDir("npm:pi-fake-pkg", PROJECT));
check("版本化 npm source 定位到实际目录", !!shared.findPackageDir("npm:pi-fake-pkg@1.2.3", PROJECT));
check("inspectPackage 展开包内技能", shared.inspectPackage("npm:pi-fake-pkg", PROJECT).skills.includes("skill-a"));
check("inspectPackage 展开包内提示", shared.inspectPackage("npm:pi-fake-pkg", PROJECT).prompts.includes("p.md"));
const pathPkg = shared.inspectPackage("npm:pi-path-pkg", PROJECT);
check("manifest 自定义路径技能可定位", pathPkg.skills.includes("nested-review") && shared.resolveSkillPath({ scope: "package", package: "npm:pi-path-pkg", name: "nested-review" }, PROJECT)?.replaceAll("\\", "/").endsWith("resources/skills/nested/SKILL.md"));
check("manifest 自定义路径提示可定位", pathPkg.prompts.includes("api.md") && shared.resolvePackagePromptPath({ package: "npm:pi-path-pkg", name: "api.md" }, PROJECT)?.replaceAll("\\", "/").endsWith("templates/api.md"));
shared.runtime.projectTrusted = false;
check("不受信任项目不读取项目模式", shared.loadModeConfig("projmode", PROJECT) === null);
check("不受信任项目不扫描项目包", !shared.listInstalledPackages(PROJECT).some((p) => p.scope === "project"));
shared.runtime.projectTrusted = true;

console.log("\n== 旧格式迁移（读时兼容）==");
const legacyCfg = shared.loadModeConfig("legacy", PROJECT);
check("旧包引用迁移为 npm: 前缀", legacyCfg?.packages?.[0] === "npm:pi-fake-pkg", legacyCfg?.packages);
check("旧技能引用迁移为结构化全局引用", legacyCfg?.addSkills?.[0]?.scope === "global" && legacyCfg?.addSkills?.[0]?.name === "java-review", legacyCfg?.addSkills);
check("旧提示引用迁移为结构化包引用", legacyCfg?.prompts?.[0]?.package === "pi-fake-pkg", legacyCfg?.prompts);
check("标准化后 schemaVersion=2", legacyCfg?.schemaVersion === 2);

console.log("\n== /full（内置兜底：无 full.json）==");
rmSync(join(modesDir, "full.json"), { force: true });
await pi.cmd("mode", "use full", ctx);
check("无 full.json 时兜底可用", lastNotify(ctx).includes("全功能"), lastNotify(ctx));
check("full 激活全部已注册工具", pi.activeTools.includes("web_search") && pi.activeTools.includes("git_tool"), pi.activeTools);
check("页脚显示 full", (ctx.log.status.mode ?? "").includes("full"));
check("状态 entry 持久化 full", pi.lastState() === "full");
let ev = { systemPrompt: SYS_WITH_SKILLS };
let ret = await pi.fire("before_agent_start", ev, ctx);
check("full（空提示词）不修改系统提示词（保留全部技能）", getSys(ret, ev) === SYS_WITH_SKILLS);

console.log("\n== /init：生成 full.json（空 systemPrompt）==");
await pi.cmd("mode", "init", ctx);
check("/init 生成 full.json", existsSync(join(modesDir, "full.json")));
await pi.cmd("mode", "use full", ctx);
check("full.json 存在时正常切换", lastNotify(ctx).includes("全功能"), lastNotify(ctx));
// full 配置 systemPrompt 后应追加
w(join(modesDir, "full.json"), { name: "全功能", autoLoad: "all", systemPrompt: "FULL_PROMPT" });
await pi.cmd("mode", "use full", ctx);
ev = { systemPrompt: SYS_WITH_SKILLS };
ret = await pi.fire("before_agent_start", ev, ctx);
check("full 配置了 systemPrompt 时追加且保留技能块", getSys(ret, ev).includes("FULL_PROMPT") && getSys(ret, ev).includes("<available_skills>"));
// 还原为模板
cpSync(resolve("templates/modes/full.json"), join(modesDir, "full.json"));

console.log("\n== /default（剥离自动发现技能）==");
await pi.cmd("mode", "use default", ctx);
check("回落 8 工具", pi.activeTools.join() === "read,write,edit,bash,powershell,grep,find,ls");
ev = { systemPrompt: SYS_WITH_SKILLS };
ret = await pi.fire("before_agent_start", ev, ctx);
check("默认模式剥离技能块", !getSys(ret, ev).includes(SKILL_MARKER) && !getSys(ret, ev).includes("auto-skill-x"));
check("默认模式保留基础提示词", getSys(ret, ev).startsWith("BASE_SYS"));

console.log("\n== /java（继承 base→dev→java；append 提示词；渐进式技能）==");
await pi.cmd("mode", "use java", ctx);
check("切换成功", lastNotify(ctx).includes("Java"), lastNotify(ctx));
check("并集工具（核心8+dev+java，去重）", pi.activeTools.join() === "read,write,edit,bash,powershell,grep,find,ls,web_search", pi.activeTools);
ev = { systemPrompt: SYS_WITH_SKILLS };
ret = await pi.fire("before_agent_start", ev, ctx);
const sp = getSys(ret, ev);
check("append 语义：基础+父+子提示词", sp.startsWith("BASE_SYS") && sp.includes("DEV_BASE_PROMPT") && sp.includes("JAVA_PROMPT"), sp.slice(0, 120));
check("技能块只含模式技能（渐进式，不含全文）", sp.includes("java-review") && sp.includes("检查代码规范") && !sp.includes("完整的技能正文内容XYZ"), sp.slice(-300));
check("剥离了未挂载的自动发现技能", !sp.includes("auto-skill-x"));
check("技能条目含 location", sp.includes("SKILL.md"));

console.log("\n== 父模式缺失：警告但继续加载 ==");
await pi.cmd("mode", "use orphan2", ctx);
check("提示父模式缺失警告", lastNotify(ctx).includes("父模式"), lastNotify(ctx));
check("仍加载自身工具（核心8+额外）", pi.activeTools.join() === "read,write,edit,bash,powershell,grep,find,ls", pi.activeTools);

console.log("\n== /link：整包（owner 记录 + 当前模式即时生效）==");
await pi.cmd("mode", "use java", ctx); // 先切到 java，验证当前模式即时刷新
answer(ctx, { exact: true, match: "📦 整个包（全部资源）" });
answer(ctx, { exact: true, match: "java" });
await pi.cmd("link", "add pi-fake-pkg", ctx);
const javaCfg = shared.loadModeConfig("java", PROJECT);
check("整包写入 packages（完整 source）", javaCfg?.packages?.includes("npm:pi-fake-pkg"), javaCfg?.packages);
check("整包展开包内工具", javaCfg?.addTools?.includes("web_search") && javaCfg?.addTools?.includes("fetch_content"));
check("整包展开包内技能（结构化）", javaCfg?.addSkills?.some((s) => s.package === "npm:pi-fake-pkg" && s.name === "skill-a"), javaCfg?.addSkills);
check("整包展开包内提示（结构化）", javaCfg?.prompts?.some((p) => p.package === "npm:pi-fake-pkg" && p.name === "p.md"));
check("managedResources 记录来源", !!javaCfg?.managedResources?.["npm:pi-fake-pkg"]);
check("当前模式即时刷新（active tools 立即含包工具）", pi.activeTools.includes("fetch_content"), pi.activeTools);

console.log("\n== /link：单工具重复挂载冲突检测 ==");
answer(ctx, { exact: true, match: "🔧 web_search" });
answer(ctx, { exact: true, match: "java" });
await pi.cmd("link", "add pi-fake-pkg", ctx);
check("重复挂载提示冲突", lastNotify(ctx).includes("已由该包挂载"), lastNotify(ctx));

console.log("\n== /link：单技能挂载 ==");
answer(ctx, { exact: true, match: "🎯 skill-a" });
answer(ctx, { exact: true, match: "projmode" });
await pi.cmd("link", "add pi-fake-pkg", ctx);
const projCfg = shared.loadModeConfig("projmode", PROJECT);
check("单技能写入结构化引用", projCfg?.addSkills?.some((s) => s.name === "skill-a" && s.package === "npm:pi-fake-pkg"), projCfg?.addSkills);
check("资源 owner 记录在 managedResources", !!projCfg?.managedResources?.["npm:pi-fake-pkg"]?.skills);

console.log("\n== /unlink <pkg>（参数形式 + 级联清理；多模式挂载时选择目标）==");
answer(ctx, { exact: true, match: "java" }); // java 与 legacy 都挂载了该包，选择 java
await pi.cmd("link", "del pi-fake-pkg", ctx);
const javaAfterUnlink = shared.loadModeConfig("java", PROJECT);
check("整包移除 packages", !javaAfterUnlink?.packages?.includes("npm:pi-fake-pkg"));
check("级联移除包工具", !javaAfterUnlink?.addTools?.includes("fetch_content"));
check("保留手动工具（web_search 有 __manual__ 声明）", javaAfterUnlink?.addTools?.includes("web_search"), javaAfterUnlink?.addTools);
check("级联移除包技能", !javaAfterUnlink?.addSkills?.some((s) => s.name === "skill-a"));
check("级联移除包提示", !javaAfterUnlink?.prompts?.some((p) => p.name === "p.md"));
check("保留 java-review 技能", javaAfterUnlink?.addSkills?.some((s) => s.name === "java-review"));
check("继承工具不受影响（解析后含 ls/grep）", (() => { const m = shared.resolveMode("java", PROJECT); return m.config?.addTools?.includes("ls") && m.config?.addTools?.includes("grep"); })());
check("当前模式工具即时刷新（fetch_content 移除，web_search 保留）", !pi.activeTools.includes("fetch_content") && pi.activeTools.includes("web_search"), pi.activeTools);
check("projmode 的 skill-a 不受影响", shared.loadModeConfig("projmode", PROJECT)?.addSkills?.some((s) => s.name === "skill-a"));

console.log("\n== /addmode 完整流程（创建即注册命令）==");
answer(ctx, { value: "myweb" });
answer(ctx, { value: "My Web" });
answer(ctx, { match: "全局" });
answer(ctx, { exact: true, match: "无（独立模式）" });
answer(ctx, { match: "npm:pi-fake-pkg" });
answer(ctx, DONE); // 包多选
answer(ctx, DONE); // 工具多选（保持预勾）
answer(ctx, DONE); // 技能多选
answer(ctx, DONE); // 提示模板多选
answer(ctx, { value: "你是 Web 模式" });
await pi.cmd("mode", "add", ctx);
const myweb = shared.loadModeConfig("myweb", PROJECT);
check("addmode 创建成功", !!myweb);
check("预勾了包内工具", myweb?.addTools?.includes("web_search") && myweb?.addTools?.includes("fetch_content"));
check("包内技能自动预勾（结构化）", myweb?.addSkills?.some((s) => s.name === "skill-a"));
check("包内提示自动预勾（结构化）", myweb?.prompts?.some((p) => p.name === "p.md"));
check("addmode 同步写入包资源 owner", !!myweb?.managedResources?.["npm:pi-fake-pkg"]?.tools?.includes("web_search") && !!myweb?.managedResources?.["npm:pi-fake-pkg"]?.skills);
await pi.cmd("mode", "use myweb", ctx);
check("创建后 /mode use myweb 即可切换（无需 /reload）", pi.lastState() === "myweb");

console.log("\n== /addmode 取消与保留名拒绝 ==");
answer(ctx, { value: "nope" });
answer(ctx, { value: "Nope" });
answer(ctx, { match: "全局" });
answer(ctx, { exact: true, match: "无（独立模式）" });
answer(ctx, CANCEL);
await pi.cmd("mode", "add", ctx);
check("取消后未创建 nope", !shared.loadModeConfig("nope", PROJECT));
answer(ctx, { value: "full" });
await pi.cmd("mode", "add", ctx);
check("内置名 full 被拒绝", lastNotify(ctx).includes("内置模式"), lastNotify(ctx));
pi.registerCommand("occupied", { description: "第三方命令", handler: async () => {} });
answer(ctx, { value: "occupied" });
await pi.cmd("mode", "add", ctx);
check("已注册的第三方命令名被拒绝", !shared.loadModeConfig("occupied", PROJECT) && lastNotify(ctx).includes("重名"), lastNotify(ctx));

console.log("\n== 循环继承：警告但继续加载 ==");
await pi.cmd("mode", "use cycle-a", ctx);
check("循环继承警告", lastNotify(ctx).includes("循环继承"), lastNotify(ctx));
check("仍加载自身（核心8工具）", pi.activeTools.join() === "read,write,edit,bash,powershell,grep,find,ls");

console.log("\n== /delmode：同名作用域选择（项目级删除，全局恢复）==");
cpSync(join(modesDir, "java.json"), join(PROJECT, ".pi", "modes", "java.json"));
answer(ctx, { match: "删除当前项目级模式" });
answer(ctx, { value: true }); // 确认删除
await pi.cmd("mode", "del java", ctx);
check("项目级文件已删除", !existsSync(join(PROJECT, ".pi", "modes", "java.json")));
check("全局模式保留（自动恢复可用）", existsSync(join(modesDir, "java.json")));

console.log("\n== /delmode：删除父模式顺延 + 当前模式回落 ==");
await pi.cmd("mode", "use dev", ctx); // 切到 dev
check("dev 激活（含继承 ls/grep）", pi.activeTools.includes("ls") && pi.activeTools.includes("grep"));
answer(ctx, { value: true });
await pi.cmd("mode", "del dev", ctx);
check("子模式 java 顺延到祖父 base", shared.loadModeConfig("java", PROJECT)?.inherit === "base");
check("dev 文件已删除", !existsSync(join(modesDir, "dev.json")));
check("当前回落默认（状态）", pi.lastState() === "default");
check("当前回落默认（工具）", pi.activeTools.join() === "read,write,edit,bash,powershell,grep,find,ls");

console.log("\n== /cleanup：孤儿包引用及 managed 资源清理 ==");
w(join(modesDir, "ghost.json"), {
  name: "幽灵", inherit: null, packages: ["npm:ghost-pkg"],
  addTools: ["ghost_tool"], prompts: [{ package: "npm:ghost-pkg", name: "g.md" }],
  managedResources: { "npm:ghost-pkg": { tools: ["ghost_tool"], prompts: [{ package: "npm:ghost-pkg", name: "g.md" }] } },
});
check("检测到 ghost-pkg 孤儿", Object.keys(shared.getOrphanPackages(shared.scanModes(PROJECT), PROJECT)).includes("ghost"));
answer(ctx, { value: true });
await pi.cmd("mode", "cleanup", ctx);
const ghostAfter = shared.loadModeConfig("ghost", PROJECT);
check("cleanup 清理包引用", !ghostAfter?.packages?.includes("npm:ghost-pkg"));
check("cleanup 级联清理包管理的工具", !ghostAfter?.addTools?.includes("ghost_tool"));
check("cleanup 级联清理包管理的提示", !ghostAfter?.prompts?.some((p) => p.name === "g.md"));
rmSync(join(modesDir, "ghost.json"));

console.log("\n== 非法/损坏模式文件容错 ==");
w(join(modesDir, "My_Mode.json"), { name: "非法名" });
w(join(modesDir, "bad.json"), "{oops");
const scan2 = shared.scanModeFiles(PROJECT);
check("非法文件名跳过并诊断", scan2.diagnostics.some((d) => d.includes("My_Mode")), scan2.diagnostics);
check("非法文件名不进入模式列表", !shared.scanModes(PROJECT).includes("My_Mode") && !shared.scanModes(PROJECT).includes("my-mode"));
check("坏 JSON 文件标记 broken 且无配置", shared.loadMode("bad", PROJECT).broken === true && shared.loadModeConfig("bad", PROJECT) === null);
await pi.cmd("mode", "show", ctx);
const modesText = JSON.stringify(ctx.log.widgets.modes);
check("/modes 显示诊断摘要（页脚，折叠后仍可见）", modesText.includes("条诊断"), modesText.slice(-160));

console.log("\n== /modes：虚拟内置模式 + 递归继承树 + 有效统计 ==");
check("面板含虚拟 default", modesText.includes("default"));
check("面板含虚拟 full", modesText.includes("full"));
check("面板含递归树标记", modesText.includes("└─") || modesText.includes("├─"));
check("面板含有效统计（工具/技能/包）", modesText.includes("工具") && modesText.includes("技能"));
await pi.cmd("mode", "clear", ctx);
check("modes clear 关闭面板", ctx.log.widgets.modes === undefined);

console.log("\n== /fork：继承原会话模式 ==");
const forkFile = join(ROOT, "fork-session.jsonl");
w(forkFile, JSON.stringify({ type: "custom", customType: "mode-state", data: { modeId: "java" } }) + "\n");
await pi.fire("session_start", { reason: "fork", previousSessionFile: forkFile }, ctx);
check("fork 后恢复 java 模式", pi.lastState() === "java" && pi.activeTools.includes("web_search"), pi.activeTools);

console.log("\n== 当前模式配置失效 → 回落默认 ==");
w(join(modesDir, "java.json"), "{broken");
await pi.cmd("mode", "use java", ctx);
check("配置损坏时提示并回落默认", lastNotify(ctx).includes("❌") && pi.lastState() === "default", lastNotify(ctx));
await pi.cmd("mode", "use myweb", ctx);
w(join(modesDir, "java.json"), "{broken");
await pi.cmd("mode", "use java", ctx);
check("非当前失效模式不会重置当前模式", pi.lastState() === "myweb" && pi.activeTools.includes("web_search"), pi.activeTools);
w(join(modesDir, "java.json"), { name: "Java", inherit: "base", addTools: ["web_search"], addSkills: [SKILL_JAVA], systemPrompt: "JAVA_PROMPT" });

console.log("\n== 非 TUI 模式拒绝管理命令 ==");
const ctxNoUI = makeCtx(pi, { hasUI: false });
await pi.cmd("mode", "add", ctxNoUI);
check("非交互模式拒绝 /mode add", lastNotify(ctxNoUI).includes("交互式"), lastNotify(ctxNoUI));
await pi.cmd("link", "add", ctxNoUI);
check("非交互模式拒绝 /link add", lastNotify(ctxNoUI).includes("交互式"));

console.log("\n== /editmode：保存立即生效 + 循环拒绝 ==");
await pi.cmd("mode", "use myweb", ctx);
answer(ctx, { value: "My Web V2" });
answer(ctx, { exact: true, match: "无（独立模式）" });
answer(ctx, { exact: true, match: "保持当前位置" });
answer(ctx, DONE); // 包
answer(ctx, DONE); // 工具
answer(ctx, DONE); // 技能
answer(ctx, DONE); // 提示模板
answer(ctx, { value: "你是 Web 模式 V2" });
await pi.cmd("mode", "edit myweb", ctx);
check("editmode 保存成功", lastNotify(ctx).includes("已保存"), lastNotify(ctx));
ev = { systemPrompt: SYS_WITH_SKILLS };
ret = await pi.fire("before_agent_start", ev, ctx);
check("当前模式立即使用新提示词", getSys(ret, ev).includes("你是 Web 模式 V2"));

// 直接成环：cycle-a 的父改为 cycle-b（cycle-b 的祖先链含 cycle-a）
answer(ctx, { value: "环A" });
answer(ctx, { exact: true, match: "cycle-b" });
await pi.cmd("mode", "edit cycle-a", ctx);
check("直接成环的编辑被拒绝", lastNotify(ctx).includes("循环继承"), lastNotify(ctx));
// 间接成环：parent1 → myweb，再把 myweb 的父改为 parent1
w(join(modesDir, "parent1.json"), { name: "P1", inherit: "myweb", addTools: [] });
answer(ctx, { value: "My Web" });
answer(ctx, { exact: true, match: "parent1" });
await pi.cmd("mode", "edit myweb", ctx);
check("间接成环的编辑被拒绝（myweb 未被改）",
  shared.loadModeConfig("myweb", PROJECT)?.name === "My Web V2",
  shared.loadModeConfig("myweb", PROJECT)?.name);
rmSync(join(modesDir, "parent1.json"));

console.log("\n== /editmode：位置迁移（项目级→全局，目标存在需确认）==");
answer(ctx, { value: "项目模式改名" });
answer(ctx, { exact: true, match: "无（独立模式）" });
answer(ctx, { exact: true, match: "移到全局" });
answer(ctx, DONE);
answer(ctx, DONE);
answer(ctx, DONE);
// 提示模板步骤：projmode 无包提示，步骤跳过
answer(ctx, { value: "PROJ_PROMPT_V2" });
await pi.cmd("mode", "edit projmode", ctx);
check("迁移后全局文件存在", existsSync(join(modesDir, "projmode.json")));
check("旧项目级文件已移除", !existsSync(join(PROJECT, ".pi", "modes", "projmode.json")));
check("内容已保存", shared.loadModeConfig("projmode", PROJECT)?.systemPrompt === "PROJ_PROMPT_V2");

console.log("\n== /linked 面板 ==");
await pi.cmd("link", "show", ctx);
check("linked widget 已设置", typeof ctx.log.widgets.linked === "object");
await pi.cmd("link", "clear", ctx);
check("linked clear 关闭面板", ctx.log.widgets.linked === undefined);

console.log("\n== 子命令补全（getArgumentCompletions，两级的换整体替换）==");
const modeCmd = pi.commands.get("mode");
const linkCmd = pi.commands.get("link");
check("mode/link 注册了参数补全", typeof modeCmd?.getArgumentCompletions === "function" && typeof linkCmd?.getArgumentCompletions === "function");
let c = modeCmd.getArgumentCompletions("");
check("空参数 → 全部子命令（含描述）", c?.length === 8 && c.every((i) => i.value && i.description), c?.map((i) => i.value));
c = modeCmd.getArgumentCompletions("ad");
check("前缀过滤（ad → add）", c?.length === 1 && c[0].value === "add", c);
check("不匹配前缀 → null", modeCmd.getArgumentCompletions("xyz") === null);
c = modeCmd.getArgumentCompletions("use ");
check("use 尾随空格 → 模式 id 候选", c?.some((i) => i.value === "use default") && c?.some((i) => i.value === "use java") && c?.some((i) => i.value === "use full"), c?.map((i) => i.value));
check("full 不重复（内置 + full.json 去重）", c?.filter((i) => i.value === "use full").length === 1, c?.map((i) => i.value));
c = modeCmd.getArgumentCompletions("use ja");
check("use 二级前缀过滤（value 整体替换）", c?.length === 1 && c[0].value === "use java" && !!c[0].description, c);
c = modeCmd.getArgumentCompletions("del ");
check("del 候选含 full 不含 default", c?.some((i) => i.value === "del full") && !c?.some((i) => i.value === "del default"), c?.map((i) => i.value));
check("show 无二级候选 → null", modeCmd.getArgumentCompletions("show ") === null);
check("未知子命令 → null", modeCmd.getArgumentCompletions("foo ") === null);
c = linkCmd.getArgumentCompletions("add ");
check("link add 候选含已安装包与 scope 描述", c?.some((i) => i.value === "add npm:pi-fake-pkg" && i.description.includes("pi-fake-pkg")), c);
c = linkCmd.getArgumentCompletions("del ");
check("link del 只列已挂载包（含挂载点描述）", c?.some((i) => i.value === "del npm:pi-fake-pkg" && /legacy|projmode/.test(i.description ?? "")) === true && !c?.some((i) => i.value === "del npm:pi-path-pkg"), c);
check("link 未知二级 → null", linkCmd.getArgumentCompletions("show ") === null);
{
  const savedCwd = shared.runtime.cwd;
  shared.runtime.cwd = ""; // proxy 无 deleteProperty 陷阱，用空串模拟未缓存
  check("无 cwd 时补全静默降级为 null", modeCmd.getArgumentCompletions("use ") === null && linkCmd.getArgumentCompletions("add ") === null);
  shared.runtime.cwd = savedCwd;
}

console.log("\n== resources_discover：提示模板贡献（结构化定位）==");
await pi.cmd("mode", "use myweb", ctx);
const disc = await pi.fire("resources_discover", { cwd: PROJECT }, ctx);
check("定位到包内模板文件", disc[0]?.promptPaths?.[0]?.endsWith(join("pi-fake-pkg", "prompts", "p.md")), disc[0]);

console.log("\n== 实时面板（活体 widget，无需重开 /modes）==");
await pi.cmd("mode", "show", ctx);
const comp = ctx.log.widgetComps.modes;
check("modes 活体组件已捕获", !!comp && typeof comp.render === "function");
const liveLines0 = comp.render(80).join("\n");
check("初始面板渲染（含 default 行）", liveLines0.includes("默认（最小）"), liveLines0.split("\n")[0]);

// ① 外部新增模式文件（fingerprint 路径：模拟手改/addmode 写盘；
//    aa- 前缀保证字母序最前，折叠后仍在可见区）
w(join(modesDir, "aalivetest.json"), { name: "实时测试", systemPrompt: "" });
const liveLines1 = comp.render(80).join("\n");
check("新增模式实时出现在面板", /○ aalivetest/.test(liveLines1), liveLines1.split("\n").slice(0, 3).join(" | "));

// ② 进程内切换模式（applyMode → rev++）→ 页脚当前模式实时更新
const preFooter = comp.render(80).join("\n");
await pi.cmd("mode", "use projmode", ctx);
const liveLines2 = comp.render(80).join("\n");
check("切换模式后面板实时重采（页脚当前模式更新）",
  preFooter.includes("当前: myweb") && liveLines2.includes("当前: projmode"),
  { pre: preFooter.split("\n").pop(), post: liveLines2.split("\n").pop() });

// ③ 外部删除 → 实时消失
rmSync(join(modesDir, "aalivetest.json"));
const liveLines3 = comp.render(80).join("\n");
check("删除模式实时从面板消失", !liveLines3.includes("aalivetest"));

// ④ /linked 活体面板：saveModeConfig（rev）后实时反映；
//    aafresh 字母序最前，折叠后仍在可见区
w(join(modesDir, "aafresh.json"), { name: "新鲜", inherit: null, addTools: ["unique_tool_x"], systemPrompt: "" });
await pi.cmd("link", "show", ctx);
const lcomp = ctx.log.widgetComps.linked;
check("linked 活体组件已捕获", !!lcomp && typeof lcomp.render === "function");
const lb = lcomp.render(80).join("\n");
const lcfg = shared.loadModeConfig("aafresh", PROJECT);
lcfg.addTools = [];
shared.saveModeConfig("aafresh", PROJECT, lcfg);
const la = lcomp.render(80).join("\n");
check("saveModeConfig 后 linked 面板实时更新", lb.includes("unique_tool_x") && !la.includes("unique_tool_x"),
  { before: lb.includes("unique_tool_x"), after: la.includes("unique_tool_x") });
rmSync(join(modesDir, "aafresh.json"));

// ④b 整包挂载折叠显示：只显示 📦（整包），不展开包内技能/工具明细
const lc2 = lcomp.render(80).join("\n");
check("整包挂载折叠为一行", lc2.includes("（整包）"), lc2.split("\n").find((l) => l.includes("📦")));
check("整包内明细不再重复展开", !lc2.includes("🎯 skill-a"), lc2.split("\n").filter((l) => l.includes("skill-a")));

// ⑤ 跨模块实例共享（模拟 pi 为每个扩展创建独立 jiti 实例：同 URL 加 ?isolate=1 得到新模块实例）
const shared2 = await import("file://" + join(PKG, "lib", "shared.mjs").replaceAll("\\", "/") + "?isolate=1");
check("跨模块实例 runtime.rev 可见（globalThis）", shared2.runtime.rev === shared.runtime.rev,
  { a: shared.runtime.rev, b: shared2.runtime.rev });
shared2.bumpRuntimeRev();
check("另一实例 bumpRuntimeRev 对本实例可见", shared.runtime.rev === shared2.runtime.rev);
shared2.runtime.currentMode = "from-other-instance";
check("跨实例 runtime.currentMode 共享", shared.runtime.currentMode === "from-other-instance");
shared.runtime.currentMode = null;

// ⑥ 切换模式后面板实时重采（rev 路径，applyMode 在另一模块实例中也生效；用页脚断言）
await pi.cmd("mode", "use java", ctx);
const liveLines4 = comp.render(80).join("\n");
check("applyMode（跨实例）后面板实时更新", liveLines4.includes("当前: java"), liveLines4.split("\n").pop());

// ⑦ delmode 后同名重建（残留动态命令放行）
answer(ctx, { value: true }); // 确认删除
await pi.cmd("mode", "del java", ctx);
check("java.json 已删除", !existsSync(join(modesDir, "java.json")));
answer(ctx, { value: "java" });            // ① 标识
answer(ctx, { value: "Java Reborn" });     // ② 显示名
answer(ctx, { match: "全局" });             // ③ 位置（startsWith 匹配）
answer(ctx, { exact: true, match: "无（独立模式）" }); // ④ 父模式
answer(ctx, DONE); // ⑤ 包：直接完成（全不选）
answer(ctx, DONE); // ⑦ 工具
answer(ctx, DONE); // ⑧ 技能
answer(ctx, { value: "REBORN_PROMPT" });   // ⑩ 提示词
answer(ctx, { value: true }); // 空模式警告确认
await pi.cmd("mode", "add", ctx);
const notifyMark = ctx.log.notify.length;
check("同名重建未被残留命令拦截", existsSync(join(modesDir, "java.json")) && shared.loadModeConfig("java", PROJECT)?.systemPrompt === "REBORN_PROMPT",
  shared.loadModeConfig("java", PROJECT));
check("无“与已有命令重名”报错", !ctx.log.notify.slice(notifyMark).some((n) => String(n.msg).includes("重名")));
await pi.cmd("mode", "use java", ctx);
check("重建后 /mode use java 可切换", pi.lastState() === "java");

// ⑧ 高面板折叠（超过 pi 的 MAX_WIDGET_LINES=10 时保留首尾，避免终端重绘错乱）
for (let i = 0; i < 9; i++) w(join(modesDir, `fold${i}.json`), { name: `F${i}`, inherit: null, addTools: [`t${i}`], systemPrompt: "" });
await pi.cmd("link", "show", ctx);
const tcomp = ctx.log.widgetComps.linked;
const tlines = tcomp.render(80);
check("超高面板折叠到 10 行", tlines.length === 10, tlines.length);
check("折叠提示含剩余行数", tlines.some((l) => l.includes("还有")), tlines);
check("折叠后保留末行", tlines[tlines.length - 1].length > 0);
for (let i = 0; i < 9; i++) rmSync(join(modesDir, `fold${i}.json`));

// ⑨ 自适应终端高度：rows=40 → 上限 28 行，19 行面板完整展示（不折叠）；rows=15 → 压缩到 4 行
for (let i = 0; i < 9; i++) w(join(modesDir, `fold${i}.json`), { name: `F${i}`, inherit: null, addTools: [`t${i}`], systemPrompt: "" });
let linkedFactory = null;
const origSetWidget = ctx.ui.setWidget;
ctx.ui.setWidget = (k, v) => { if (k === "linked" && typeof v === "function") linkedFactory = v; origSetWidget(k, v); };
await pi.cmd("link", "show", ctx);
ctx.ui.setWidget = origSetWidget;
check("捕获 linked 工厂函数", typeof linkedFactory === "function");
const stubTheme2 = new Proxy({}, { get: (_t, p) => (...a) => (a.length ? String(a[a.length - 1]) : "") });
const bigTerm = linkedFactory({ terminal: { rows: 60 } }, stubTheme2).render(80);
check("大终端完全展示（无折叠标记）", !bigTerm.some((l) => l.includes("还有")), bigTerm.length);
const smallTerm = linkedFactory({ terminal: { rows: 15 } }, stubTheme2).render(80);
check("小终端压缩到预留预算内", smallTerm.length === 4, smallTerm.length);
for (let i = 0; i < 9; i++) rmSync(join(modesDir, `fold${i}.json`));

console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail > 0 ? 1 : 0);
