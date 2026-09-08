// pi-mode-switcher 共享工具（配置 schema v2）
// 供 mode-switcher.ts / mode-manager.ts / mode-runtime.ts 共用
//
// 设计要点（经确认的 60 项决策）：
// - 模式配置为插件自有格式，schemaVersion 2；读取时兼容旧格式（字符串资源引用）
// - 包使用完整 Pi source（npm:xxx / git:host/path / 本地路径）作为唯一标识
// - 技能/提示模板使用结构化引用 { scope, package, name }
// - 包扫描遵循 Pi 官方规则（pi manifest 或约定目录），项目级优先于全局级
// - 字段类型错误逐字段容错；JSON 语法错误整个文件跳过
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, basename, resolve, sep } from "node:path";
import { CONFIG_DIR_NAME as PI_CONFIG_DIR_NAME, getAgentDir as piGetAgentDir } from "@earendil-works/pi-coding-agent";

// ---------- 路径 ----------
// 使用 Pi 的实际配置路径，兼容 piConfig.configDir 和 PI_CODING_AGENT_DIR。
export const agentDir = piGetAgentDir();
export const CONFIG_DIR_NAME = PI_CONFIG_DIR_NAME;
export const globalModesDir = join(agentDir, "modes");
export const skillsDir = join(agentDir, "skills");
export const globalSettingsFile = join(agentDir, "settings.json");

// 内置保留名（模式 id 不再映射为命令，仅 full 作为可编辑的内置模式保留）
export const RESERVED = ["full"];

// 默认内置工具集（所有模式固定启用，不写入模式配置）
export const DEFAULT_TOOLS = ["read", "write", "edit", "bash", "powershell", "grep", "find", "ls"];

// 模式命令标识规则：小写字母/数字，单个连字符分段
export const MODE_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// 进程内运行时状态（当前模式 id；/modes 高亮、before_agent_start 使用）
// ⚠️ pi 为每个扩展文件创建独立的 jiti 实例（moduleCache:false），模块级对象跨扩展不共享；
// 必须挂在 globalThis 上（与 mode-runtime 的 ModeBridge 同一模式），
// 否则 applyMode（mode-switcher 侧）bump 的 rev，/modes 面板（mode-manager 侧）永远看不到。
interface RuntimeState {
  currentMode: string | null;
  rev: number;
  projectTrusted: boolean;
  /** 当前 cwd（session_start / 命令 handler 缓存），供无 ctx 的 getArgumentCompletions 使用 */
  cwd?: string;
}
const RUNTIME_KEY = "__piModeSwitcherRuntime";
function globalRuntime(): RuntimeState {
  const g = globalThis as any;
  if (!g[RUNTIME_KEY]) g[RUNTIME_KEY] = { currentMode: null, rev: 0, projectTrusted: true };
  return g[RUNTIME_KEY] as RuntimeState;
}
export const runtime = new Proxy({ currentMode: null, rev: 0, projectTrusted: true } as RuntimeState, {
  get: (_t, key) => Reflect.get(globalRuntime(), key),
  set: (_t, key, value) => {
    Reflect.set(globalRuntime(), key, value);
    return true;
  },
});

/** 面板实时刷新：变更命令与 applyMode 成功后调用。 */
export function bumpRuntimeRev(): void {
  runtime.rev++;
}

// ---------- 资源引用类型 ----------
export interface SkillRef {
  scope: "package" | "global" | "project";
  package?: string; // 完整 Pi source，scope=package 时必填
  name: string;
}
export interface PromptRef {
  package?: string; // 完整 Pi source
  name: string;
}
export interface ManagedPackageResources {
  tools?: string[];
  skills?: SkillRef[];
  prompts?: PromptRef[];
}
export interface ManagedResources {
  [source: string]: ManagedPackageResources;
}

// ---------- 模式配置类型 ----------
export interface ModeConfig {
  schemaVersion?: number;
  name?: string;
  inherit?: string | null;
  promptMode?: "append" | "override";
  addTools?: string[];
  addSkills?: SkillRef[];
  packages?: string[];
  prompts?: PromptRef[];
  systemPrompt?: string;
  autoLoad?: "all";
  managedResources?: ManagedResources;
}

export interface LoadResult {
  config: ModeConfig | null;
  warnings: string[];
  broken: boolean; // JSON 语法错误或文件不可读
}

// ---------- JSON ----------
export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

export function writeJson(file: string, data: unknown): boolean {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
    return true;
  } catch {
    return false;
  }
}

// ---------- schema v2 标准化 + 旧格式迁移 ----------
function normStringArray(v: unknown, warn: (m: string) => void, field: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    warn(`${field} 类型错误（应为数组），已忽略`);
    return [];
  }
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string" || !x.trim()) {
      warn(`${field} 中存在非法条目，已跳过`);
      continue;
    }
    out.push(x.trim());
  }
  return [...new Set(out)];
}

function normSkillRef(x: unknown, warn: (m: string) => void): SkillRef | null {
  if (typeof x === "string") {
    // 旧格式：裸名称 → 按本地/全局技能处理
    warn(`旧版技能引用「${x}」没有包来源，已按本地/全局技能处理`);
    return { scope: "global", name: x };
  }
  if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    if (typeof o.name !== "string" || !o.name) {
      warn("技能引用缺少 name，已跳过");
      return null;
    }
    if (typeof o.package === "string" && o.package) {
      return { scope: "package", package: o.package, name: o.name };
    }
    const scope = o.scope === "project" ? "project" : "global";
    return { scope, name: o.name };
  }
  warn("技能引用格式非法，已跳过");
  return null;
}

