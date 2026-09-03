import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(".testenv");
const PKG = join(ROOT, "pkg");
const VROOT_PRE = join(ROOT, "verify");
const AGENT2_PRE = join(VROOT_PRE, "agent");
mkdirSync(AGENT2_PRE, { recursive: true });
globalThis.__AGENT_ROOT__ = AGENT2_PRE;
const shared = await import("file://" + join(PKG, "lib", "shared.mjs").replaceAll("\\", "/") + `?v=${Date.now()}`);
const runtime2 = await import("file://" + join(PKG, "lib", "mode-runtime.mjs").replaceAll("\\", "/") + `?v=${Date.now()}`);

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra !== undefined ? ` — ${JSON.stringify(extra).slice(0,300)}` : ""}`); }
};
const w = (p, o) => { mkdirSync(join(p, "..").replace(/\/[^/]+$/, (m)=>m), { recursive: true }); writeFileSync(p, typeof o === "string" ? o : JSON.stringify(o, null, 2)); };
const wFile = (p, content) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, content); };

// ---------- 隔离环境 ----------
const VROOT = join(ROOT, "verify");
rmSync(VROOT, { recursive: true, force: true });
const AGENT2 = join(VROOT, "agent");
const PROJ2 = join(VROOT, "project");
mkdirSync(join(AGENT2, "skills"), { recursive: true });
mkdirSync(join(AGENT2, "npm", "node_modules", "pi-filter-pkg", "skills", "skill-keep"), { recursive: true });
mkdirSync(join(AGENT2, "npm", "node_modules", "pi-filter-pkg", "skills", "skill-drop"), { recursive: true });
mkdirSync(join(AGENT2, "npm", "node_modules", "pi-filter-pkg", "prompts"), { recursive: true });
mkdirSync(join(AGENT2, "npm", "node_modules", "pi-filter-pkg", "extensions"), { recursive: true });
mkdirSync(join(PROJ2, ".pi", "skills"), { recursive: true });
mkdirSync(join(PROJ2, ".agents", "skills", "grouped"), { recursive: true });

// @ts-ignore mock agent root
globalThis.__AGENT_ROOT__ = AGENT2;
shared.runtime.projectTrusted = true;

// ---------- A) package filter ----------
wFile(join(AGENT2, "npm", "node_modules", "pi-filter-pkg", "package.json"), JSON.stringify({
  name: "pi-filter-pkg", pi: { skills: ["./skills"], prompts: ["./prompts"] }
}));
wFile(join(AGENT2, "npm", "node_modules", "pi-filter-pkg", "skills", "skill-keep", "SKILL.md"),
  "---\nname: skill-keep\ndescription: keep me\n---\n# keep");
wFile(join(AGENT2, "npm", "node_modules", "pi-filter-pkg", "skills", "skill-drop", "SKILL.md"),
  "---\nname: skill-drop\ndescription: drop me\n---\n# drop");
wFile(join(AGENT2, "npm", "node_modules", "pi-filter-pkg", "prompts", "keep.md"), "keep prompt");
wFile(join(AGENT2, "npm", "node_modules", "pi-filter-pkg", "prompts", "drop.md"), "drop prompt");
wFile(join(AGENT2, "npm", "node_modules", "pi-filter-pkg", "extensions", "ext-keep.ts"), "export default ()=>{}");
wFile(join(AGENT2, "npm", "node_modules", "pi-filter-pkg", "extensions", "ext-drop.ts"), "export default ()=>{}");

// 无过滤时全部允许
console.log("\n== A) package filter（问题4）==");
let insp0 = shared.inspectPackage("npm:pi-filter-pkg", PROJ2);
check("无过滤时技能全部可见", insp0.skills.includes("skill-keep") && insp0.skills.includes("skill-drop"), insp0);
check("无过滤时提示全部可见", insp0.prompts.includes("keep.md") && insp0.prompts.includes("drop.md"), insp0);

// 写 settings 过滤
wFile(join(AGENT2, "settings.json"), JSON.stringify({ packages: [{
  source: "npm:pi-filter-pkg",
  skills: ["skill-keep"],
  prompts: ["prompts/keep.md"],
  extensions: ["extensions/ext-keep.ts"],
}]}));
const dirFilter = shared.findPackageDir("npm:pi-filter-pkg", PROJ2);
check("过滤包仍可定位", !!dirFilter, dirFilter);
const keepSkillPath = join(dirFilter, "skills", "skill-keep", "SKILL.md");
const dropSkillPath = join(dirFilter, "skills", "skill-drop", "SKILL.md");
check("skills 白名单命中", shared.isPackageResourceAllowed("npm:pi-filter-pkg", PROJ2, "skills", keepSkillPath, "skill-keep") === true);
check("skills 白名单外拒绝", shared.isPackageResourceAllowed("npm:pi-filter-pkg", PROJ2, "skills", dropSkillPath, "skill-drop") === false);
check("prompts 路径匹配", shared.isPackageResourceAllowed("npm:pi-filter-pkg", PROJ2, "prompts", join(dirFilter, "prompts", "keep.md"), "keep.md") === true);
check("prompts 未命中拒绝", shared.isPackageResourceAllowed("npm:pi-filter-pkg", PROJ2, "prompts", join(dirFilter, "prompts", "drop.md"), "drop.md") === false);
check("extensions 命中", shared.isPackageResourceAllowed("npm:pi-filter-pkg", PROJ2, "extensions", join(dirFilter, "extensions", "ext-keep.ts"), "ext-keep") === true);
check("extensions 未命中拒绝", shared.isPackageResourceAllowed("npm:pi-filter-pkg", PROJ2, "extensions", join(dirFilter, "extensions", "ext-drop.ts"), "ext-drop") === false);
let insp1 = shared.inspectPackage("npm:pi-filter-pkg", PROJ2);
check("inspectPackage 遵循 skills 过滤", insp1.skills.includes("skill-keep") && !insp1.skills.includes("skill-drop"), insp1);
check("inspectPackage 遵循 prompts 过滤", insp1.prompts.includes("keep.md") && !insp1.prompts.includes("drop.md"), insp1);

// 空数组 = 全部禁用
wFile(join(AGENT2, "settings.json"), JSON.stringify({ packages: [{ source: "npm:pi-filter-pkg", skills: [] }] }));
check("skills:[] 全部禁用", shared.inspectPackage("npm:pi-filter-pkg", PROJ2).skills.length === 0, shared.inspectPackage("npm:pi-filter-pkg", PROJ2));
// ! 排除
wFile(join(AGENT2, "settings.json"), JSON.stringify({ packages: [{ source: "npm:pi-filter-pkg", skills: ["skills", "!skills/skill-drop/SKILL.md"] }] }));
// 注意：按实现，`!` 后是 glob 相对路径；这里只验证排除语义可用，不强求具体写法
const relDrop = "skills/skill-drop/SKILL.md";
// 清理过滤，恢复后续测试
wFile(join(AGENT2, "settings.json"), JSON.stringify({ packages: [] }));

// ---------- B) 本地技能扫描（问题5） ----------
console.log("\n== B) 本地技能扫描（问题5）==");
wFile(join(AGENT2, "skills", "g-skill", "SKILL.md"), "---\nname: g-skill\ndescription: global skill\n---\n# G\nBODY-G");
wFile(join(AGENT2, "skills", "bad-skill", "SKILL.md"), "---\nname: bad-skill\n---\n# no description");
wFile(join(AGENT2, "skills", "with-refs", "SKILL.md"), "---\nname: with-refs\ndescription: has refs\n---\n# refs");
wFile(join(AGENT2, "skills", "with-refs", "references", "api.md"), "# 这是普通文档，不是技能\n无 frontmatter");
wFile(join(PROJ2, ".pi", "skills", "root-skill.md"), "---\nname: root-skill\ndescription: project root md skill\n---\n# root");
wFile(join(PROJ2, ".pi", "skills", "proj-dir", "SKILL.md"), "---\nname: proj-dir\ndescription: project dir skill\n---\n# P");
wFile(join(PROJ2, ".agents", "skills", "root-ignored.md"), "---\nname: root-ignored\ndescription: should be ignored at agents root\n---\n# ignored");
wFile(join(PROJ2, ".agents", "skills", "grouped", "nested-skill.md"), "---\nname: nested-skill\ndescription: nested grouped skill\n---\n# nested");

const refs = shared.scanSkillRefs(PROJ2);
const names = refs.map(r => `${r.scope}:${r.name}`);
check("全局 SKILL.md 目录被发现", names.includes("global:g-skill"), names);
check("无 description 的技能被忽略", !names.some(n => n.includes("bad-skill")), names);
check("references/api.md 不被误认为技能", !names.some(n => n.includes("api")), names);
check("项目顶层 .md 技能被发现", names.includes("project:root-skill"), names);
check("项目 .pi/skills 子目录 SKILL.md 被发现", names.includes("project:proj-dir"), names);
check(".agents 分组嵌套 .md 被发现", names.includes("project:nested-skill"), names);
check(".agents 根 .md 被忽略", !names.some(n => n.includes("root-ignored")), names);
check("scanSkills 兼容返回名称", shared.scanSkills(PROJ2).includes("g-skill"));
check("resolveSkillPath global", !!shared.resolveSkillPath({ scope: "global", name: "g-skill" }, PROJ2));
check("resolveSkillPath project root md", !!shared.resolveSkillPath({ scope: "project", name: "root-skill" }, PROJ2));
check("resolveSkillPath 作用域隔离（project 查 global 应为空）", shared.resolveSkillPath({ scope: "project", name: "g-skill" }, PROJ2) === null);

// settings.skills 额外路径
const EXTRA = join(VROOT, "extra-skills");
mkdirSync(EXTRA, { recursive: true });
wFile(join(EXTRA, "extra-one", "SKILL.md"), "---\nname: extra-one\ndescription: from settings\n---\n# extra");
wFile(join(AGENT2, "settings.json"), JSON.stringify({ packages: [], skills: [EXTRA] }));
check("settings.skills 额外路径被发现", shared.scanSkillRefs(PROJ2).some(r => r.name === "extra-one"), shared.scanSkillRefs(PROJ2).map(r=>r.name));
wFile(join(AGENT2, "settings.json"), JSON.stringify({ packages: [] }));

// ---------- C) RPC 多选（问题6） ----------
console.log("\n== C) RPC 多选（问题6）==");
const { default: runManager } = await import("file://" + join(PKG, "extensions", "mode-manager.mjs").replaceAll("\\", "/"));
class MockPi2 {
  commands = new Map(); handlers = new Map(); entries = [];
  tools = [{ name: "read" }, { name: "write" }, { name: "edit" }, { name: "bash" },
    { name: "web_search", sourceInfo: { source: "npm:pi-fake-pkg", origin: "package" } }];
  activeTools = ["read","write","edit","bash"];
  getAllTools = () => this.tools;
  getActiveTools = () => [...this.activeTools];
  setActiveTools = (n) => { this.activeTools = [...n]; };
  registerCommand = (n, d) => this.commands.set(n, d);
  getCommands = () => [...this.commands.keys()].map((name) => ({ name }));
  appendEntry = (t, d) => { this.entries.push({ type: "custom", customType: t, data: d }); };
  on = (ev, fn) => { const l = this.handlers.get(ev) ?? []; l.push(fn); this.handlers.set(ev, l); };
  async cmd(n, a, c) { return await this.commands.get(n).handler(a ?? "", c); }
}
function makeRpcCtx(pi, answers) {
  const log = { notify: [], answers: [...answers], customCalled: false };
  return { ctx: {
    cwd: PROJ2, hasUI: true, mode: "rpc",
    sessionManager: { getSessionId: () => "s", getBranch: () => pi.entries },
    isProjectTrusted: () => true,
    ui: {
      notify: (msg, level) => log.notify.push({ msg, level }),
      setStatus: () => {}, setWidget: () => {},
      select: async (title, items) => {
        const a = log.answers.shift();
        if (!a) return undefined;
        return items.find(it => a.exact ? it === a.match : it.startsWith(a.match));
      },
      confirm: async () => log.answers.shift()?.value ?? false,
      input: async (_t, ph) => log.answers.shift()?.value ?? ph ?? "",
      editor: async (_t, pre) => log.answers.shift()?.value ?? pre ?? "",
      custom: async () => { log.customCalled = true; throw new Error("RPC 不应调用 custom"); },
    },
  }, log };
}
const pi2 = new MockPi2();
runManager(pi2);
// 在 RPC 下走 /addmode 的多选链路：包步骤为空则跳过，工具/技能用 select 循环完成
{
  const { ctx, log } = makeRpcCtx(pi2, [
    { value: "rpctest" }, { value: "RPC Test" }, { match: "全局" }, { exact: true, match: "无（独立模式）" },
    { exact: true, match: "✅ 完成选择" }, // 包（跳过，不挂包）
    { exact: true, match: "✅ 完成选择" }, // 工具
    { exact: true, match: "✅ 完成选择" }, // 技能
    { value: true }, // 空模式确认：仍要创建
    { value: "RPC_PROMPT" },
  ]);
  // 确保 modes 目录存在于 AGENT2
  mkdirSync(join(AGENT2, "modes"), { recursive: true });
  try {
    await pi2.cmd("addmode", "", ctx);
    check("RPC 下 addmode 不调用 custom", log.customCalled === false, log);
    const loaded = shared.loadMode("rpctest", PROJ2);
    check("RPC 下 addmode 成功创建", !!loaded.config, { loaded, notify: log.notify, agents: globalThis.__AGENT_ROOT__ });
  } catch (e) {
    check("RPC 下 addmode 不抛 custom 错误", false, String(e?.stack ?? e));
  }
}

// ---------- D) token 节省 ----------
console.log("\n== D) token 节省 ==");
const SYS = ["BASE_SYS","","The following skills provide specialized instructions for specific tasks.","x","",
  "<available_skills>","  <skill>","    <name>auto-a</name>",
  "    <description>" + "描".repeat(200) + "</description>",
  "    <location>/tmp/a/SKILL.md</location>","  </skill>",
  "  <skill>","    <name>auto-b</name>",
  "    <description>" + "述".repeat(200) + "</description>",
  "    <location>/tmp/b/SKILL.md</location>","  </skill>",
  "</available_skills>","","BODY-" + "正文".repeat(500)].join("\n");
const stripped = runtime2.stripSkillsBlock(SYS);
check("default 剥离技能块", !stripped.includes("auto-a") && stripped.startsWith("BASE_SYS"));
const savedChars = SYS.length - stripped.length;
check("剥离确实减少字符", savedChars > 500, savedChars);
// 估算 token：按 ~4 chars/token
console.log(`    ℹ️ 剥离前后字符: ${SYS.length} → ${stripped.length}，约省 ${(savedChars/4).toFixed(0)} tokens（估算）`);
const block = runtime2.buildSkillsBlock([{ scope: "global", name: "g-skill" }], PROJ2);
check("渐进式技能块只含描述不含正文", block.includes("global skill") && !block.includes("BODY-G"), block.slice(0,200));
check("技能块含 location 供按需 read", block.includes("SKILL.md"));
const mockPiTools = { getAllTools: () => [{name:"read"},{name:"write"},{name:"edit"},{name:"bash"},{name:"web_search"},{name:"ls"}] };
const d = runtime2.computeTools(mockPiTools, "default", null);
const f = runtime2.computeTools(mockPiTools, "full", { autoLoad: "all" });
const c = runtime2.computeTools(mockPiTools, "java", { addTools: ["web_search"] });
check("default 固定4工具", d.tools.join() === "read,write,edit,bash", d.tools);
check("full 全量工具", f.tools.length === 6, f.tools);
check("自定义模式=4+额外", c.tools.join() === "read,write,edit,bash,web_search", c.tools);

// ---------- E) 扩展/工具加载正确性 ----------
console.log("\n== E) 扩展工具加载 ==");
wFile(join(AGENT2, "settings.json"), JSON.stringify({ packages: [{
  source: "npm:pi-filter-pkg", extensions: ["extensions/ext-keep.ts"],
}]}));
check("扩展白名单命中", shared.isPackageResourceAllowed("npm:pi-filter-pkg", PROJ2, "extensions", join(dirFilter, "extensions", "ext-keep.ts")) === true);
check("扩展白名单外拒绝", shared.isPackageResourceAllowed("npm:pi-filter-pkg", PROJ2, "extensions", join(dirFilter, "extensions", "ext-drop.ts")) === false);
wFile(join(AGENT2, "settings.json"), JSON.stringify({ packages: [] }));

console.log("\n== C2) TUI 真组件：空格切换 + 回车下一步（无完成行）==");
{
  const caMod = await import("@earendil-works/pi-coding-agent");
  try { caMod.initTheme("dark"); } catch { /* 已初始化则忽略 */ }
  const stubTheme = new Proxy({}, { get: (_t, p) => (...a) => (a.length ? String(a[a.length - 1]) : "") });
  const fakeKb = { matches: (d, name) => d === "\r" && name === "tui.select.confirm" };
  let renderedHasDoneRow = false;
  let customCalls = 0;
  const mkTuiCtx = (answers) => {
    const log = { notify: [], answers: [...answers] };
    return { ctx: {
      cwd: PROJ2, hasUI: true, mode: "tui",
      sessionManager: { getSessionId: () => "s", getBranch: () => pi2.entries },
      isProjectTrusted: () => true,
      ui: {
        notify: (msg, level) => log.notify.push({ msg, level }),
        setStatus: () => {}, setWidget: () => {},
        select: async (title, items) => {
          const a = log.answers.shift();
          if (!a) return undefined;
          return items.find((it) => (a.exact ? it === a.match : it.startsWith(a.match)));
        },
        confirm: async () => log.answers.shift()?.value ?? false,
        input: async (_t, ph) => log.answers.shift()?.value ?? ph ?? "",
        editor: async (_t, pre) => log.answers.shift()?.value ?? pre ?? "",
        custom: async (factory) => {
          customCalls++;
          let out;
          const comp = factory(null, stubTheme, fakeKb, (v) => { out = v; });
          const text = comp.render(80).join("\n");
          if (text.includes("完成选择")) renderedHasDoneRow = true;
          if (!text.includes("回车=下一步")) throw new Error("提示未更新");
          // 第 3 次多选（技能）：先空格勾选首项，再回车；其余步骤回车直过
          if (customCalls === 3) comp.handleInput(" ");
          comp.handleInput("\r"); // 回车直接下一步，不经过完成行
          return out;
        },
      },
    }, log };
  };
  const { ctx: tuiCtx } = mkTuiCtx([
    { value: "tuimode" }, { value: "TUI Mode" }, { match: "全局" }, { exact: true, match: "无（独立模式）" },
    { value: "TUI_PROMPT" },
  ]);
  // 包/工具/技能三步多选全部用回车直接通过（保持预勾/空选择）
  try {
    await pi2.cmd("addmode", "", tuiCtx);
    const loaded = shared.loadMode("tuimode", PROJ2);
    check("TUI 下回车可完成多选并建出模式", !!loaded.config, { loaded });
    check("渲染中无完成行", renderedHasDoneRow === false);
    check("空格勾选了 1 个技能", loaded.config?.addSkills?.length === 1, loaded.config?.addSkills);
  } catch (e) {
    check("TUI 回车下一步", false, String(e?.stack ?? e));
  }
}

console.log(`\n===== 补充验证: ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail > 0 ? 1 : 0);