function normPromptRef(x: unknown, warn: (m: string) => void): PromptRef | null {
  if (typeof x === "string") {
    // 旧格式："pkg/name" → 尝试解析包名
    const slash = x.indexOf("/");
    if (slash > 0) {
      const pkg = x.slice(0, slash);
      const name = x.slice(slash + 1);
      warn(`旧版提示模板引用「${x}」已转换为包引用（包：${pkg}）`);
      return { package: pkg, name };
    }
    warn(`旧版提示模板引用「${x}」没有包来源，已跳过`);
    return null;
  }
  if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    if (typeof o.name !== "string" || !o.name) {
      warn("提示模板引用缺少 name，已跳过");
      return null;
    }
    return {
      package: typeof o.package === "string" && o.package ? o.package : undefined,
      name: o.name,
    };
  }
  warn("提示模板引用格式非法，已跳过");
  return null;
}

function sameRef(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function dedupeRefs<T>(arr: T[]): T[] {
  const out: T[] = [];
  for (const x of arr) if (!out.some((y) => sameRef(x, y))) out.push(x);
  return out;
}

/** 把任意原始对象标准化为 schema v2 配置（逐字段容错）。 */
export function normalizeMode(raw: unknown): { config: ModeConfig; warnings: string[] } {
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const config: ModeConfig = { schemaVersion: 2 };

  if (typeof o.name === "string" && o.name.trim()) config.name = o.name.trim();
  else if (o.name !== undefined) warn("name 类型错误，已忽略");

  if (o.inherit === null) config.inherit = null;
  else if (typeof o.inherit === "string" && o.inherit) config.inherit = o.inherit;
  else if (o.inherit !== undefined) warn("inherit 类型错误，已忽略");

  if (o.promptMode === "append" || o.promptMode === "override") config.promptMode = o.promptMode;
  else if (o.promptMode !== undefined) warn("promptMode 非法（应为 append/override），已忽略");

  config.addTools = normStringArray(o.addTools, warn, "addTools");

  if (o.addSkills === undefined || o.addSkills === null) config.addSkills = [];
  else if (Array.isArray(o.addSkills)) {
    const refs: SkillRef[] = [];
    for (const x of o.addSkills) {
      const r = normSkillRef(x, warn);
      if (r) refs.push(r);
    }
    config.addSkills = dedupeRefs(refs);
  } else {
    warn("addSkills 类型错误（应为数组），已忽略");
    config.addSkills = [];
  }

  if (o.packages === undefined || o.packages === null) config.packages = [];
  else if (Array.isArray(o.packages)) {
    const pkgs: string[] = [];
    for (const x of o.packages) {
      if (typeof x !== "string" || !x.trim()) {
        warn("packages 中存在非法条目，已跳过");
        continue;
      }
      const s = x.trim();
      // 旧格式：裸包名 → 视作 npm 包
      if (!s.includes(":") && !s.includes("/") && !s.includes("\\")) {
        warn(`旧版包引用「${s}」已转换为 npm:${s}`);
        pkgs.push(`npm:${s}`);
      } else {
        pkgs.push(s);
      }
    }
    config.packages = [...new Set(pkgs)];
  } else {
    warn("packages 类型错误（应为数组），已忽略");
    config.packages = [];
  }

  if (o.prompts === undefined || o.prompts === null) config.prompts = [];
  else if (Array.isArray(o.prompts)) {
    const refs: PromptRef[] = [];
    for (const x of o.prompts) {
      const r = normPromptRef(x, warn);
      if (r) refs.push(r);
    }
    config.prompts = dedupeRefs(refs);
  } else {
    warn("prompts 类型错误（应为数组），已忽略");
    config.prompts = [];
  }

  if (typeof o.systemPrompt === "string") config.systemPrompt = o.systemPrompt;
  else if (o.systemPrompt !== undefined) warn("systemPrompt 类型错误，已忽略");

  if (o.autoLoad === "all") config.autoLoad = "all";
  else if (o.autoLoad !== undefined) warn("autoLoad 非法（应为 \"all\"），已忽略");

  if (o.managedResources && typeof o.managedResources === "object") {
    const mr: ManagedResources = {};
    for (const [pkg, v] of Object.entries(o.managedResources as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue;
      const vo = v as Record<string, unknown>;
      const entry: ManagedPackageResources = {};
      const tools = normStringArray(vo.tools, warn, `managedResources.${pkg}.tools`);
      if (tools.length) entry.tools = tools;
      if (Array.isArray(vo.skills)) {
        const refs: SkillRef[] = [];
        for (const x of vo.skills) {
          const r = normSkillRef(x, warn);
          if (r) refs.push(r);
        }
        if (refs.length) entry.skills = dedupeRefs(refs);
      }
      if (Array.isArray(vo.prompts)) {
        const refs: PromptRef[] = [];
        for (const x of vo.prompts) {
          const r = normPromptRef(x, warn);
          if (r) refs.push(r);
        }
        if (refs.length) entry.prompts = dedupeRefs(refs);
      }
      mr[pkg] = entry;
    }
    config.managedResources = mr;
  }

  return { config, warnings };
}

// ---------- 模式文件扫描 ----------
export interface ModeFile {
  id: string;
  location: "global" | "project";
  path: string;
}
export interface ScanModesResult {
  modes: ModeFile[];
  diagnostics: string[];
  nested: string[];
}

export function projectModesDir(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, "modes");
}

export function projectSkillsDir(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, "skills");
}

function validateModeId(id: string): string | null {
  if (!MODE_ID_RE.test(id)) return `标识「${id}」格式非法（需小写字母/数字，单连字符分段）`;
  if (id === "default") return "default 是虚拟内置模式，其文件会被忽略";
  return null;
}

/** 扫描顶层模式文件（嵌套目录视为无效，单独报告）。 */
export function scanModeFiles(cwd: string): ScanModesResult {
  const modes: ModeFile[] = [];
  const diagnostics: string[] = [];
  const nested: string[] = [];
  const seen = new Map<string, "global" | "project">();
  const dirs: Array<{ dir: string; location: "global" | "project" }> = [
    { dir: globalModesDir, location: "global" },
    ...(runtime.projectTrusted ? [{ dir: projectModesDir(cwd), location: "project" as const }] : []),
  ];
  for (const { dir, location } of dirs) {
    if (!existsSync(dir)) continue;
    // 嵌套文件警告
    const walk = (d: string, label: string) => {
      for (const f of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, f.name);
        if (f.isDirectory()) walk(p, `${label}${f.name}/`);
        else if (f.name.endsWith(".json")) nested.push(`${location === "global" ? "" : "项目/"}modes/${label}${f.name}`);
      }
    };
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      if (f.isDirectory()) walk(join(dir, f.name), `${f.name}/`);
      else if (f.isFile() && f.name.endsWith(".json")) {
        const id = f.name.slice(0, -5);
        const err = validateModeId(id);
        if (err) {
          diagnostics.push(`${location === "global" ? "" : "项目/"}modes/${f.name}：${err}`);
          continue;
        }
        // 项目级覆盖全局（同名时两者都保留，加载时项目优先）
        modes.push({ id, location, path: join(dir, f.name) });
        if (!seen.has(id)) seen.set(id, location);
      }
    }
  }
  return { modes, diagnostics, nested };
}

/** 兼容旧调用：返回去重后的模式 id 列表。 */
export function scanModes(cwd: string): string[] {
  return [...new Set(scanModeFiles(cwd).modes.map((m) => m.id))];
}

/** 嵌套的无效模式文件（不会被注册为命令）。 */
export function scanNestedModeFiles(cwd: string): string[] {
  return scanModeFiles(cwd).nested;
}

export function modeLocation(id: string, cwd: string): "global" | "project" | null {
  if (runtime.projectTrusted && existsSync(join(projectModesDir(cwd), `${id}.json`))) return "project";
  if (existsSync(join(globalModesDir, `${id}.json`))) return "global";
  return null;
}

/** 加载模式配置（项目级优先），标准化为 v2 并收集警告。 */
export function loadMode(id: string, cwd: string): LoadResult {
  const projectPath = join(projectModesDir(cwd), `${id}.json`);
  const globalPath = join(globalModesDir, `${id}.json`);
  const path = runtime.projectTrusted && existsSync(projectPath)
    ? projectPath
    : existsSync(globalPath) ? globalPath : null;
  if (!path) return { config: null, warnings: [], broken: false };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return { config: null, warnings: [], broken: true };
  }
  const { config, warnings } = normalizeMode(raw);
  if (!config.name) config.name = id;
  return { config, warnings, broken: false };
}

/** 兼容旧调用。 */
export function loadModeConfig(id: string, cwd: string): ModeConfig | null {
  return loadMode(id, cwd).config;
}

/** 保存模式配置（标准化为 v2 后写回原位：项目级优先）。保存后 bump rev 驱动面板实时刷新。 */
export function saveModeConfig(id: string, cwd: string, config: ModeConfig): boolean {
  const projectPath = join(projectModesDir(cwd), `${id}.json`);
  const { config: normalized } = normalizeMode(config);
  normalized.schemaVersion = 2;
  if (!normalized.name) normalized.name = id;
  const ok = existsSync(projectPath) ? writeJson(projectPath, normalized) : writeJson(join(globalModesDir, `${id}.json`), normalized);
  if (ok) bumpRuntimeRev();
  return ok;
}

// ---------- 继承解析 ----------
export interface ResolvedMode {
  config: ModeConfig | null;
  warnings: string[];
  cycle: boolean;
  missingParent: string | null;
}

function mergeSkillRefs(a: SkillRef[] = [], b: SkillRef[] = []): SkillRef[] {
  return dedupeRefs([...a, ...b]);
}
function mergePromptRefs(a: PromptRef[] = [], b: PromptRef[] = []): PromptRef[] {
  return dedupeRefs([...a, ...b]);
}

/** 合并父模式与子模式（并集语义；提示词按 promptMode 处理）。 */
export function mergeModes(parent: ModeConfig, child: ModeConfig): ModeConfig {
  const promptMode = child.promptMode ?? parent.promptMode ?? "override";
  const systemPrompt = promptMode === "append"
    ? [parent.systemPrompt, child.systemPrompt].filter((x) => typeof x === "string" && x.length > 0).join("\n\n")
    : (child.systemPrompt ?? parent.systemPrompt ?? "");
  const managed: ManagedResources = { ...(parent.managedResources ?? {}) };
  for (const [pkg, v] of Object.entries(child.managedResources ?? {})) {
    const prev = managed[pkg] ?? {};
    managed[pkg] = {
      tools: [...new Set([...(prev.tools ?? []), ...(v.tools ?? [])])],
      skills: mergeSkillRefs(prev.skills ?? [], v.skills ?? []),
      prompts: mergePromptRefs(prev.prompts ?? [], v.prompts ?? []),
    };
  }
  return {
    schemaVersion: 2,
    name: child.name ?? parent.name,
    // mergeModes 的结果表示最终子配置；显式 null 必须切断继承。
    inherit: child.inherit !== undefined ? child.inherit : parent.inherit,
    promptMode,
    addTools: [...new Set([...(parent.addTools ?? []), ...(child.addTools ?? [])])],
    addSkills: mergeSkillRefs(parent.addSkills ?? [], child.addSkills ?? []),
    packages: [...new Set([...(parent.packages ?? []), ...(child.packages ?? [])])],
    prompts: mergePromptRefs(parent.prompts ?? [], child.prompts ?? []),
    systemPrompt,
    autoLoad: child.autoLoad ?? parent.autoLoad,
    managedResources: managed,
  };
}

/**
 * 解析继承链（迭代，防循环）。
 * - 父模式缺失 → 记录 missingParent，链到此为止（当前模式仍可用）
 * - 循环继承 → cycle=true，忽略造成循环的继承关系
 * - inherit: "default" → 虚拟根，链自然结束（无警告）
 */
export function resolveMode(id: string, cwd: string): ResolvedMode {
  const warnings: string[] = [];
  const chain: ModeConfig[] = [];
  const seen = new Set<string>();
  let cur: string | null = id;
  let cycle = false;
  let missingParent: string | null = null;
  while (cur) {
    if (seen.has(cur)) {
      cycle = true;
      warnings.push(`检测到循环继承（涉及 ${cur}），已忽略造成循环的继承关系`);
      break;
    }
    seen.add(cur);
    if (cur !== id) {
      const r = loadMode(cur, cwd);
      if (r.broken) {
        missingParent = cur;
        warnings.push(`父模式「${cur}」配置损坏，已忽略继承关系`);
        break;
      }
      if (!r.config) {
        if (cur !== "default") {
          missingParent = cur;
          warnings.push(`父模式「${cur}」不存在，已忽略继承关系`);
        }
        break;
      }
      for (const w of r.warnings) warnings.push(`（${cur}）${w}`);
      chain.push(r.config);
      cur = typeof r.config.inherit === "string" && r.config.inherit ? r.config.inherit : null;
      continue;
    }
    // 当前模式自身
    const r = loadMode(cur, cwd);
    if (r.broken) {
      return { config: null, warnings: [`模式「${id}」配置损坏`], cycle: false, missingParent: null };
    }
    if (!r.config) return { config: null, warnings: [], cycle: false, missingParent: null };
    for (const w of r.warnings) warnings.push(w);
    chain.push(r.config);
    cur = typeof r.config.inherit === "string" && r.config.inherit ? r.config.inherit : null;
  }
  if (chain.length === 0) return { config: null, warnings, cycle, missingParent };
  let merged: ModeConfig | null = null;
  for (const c of [...chain].reverse()) merged = merged ? mergeModes(merged, c) : { ...c };
  return { config: merged, warnings, cycle, missingParent };
}

// ---------- 包扫描（遵循 Pi 官方规则） ----------
export interface PackageSettingsEntry {
  source: string;
  autoload?: boolean;
  extensions?: unknown;
  skills?: unknown;
  prompts?: unknown;
  themes?: unknown;
}

export interface InstalledPackage {
  source: string; // npm:xxx / git:host/path / 本地绝对路径
  name: string; // package.json name 或目录名
  dir: string;
  scope: "global" | "project";
  /** Pi settings 中针对该包的资源过滤配置（若存在）。 */
  settings?: PackageSettingsEntry;
}

function hasPiManifest(dir: string): boolean {
  const pkg = readJson<Record<string, unknown>>(join(dir, "package.json"));
  if (!pkg) return false;
  if (pkg.pi && typeof pkg.pi === "object") return true;
  // Pi 官方约定目录
  for (const d of ["extensions", "skills", "prompts", "themes"]) {
    if (existsSync(join(dir, d))) return true;
  }
  return false;
}

function packageJsonName(dir: string): string | null {
  const pkg = readJson<{ name?: string }>(join(dir, "package.json"));
  return typeof pkg?.name === "string" && pkg.name ? pkg.name : null;
}

function readSettingsPackageEntries(file: string): PackageSettingsEntry[] {
  const j = readJson<{ packages?: unknown }>(file);
  const arr = j?.packages;
  if (!Array.isArray(arr)) return [];
  const out: PackageSettingsEntry[] = [];
  for (const p of arr) {
    if (typeof p === "string" && p.trim()) {
      out.push({ source: p.trim() });
    } else if (p && typeof p === "object" && typeof (p as any).source === "string" && (p as any).source.trim()) {
      const o = p as Record<string, unknown>;
      out.push({
        source: (o.source as string).trim(),
        autoload: typeof o.autoload === "boolean" ? o.autoload : undefined,
        extensions: o.extensions,
        skills: o.skills,
        prompts: o.prompts,
        themes: o.themes,
      });
    }
  }
  return out;
}

function readSettingsPackages(file: string): string[] {
  return readSettingsPackageEntries(file).map((x) => x.source);
}

function packageSourceIdentity(source: string): string {
  const s = source.replaceAll("\\", "/").trim();
  if (s.startsWith("npm:")) {
    const name = s.slice(4).match(/^(@[^/]+\/[^@]+|[^@/]+)(?:@.*)?$/)?.[1];
    return name ? `npm:${name}` : s;
  }
  if (s.startsWith("git:")) return s.replace(/@[^/]+$/, "");
  return s;
}

/** 项目 settings 优先；autoload:false 时按 Pi 规则作为全局配置的增量覆盖。 */
function packageSettingsFor(source: string, cwd: string): PackageSettingsEntry | undefined {
  const identity = packageSourceIdentity(source);
  const project = runtime.projectTrusted
    ? readSettingsPackageEntries(join(cwd, CONFIG_DIR_NAME, "settings.json"))
        .find((x) => packageSourceIdentity(x.source) === identity)
    : undefined;
  const global = readSettingsPackageEntries(globalSettingsFile)
    .find((x) => packageSourceIdentity(x.source) === identity);
  if (!project) return global;
  if (project.autoload === false && global) {
    return { ...global, ...project,
      extensions: project.extensions ?? global.extensions,
      skills: project.skills ?? global.skills,
      prompts: project.prompts ?? global.prompts,
      themes: project.themes ?? global.themes,
    };
  }
  return project;
}

function npmDirToSource(base: string, dir: string): string | null {
  const rel = dir.slice(base.length + 1).split(sep).join("/");
  return rel ? `npm:${rel}` : null;
}

function walkPiPackages(nodeModulesDir: string, scope: "global" | "project", out: Map<string, InstalledPackage>) {
  const base = nodeModulesDir; // source 相对 node_modules 计算
  if (!existsSync(nodeModulesDir)) return;
  for (const f of readdirSync(nodeModulesDir, { withFileTypes: true })) {
    if (f.name.startsWith(".")) continue;
    const p = join(nodeModulesDir, f.name);
    if (f.name.startsWith("@") && f.isDirectory()) {
      for (const sub of readdirSync(p, { withFileTypes: true })) {
        if (sub.name.startsWith(".")) continue;
        const sp = join(p, sub.name);
        if (!hasPiManifest(sp)) continue;
        const source = npmDirToSource(base, sp);
        if (source && !out.has(source)) {
          out.set(source, { source, name: packageJsonName(sp) ?? `${f.name}/${sub.name}`, dir: sp, scope });
        }
      }
    } else if (f.isDirectory()) {
      if (!hasPiManifest(p)) continue;
      const source = npmDirToSource(base, p);
      if (source && !out.has(source)) {
        out.set(source, { source, name: packageJsonName(p) ?? f.name, dir: p, scope });
      }
    }
  }
}

function walkGitPackages(root: string, scope: "global" | "project", out: Map<string, InstalledPackage>, relBase = "", depth = 0) {
  if (depth > 4 || !existsSync(root)) return;
  for (const f of readdirSync(root, { withFileTypes: true })) {
    if (!f.isDirectory() || f.name.startsWith(".") || f.name === "node_modules") continue;
    const p = join(root, f.name);
    if (hasPiManifest(p)) {
      const rel = relBase ? `${relBase}/${f.name}` : f.name;
      const source = `git:${rel}`;
      if (!out.has(source)) {
        out.set(source, { source, name: packageJsonName(p) ?? f.name, dir: p, scope });
      }
    } else {
      walkGitPackages(p, scope, out, relBase ? `${relBase}/${f.name}` : f.name, depth + 1);
    }
  }
}

/**
 * 列出所有已安装的 Pi 包（settings 声明 + 目录扫描）。
 * 项目级优先：同名包（按 name）项目条目排在全局条目之前。
 */
export function listInstalledPackages(cwd: string): InstalledPackage[] {
  const out = new Map<string, InstalledPackage>();
  // settings 声明（项目在前）
  const projectSources = runtime.projectTrusted
    ? readSettingsPackages(join(cwd, CONFIG_DIR_NAME, "settings.json"))
    : [];
  const globalSources = readSettingsPackages(globalSettingsFile);
  for (const source of projectSources) {
    const dir = resolveSourceDir(source, cwd, "project");
    if (dir && hasPiManifest(dir) && !out.has(source)) {
      out.set(source, { source, name: packageJsonName(dir) ?? basename(source), dir, scope: "project",
        settings: readSettingsPackageEntries(join(cwd, CONFIG_DIR_NAME, "settings.json"))
          .find((x) => packageSourceIdentity(x.source) === packageSourceIdentity(source)) });
    }
  }
  for (const source of globalSources) {
    const dir = resolveSourceDir(source, cwd, "global");
    if (dir && hasPiManifest(dir) && !out.has(source)) {
      out.set(source, { source, name: packageJsonName(dir) ?? basename(source), dir, scope: "global",
        settings: readSettingsPackageEntries(globalSettingsFile)
          .find((x) => packageSourceIdentity(x.source) === packageSourceIdentity(source)) });
    }
  }
  // 目录扫描兜底（项目在前）
  if (runtime.projectTrusted) {
    walkPiPackages(join(cwd, CONFIG_DIR_NAME, "npm", "node_modules"), "project", out);
    walkGitPackages(join(cwd, CONFIG_DIR_NAME, "git"), "project", out);
  }
  walkPiPackages(join(agentDir, "npm", "node_modules"), "global", out);
  walkGitPackages(join(agentDir, "git"), "global", out);
  // 排除插件自身
  const list = [...out.values()].filter((p) => p.name !== "pi-mode-switcher" && p.source !== "pi-mode-switcher");
  // 按 name 去重：项目级优先
  const byName = new Set<string>();
  const result: InstalledPackage[] = [];
  for (const p of list) {
    if (byName.has(p.name)) continue;
    byName.add(p.name);
    result.push(p);
  }
  return result;
}

/**
 * 把包 source 解析为目录。
 * preferredScope 用于严格遵循 Pi 的 project/user 安装边界；未指定时按当前信任状态 project→global。
 */
export function resolveSourceDir(source: string, cwd: string, preferredScope?: "global" | "project"): string | null {
  if (preferredScope === "project" && !runtime.projectTrusted) return null;
  const projectNpm = join(cwd, CONFIG_DIR_NAME, "npm", "node_modules");
  const globalNpm = join(agentDir, "npm", "node_modules");
  const projectGit = join(cwd, CONFIG_DIR_NAME, "git");
  const globalGit = join(agentDir, "git");
  const npmBases = preferredScope === "project" ? [projectNpm]
    : preferredScope === "global" ? [globalNpm]
    : runtime.projectTrusted ? [projectNpm, globalNpm] : [globalNpm];
  const gitBases = preferredScope === "project" ? [projectGit]
    : preferredScope === "global" ? [globalGit]
    : runtime.projectTrusted ? [projectGit, globalGit] : [globalGit];

  if (source.startsWith("npm:")) {
    // npm 安装目录使用 package name，不包含 @version。
    const spec = source.slice(4).trim();
    const name = spec.match(/^(@[^/]+\/[^@]+|[^@/]+)(?:@.*)?$/)?.[1] ?? spec;
    for (const base of npmBases) {
      const dir = join(base, ...name.split("/"));
      if (existsSync(dir)) return dir;
    }
    return null;
  }
  if (source.startsWith("git:")) {
    // git ref 不属于 Pi 的安装目录路径。
    const rel = source.slice(4).replace(/@[^/]+$/, "");
    for (const base of gitBases) {
      const dir = join(base, ...rel.split("/"));
      if (existsSync(dir)) return dir;
    }
    return null;
  }
  if (source.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(source)) {
    return existsSync(source) ? source : null;
  }
  if (!source.includes(":")) {
    if (source.startsWith("./") || source.startsWith("../")) {
      const dir = resolve(cwd, source);
      return existsSync(dir) ? dir : null;
    }
    for (const base of npmBases) {
      const dir = join(base, ...source.split("/"));
      if (existsSync(dir)) return dir;
    }
  }
  return null;
}

/** 兼容旧调用：按 source 或 name 定位包目录（项目级优先）。 */
export function findPackageDir(sourceOrName: string, cwd: string): string | null {
  const direct = resolveSourceDir(sourceOrName, cwd);
  if (direct && hasPiManifest(direct)) return direct;
  const normalizedName = sourceOrName.startsWith("npm:")
    ? sourceOrName.slice(4).match(/^(@[^/]+\/[^@]+|[^@/]+)(?:@.*)?$/)?.[1]
    : sourceOrName;
  for (const p of listInstalledPackages(cwd)) {
    if (p.name === sourceOrName || p.source === sourceOrName || (normalizedName && p.name === normalizedName)) return p.dir;
  }
  return null;
}

// ---------- 包资源检查（含 glob） ----------
function globToRegex(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

function walkFiles(root: string, base = ""): string[] {
  let out: string[] = [];
  if (!existsSync(root)) return out;
  for (const f of readdirSync(root, { withFileTypes: true })) {
    if (f.name.startsWith(".") || f.name === "node_modules") continue;
    const rel = base ? `${base}/${f.name}` : f.name;
    const p = join(root, f.name);
    if (f.isDirectory()) out = out.concat(walkFiles(p, rel));
    else out.push(rel);
  }
  return out;
}

function isGlobPattern(p: string): boolean {
  return p.includes("*") || p.includes("?");
}

function dirHasSkill(d: string): boolean {
  return existsSync(join(d, "SKILL.md"));
}

/**
 * 展开 pi.skills / pi.prompts 声明（支持 glob、目录、单文件、!排除）。
 * skills → 技能名（SKILL.md 目录名或 .md 文件的 frontmatter name / 文件名）
 * prompts → .md 文件名
 */
function expandResourceEntries(
  pkgDir: string,
  entries: unknown,
  kind: "skills" | "prompts",
): string[] {
  if (!Array.isArray(entries)) return [];
  const pos: string[] = [];
  const neg: string[] = [];
  for (const e of entries) {
    if (typeof e !== "string" || !e.trim()) continue;
    const p = e.replace(/^\.\//, "").replace(/\\/g, "/");
    if (p.startsWith("!")) neg.push(p.slice(1));
    else pos.push(p);
  }
  const negRes = neg.map(globToRegex);
  const out = new Set<string>();
  for (const p of pos) {
    const full = join(pkgDir, ...p.split("/"));
    if (!isGlobPattern(p)) {
      if (existsSync(full) && statSync(full).isDirectory()) {
        // 目录：技能递归查找 SKILL.md；提示模板递归查找 Markdown 文件。
        for (const rel of walkFiles(full)) {
          const abs = join(full, ...rel.split("/"));
          if (kind === "skills" && basename(rel) === "SKILL.md") {
            out.add(skillNameFromFile(abs, basename(dirname(abs))));
          } else if (kind === "prompts" && rel.endsWith(".md")) {
            out.add(basename(rel));
          }
        }
      } else if (existsSync(full) && statSync(full).isFile()) {
        out.add(kind === "skills" ? skillNameFromFile(full, basename(p)) : basename(p));
      }
    } else {
      // glob：遍历包内文件匹配
      const re = globToRegex(p);
      const all = walkFiles(pkgDir);
      for (const rel of all) {
        if (!re.test(rel)) continue;
        if (negRes.some((n) => n.test(rel))) continue;
        const abs = join(pkgDir, ...rel.split("/"));
        if (kind === "skills") {
          const st = statSync(abs);
          // glob 下只有 SKILL.md，或声明本身明确命中的有效 Markdown 文件才算技能；
          // 避免把 skill references/ 下的普通文档误报为技能。
          if (st.isFile() && basename(rel) === "SKILL.md") out.add(skillNameFromFile(abs, basename(dirname(abs))));
          else if (st.isFile() && rel.endsWith(".md") && parseFrontmatter(abs)?.description) {
            out.add(skillNameFromFile(abs, basename(rel)));
          }
        } else if (rel.endsWith(".md")) {
          out.add(basename(rel));
        }
      }
    }
  }
  return [...out].filter((n) => !negRes.some((nre) => nre.test(n)) && !(neg.includes(n)));
}

function skillNameFromFile(file: string, fallback: string): string {
  const fm = parseFrontmatter(file);
  return fm?.name ?? fallback.replace(/\.md$/, "");
}

interface PackageResourceEntry {
  name: string;
  path: string;
}

/** 返回 manifest/约定目录对应的真实文件路径，避免只保存 basename 后丢失自定义目录。 */
function expandResourcePaths(pkgDir: string, entries: unknown, kind: "skills" | "prompts"): string[] {
  if (!Array.isArray(entries)) return [];
  const positives: string[] = [];
  const negatives: string[] = [];
  for (const e of entries) {
    if (typeof e !== "string" || !e.trim()) continue;
    const p = e.trim().replace(/^\.\//, "").replace(/\\/g, "/");
    if (p.startsWith("!")) negatives.push(p.slice(1));
    else if (!p.startsWith("+") && !p.startsWith("-")) positives.push(p);
  }
  const neg = negatives.map(globToRegex);
  const allFiles = walkFiles(pkgDir);
  const result = new Set<string>();
  const matches = (rel: string, pattern: string) => {
    if (isGlobPattern(pattern)) return globToRegex(pattern).test(rel);
    return rel === pattern || rel.startsWith(`${pattern.replace(/\/$/, "")}/`);
  };
  for (const rel of allFiles) {
    const isSkill = kind === "skills" && (basename(rel) === "SKILL.md" || rel.endsWith(".md"));
    const isPrompt = kind === "prompts" && rel.endsWith(".md");
    if (!(isSkill || isPrompt)) continue;
    if (!positives.some((p) => matches(rel, p))) continue;
    if (neg.some((r) => r.test(rel))) continue;
    result.add(join(pkgDir, ...rel.split("/")));
  }
  return [...result];
}

type PackageResourceKind = "extensions" | "skills" | "prompts" | "themes";

function packageFilterMatches(pkgDir: string, resourcePath: string, resourceName: string, pattern: string): boolean {
  const normalized = pattern.trim().replace(/^\.\//, "").replace(/\\/g, "/");
  const rel = resolve(resourcePath).startsWith(resolve(pkgDir) + sep)
    ? resolve(resourcePath).slice(resolve(pkgDir).length + 1).split(sep).join("/")
    : resourcePath.replace(/\\/g, "/");
  if (normalized === resourceName || normalized === basename(rel)) return true;
  if (isGlobPattern(normalized)) return globToRegex(normalized).test(rel);
  return rel === normalized || rel.startsWith(`${normalized.replace(/\/$/, "")}/`);
}

/**
 * 判断资源是否被 Pi settings 中的 package filter 允许。
 * 未声明过滤字段表示全部允许；空数组表示全部禁用。
 */
export function isPackageResourceAllowed(
  sourceOrName: string,
  cwd: string,
  kind: PackageResourceKind,
  resourcePath: string,
  resourceName = basename(resourcePath),
): boolean {
  const settings = packageSettingsFor(sourceOrName, cwd);
  const filters = settings?.[kind];
  if (filters === undefined) return true;
  if (!Array.isArray(filters)) return true;
  if (filters.length === 0) return false;

  const pkgDir = findPackageDir(sourceOrName, cwd);
  if (!pkgDir) return false;
  const rel = resolve(resourcePath).startsWith(resolve(pkgDir) + sep)
    ? resolve(resourcePath).slice(resolve(pkgDir).length + 1).split(sep).join("/")
    : resourcePath.replace(/\\/g, "/");
  let hasPositive = false;
  let matchedPositive = false;
  for (const item of filters) {
    if (typeof item !== "string" || !item.trim()) continue;
    const raw = item.trim();
    const isGlobNegative = raw.startsWith("!");
    const isExactNegative = raw.startsWith("-");
    const pattern = raw.replace(/^[!+-]/, "");
    if (isGlobNegative && (isGlobPattern(pattern) ? globToRegex(pattern).test(rel) : rel === pattern)) return false;
    if (isExactNegative && rel === pattern) return false;
    if (!isGlobNegative && !isExactNegative) {
      hasPositive = true;
      if (packageFilterMatches(pkgDir, resourcePath, resourceName, pattern)) matchedPositive = true;
    }
  }
  return !hasPositive || matchedPositive;
}

function packageResourceEntries(sourceOrName: string, cwd: string, kind: "skills" | "prompts"): PackageResourceEntry[] {
  const dir = findPackageDir(sourceOrName, cwd);
  if (!dir) return [];
  const manifest = readJson<{ pi?: { skills?: unknown; prompts?: unknown } }>(join(dir, "package.json"));
  const conventional = join(dir, kind);
  const declared = manifest?.pi?.[kind];
  const paths = declared !== undefined
    ? expandResourcePaths(dir, declared, kind)
    : existsSync(conventional) ? expandResourcePaths(dir, [`./${kind}`], kind) : [];
  return paths.map((path) => ({
    name: kind === "skills"
      ? skillNameFromFile(path, basename(path) === "SKILL.md" ? basename(dirname(path)) : basename(path))
      : basename(path),
    path,
  })).filter((entry) => isPackageResourceAllowed(sourceOrName, cwd, kind, entry.path, entry.name));
}

export interface PackageContents {
  skills: string[];
  prompts: string[];
}

/** 解析包内资源（pi manifest + 约定目录，支持 glob）。 */
export function inspectPackage(sourceOrName: string, cwd: string): PackageContents {
  const dir = findPackageDir(sourceOrName, cwd);
  const empty: PackageContents = { skills: [], prompts: [] };
  if (!dir) return empty;
  const skills = packageResourceEntries(sourceOrName, cwd, "skills").map((x) => x.name);
  const prompts = packageResourceEntries(sourceOrName, cwd, "prompts").map((x) => x.name);
  return { skills: [...new Set(skills)], prompts: [...new Set(prompts)] };
}

// ---------- 技能定位 ----------
export function parseFrontmatter(file: string): { name?: string; description?: string } | null {
  if (!existsSync(file)) return null;
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch {
    return null;
  }
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const result: { name?: string; description?: string } = {};
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key === "name") result.name = value;
    else if (key === "description") result.description = value;
  }
  return result;
}

interface LocalSkillLocation {
  root: string;
  scope: "global" | "project";
  rootMarkdown: boolean;
  nestedMarkdown: boolean;
}

function expandLocalSkillSettingPath(value: string, settingsFile: string): string {
  const p = value.trim();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return resolve(dirname(settingsFile), p);
}

function addLocalSkillLocation(
  locations: LocalSkillLocation[],
  root: string,
  scope: "global" | "project",
  rootMarkdown: boolean,
  nestedMarkdown: boolean,
): void {
  if (!existsSync(root)) return;
  const key = `${scope}:${resolve(root)}`;
  if (locations.some((x) => `${x.scope}:${resolve(x.root)}` === key)) return;
  locations.push({ root, scope, rootMarkdown, nestedMarkdown });
}

/** 返回 Pi 官方本地技能位置：.pi、.agents、settings.skills 及祖先目录。 */
function localSkillLocations(cwd: string): LocalSkillLocation[] {
  const locations: LocalSkillLocation[] = [];
  addLocalSkillLocation(locations, skillsDir, "global", true, false);
  addLocalSkillLocation(locations, join(homedir(), ".agents", "skills"), "global", false, true);

  if (runtime.projectTrusted) {
    addLocalSkillLocation(locations, projectSkillsDir(cwd), "project", true, false);
    let current = resolve(cwd);
    for (;;) {
      addLocalSkillLocation(locations, join(current, ".agents", "skills"), "project", false, true);
      if (existsSync(join(current, ".git"))) break;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  const settingsFiles: Array<{ file: string; scope: "global" | "project" }> = [
    { file: globalSettingsFile, scope: "global" },
    ...(runtime.projectTrusted ? [{ file: join(cwd, CONFIG_DIR_NAME, "settings.json"), scope: "project" as const }] : []),
  ];
  for (const { file, scope } of settingsFiles) {
    const settings = readJson<Record<string, unknown>>(file);
    if (!Array.isArray(settings?.skills)) continue;
    for (const item of settings.skills) {
      if (typeof item !== "string" || !item.trim()) continue;
      const path = expandLocalSkillSettingPath(item, file);
      addLocalSkillLocation(locations, path, scope, true, true);
    }
  }
  return locations;
}

interface DiscoveredSkillFile {
  name: string;
  path: string;
}

function skillNameFromValidFile(file: string, fallback: string): string | null {
  const fm = parseFrontmatter(file);
  if (!fm?.description?.trim()) return null;
  return fm.name?.trim() || fallback;
}

function discoverSkillFiles(location: LocalSkillLocation): DiscoveredSkillFile[] {
  const result: DiscoveredSkillFile[] = [];
  const add = (file: string, fallback: string) => {
    const name = skillNameFromValidFile(file, fallback);
    if (name) result.push({ name, path: file });
  };
  if (!existsSync(location.root)) return result;
  let rootStat;
  try { rootStat = statSync(location.root); } catch { return result; }
  if (rootStat.isFile()) {
    if (basename(location.root) === "SKILL.md" || location.root.endsWith(".md")) {
      add(location.root, basename(location.root) === "SKILL.md" ? basename(dirname(location.root)) : basename(location.root).replace(/\.md$/, ""));
    }
    return result;
  }
  const walk = (dir: string) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const isSkillFile = entry.name === "SKILL.md";
        const isAllowedMarkdown = location.rootMarkdown && resolve(dir) === resolve(location.root)
          || location.nestedMarkdown && resolve(dir) !== resolve(location.root);
        if (isSkillFile || isAllowedMarkdown) {
          add(path, isSkillFile ? basename(dir) : basename(entry.name).replace(/\.md$/, ""));
        }
      }
    }
  };
  walk(location.root);
  return result;
}

/** 把结构化技能引用解析为 Pi 官方发现规则下的文件路径。 */
export function resolveSkillPath(ref: SkillRef, cwd: string): string | null {
  if (ref.scope === "package" && ref.package) {
    const declared = packageResourceEntries(ref.package, cwd, "skills").find((x) => x.name === ref.name);
    if (declared) return declared.path;
    return null;
  }
  if (ref.scope === "project" && !runtime.projectTrusted) return null;
  for (const location of localSkillLocations(cwd)) {
    if (location.scope !== ref.scope) continue;
    const found = discoverSkillFiles(location).find((x) => x.name === ref.name);
    if (found) return found.path;
  }
  return null;
}

/** 解析包内提示模板。 */
export function resolvePackagePromptPath(ref: PromptRef, cwd: string): string | null {
  if (!ref.package) return null;
  return packageResourceEntries(ref.package, cwd, "prompts").find((x) => x.name === ref.name)?.path ?? null;
}

/** 扫描本地技能，并保留 global/project 作用域，供 /mode add 和 /mode edit 使用。 */
export function scanSkillRefs(cwd: string): SkillRef[] {
  const result: SkillRef[] = [];
  for (const location of localSkillLocations(cwd)) {
    for (const skill of discoverSkillFiles(location)) {
      const ref: SkillRef = { scope: location.scope, name: skill.name };
      if (!result.some((x) => JSON.stringify(x) === JSON.stringify(ref))) result.push(ref);
    }
  }
  return result;
}

/** 兼容旧调用：返回去重后的本地技能名称。 */
export function scanSkills(cwd: string): string[] {
  return [...new Set(scanSkillRefs(cwd).map((x) => x.name))];
}

// ---------- 孤儿包检测 ----------
export function getOrphanPackages(modes: string[], cwd: string): Record<string, string[]> {
  const installedPackages = listInstalledPackages(cwd);
  const installed = new Set(installedPackages.map((p) => p.name));
  const installedSources = new Set(installedPackages.map((p) => p.source));
  const orphan: Record<string, string[]> = {};
  for (const id of modes) {
    const c = loadModeConfig(id, cwd);
    const missing = (c?.packages ?? []).filter((p) => {
      if (installedSources.has(p)) return false;
      if (p.startsWith("npm:")) {
        const name = p.slice(4).match(/^(@[^/]+\/[^@]+|[^@/]+)(?:@.*)?$/)?.[1];
        if (name && installed.has(name)) return false;
        // 目录扫描通常没有版本后缀，版本化 source 与同名已安装包匹配。
        if (name && installedPackages.some((x) => x.source === `npm:${name}`)) return false;
        return true;
      }
      const name = p.includes(":") ? p.slice(p.indexOf(":") + 1).split("/").pop() : p;
      return !installed.has(name ?? p);
    });
    if (missing.length > 0) orphan[id] = missing;
  }
  return orphan;
}

/** 校验继承方向（全局模式不能继承项目级模式）。 */
export function checkInheritDirection(
  location: "global" | "project",
  parentId: string,
  cwd: string,
): string | null {
  if (location !== "global") return null;
  if (parentId === "default") return null;
  const loc = modeLocation(parentId, cwd);
  if (loc === "project") {
    return `全局模式不能继承项目级模式「${parentId}」（换目录会失效）`;
  }
  return null;
}
