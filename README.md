# pi-mode-switcher

Pi 模式切换系统：**按需门控工具/技能/上下文资源，节省 token 消耗**。

## 架构定位（重要，请先阅读）

本插件是 **模式资源门控系统**，不是包运行时加载/卸载系统。

Pi 不提供运行时加载/卸载第三方包的 API：只有已写入 Pi settings、命令行显式加载且通过项目受信任检查的包，才会在 Pi 启动时执行扩展。插件扫描到的“已安装包”不等于包已经加载。
本插件在此之上控制 **哪些已注册资源进入模型上下文**：

| 资源 | 控制方式 | 生效时机 |
|------|---------|---------|
| 工具 | `pi.setActiveTools()` 全量门控 | 切换/挂载/卸载 **立即生效** |
| 技能（自动发现列表） | 系统提示词文本级过滤 | 切换后下一次请求生效 |
| 技能（模式挂载） | 渐进式：只注入名称/描述/位置，模型按需 `read` 完整内容 | 下一次请求生效 |
| 模式 systemPrompt | `before_agent_start` 追加（绝不覆盖 Pi 基础提示词） | 下一次请求生效 |
| 提示模板 | `resources_discover` 贡献 | 需手动 `/reload` |
| 包扩展代码 | **不受控**（Pi 限制），包卸载后需 `/reload` 彻底清除 | — |

### 能力边界

- 默认模式只保证**本插件可控制的资源最小化**；第三方扩展自行注入的内容无法阻止。
- 提示模板在 Pi 全局可见（模式只记录归属，不做严格隔离）；模板本身不进入系统提示词。
- 未挂载技能仍可被用户显式调用（`/skill:name`），模式只控制模型自动发现，不拦截用户操作。
- `/link add` 遵循 Pi settings 中包的 `extensions/skills/prompts` 过滤；它不会绕过 Pi 的包过滤，也不会加载未在 Pi 启动时注册的扩展工具。
- 不支持“单个扩展”挂载（Pi 无运行时扩展加载 API）；**单个工具**支持挂载（可即时门控）。
- 包被 `pi remove` 后：Pi settings 会停止下次启动加载；当前 Pi 进程中已经注册的扩展代码和工具仍可能存在，需 `/reload` 彻底清除；模式中的孤儿配置由 `/mode cleanup` 清理。
  插件不自动 reload，避免打断会话和影响缓存。
- 工具/技能同名冲突遵循 Pi 官方 first-wins 规则，插件不重命名、不伪造别名。

## 安装

```bash
# 本地开发（改码即生效）
pi install C:/path/to/pi-mode-switcher
# 本地路径安装不会自动装 peer 依赖，需手动装一次，否则多选界面回退为逐项选择：
cd C:/path/to/pi-mode-switcher && npm install
```

> 说明：`npm install` 提供 `@earendil-works/pi-tui`，用于 TUI 下的滚动多选（包/工具/技能/提示模板一次勾完，支持搜索）。
> 通过 npm/git 安装时 Pi 会自动处理 peer 依赖，无需手动执行。缺失时插件会自动回退为逐项选择并提示一次，功能不受影响。

> 扩展入口：本包通过包根 `index.ts` 作为唯一扩展入口加载（内部组合 mode-manager 与 mode-switcher 两个模块），安装后 pi 中显示为**一个扩展**（横幅标签为 `pi-mode-switcher`）。

```bash
# 或从 GitHub
pi install git:github.com/Escape-z/pi-mode-switcher
```

## 模式

安装后初始只有两个内置模式：

| 模式 | 行为 |
|------|------|
| `default` | 默认模式：8 个内置工具（read/write/edit/bash/powershell/grep/find/ls）+ Pi/第三方常驻工具（如 `subagent_supervisor`，不受门控），剥离自动发现技能列表 |
| `full` | 全功能：当前运行时全部已注册工具 + 全部自动发现技能；`full.json` 的 `systemPrompt` 非空时追加 |

- `default` 是**虚拟根模式**（无配置文件），可作为其他模式的父模式。
- `full` 可通过 `/mode init` 生成 `full.json` 定制（`/mode edit full` 可编辑，不可删除）。
- 其余模式由 `/mode add` 按需创建，创建后 `/mode use <id>` 即可切换。

## 命令一览

命令为分组子命令结构，输入 `/mode` 或 `/link` + 空格会弹出**两级补全菜单**（子命令 → 模式 id / 包名，带描述，与 Pi 内置 `/plan` 体验一致）。

### `/mode` — 模式管理与切换

| 子命令 | 功能 |
|------|------|
| `/mode`（或 `/mode show`） | 模式面板：虚拟 default/full + 递归继承树 + **最终有效资源统计** + 诊断（缺失父/循环/坏配置/非法文件名/孤儿包/嵌套文件）；**活体面板**——add/edit/del/link/切换模式后自动实时刷新，无需重开 |
| `/mode clear` | 关闭模式面板 |
| `/mode use <id>` | 切换模式（含 default/full；id 省略时走选择向导）；新建模式**无需 /reload 即出现在补全中** |
| `/mode add` | 创建模式（向导：标识→名称→位置→父模式→提示词处理→包→工具→技能→提示→systemPrompt） |
| `/mode edit [id]` | 编辑模式（预填当前值，保存立即生效；`full` 可编辑；全局↔项目迁移时目标存在需确认） |
| `/mode del [id]` | 删除模式（同名分作用域选择；子模式顺延到祖父；删除当前模式回落默认） |
| `/mode init` | 生成 full.json（已存在→确认覆盖；损坏→备份后重新生成） |
| `/mode cleanup` | 清理已卸载包的引用及其管理的资源 |

### `/link` — 挂载管理

| 子命令 | 功能 |
|------|------|
| `/link add [pkg]` | 挂载包/单工具/单技能/单提示到模式（参数须为已安装包，否则报错） |
| `/link del [pkg]` | 解除挂载（参数自动定位模式，多模式挂载时选择；整包级联清理其管理的资源，手动资源保留）；补全只列**已挂载**的包并显示挂载点 |
| `/link show` | 挂载关系面板（活体，变更实时反映）；**整包挂载只显示一行 `📦 包（整包）`**，单独挂载的资源按包归组 `📦 包 → 🎯 技能 · 📝 提示`；面板高度自适应终端 |
| `/link clear` | 关闭挂载面板 |

所有管理命令仅支持交互式 TUI/RPC 模式；`print`/`json` 模式下直接提示不支持。

## 模式继承

- 多级继承：`default → dev → java → spring`，运行时动态合并（并集语义）。
- 8 个内置工具（read/write/edit/bash/powershell/grep/find/ls）所有模式固定启用，`addTools` 只保存额外工具。Pi 或第三方扩展常驻/自恢复的工具（如 `subagent_supervisor`）不受门控，实测 default 下为 9 个工具。
- 父子提示词：创建/编辑时可选 **追加**（`promptMode: "append"`）或 **覆盖**（`"override"`）父模式提示词。
- 父模式缺失/损坏/循环继承：**警告但继续加载**当前模式自身配置。
- 继承方向：全局模式只能继承全局模式；项目级模式可继承全局或项目级。

## 配置格式 v2

模式文件位于 `~/.pi/agent/modes/`（全局）或 `项目/.pi/modes/`（项目级，需项目受信任），必须放在顶层（嵌套文件跳过并警告）：

```json
{
  "schemaVersion": 2,
  "name": "Java 开发",
  "inherit": "dev",
  "promptMode": "append",
  "addTools": ["grep", "find"],
  "addSkills": [
    { "scope": "package", "package": "npm:pi-java-tools", "name": "java-review" },
    { "scope": "global", "name": "coding-common" }
  ],
  "packages": ["npm:pi-java-tools"],
  "prompts": [
    { "package": "npm:pi-java-tools", "name": "api-design.md" }
  ],
  "managedResources": {
    "npm:pi-java-tools": {
      "tools": ["java-helper"],
      "skills": [{ "scope": "package", "package": "npm:pi-java-tools", "name": "java-review" }],
      "prompts": [{ "package": "npm:pi-java-tools", "name": "api-design.md" }]
    }
  },
  "systemPrompt": "你是 Java 开发助手……"
}
```

字段说明：

- `packages`：完整 Pi 包源（`npm:xxx` / `git:host/path` / 本地绝对路径），项目级优先于全局级解析。
- `addSkills` / `prompts`：**结构化引用**，带包来源，避免同名资源歧义；本地技能用 `{ "scope": "global", "name": "..." }`。
- `managedResources`：按包记录挂载来源；`/link del`、`/mode cleanup` 只清理该包管理的资源，
  多包共享的资源保留，`__manual__` 声明的手动资源永远保留。
- **旧格式兼容**：裸字符串技能/包/`pkg/name` 提示引用读取时自动迁移；保存时统一写为 v2。
- 字段类型错误逐字段容错（警告并忽略该字段）；JSON 语法错误整个文件跳过并在 `/mode show` 显示诊断。

## 状态持久化

模式状态通过 `pi.appendEntry` 保存到**当前会话**（不使用全局状态文件，无并发覆盖问题）：

| 会话操作 | 行为 |
|---------|------|
| 新会话 `/new` | 默认最小模式 |
| `/resume` / `/reload` | 恢复该会话分支上次模式 |
| `/fork` | 继承原会话模式 |

## 包扫描规则

遵循 Pi 官方规则，不要求 `pi-package` keyword：

- 读取 Pi settings 中已声明的包（npm / git / 本地路径 / scoped），加目录扫描兜底；
- 包识别：`package.json` 含 `pi` 字段，或存在 `extensions/skills/prompts/themes` 约定目录；
- 遵循 settings 中包的 `extensions` / `skills` / `prompts` 资源过滤；
- `pi.skills` / `pi.prompts` 支持 glob（`*` `**` `?`、`!` 排除）；
- 本地技能扫描覆盖 `.pi/skills`、`.agents/skills`、受信任项目祖先目录及 settings 中声明的技能路径；
- 同名包**项目级优先**（与 Pi 包管理器一致）。

## 测试

```bash
npm test
```

测试台（`.testenv/harness.mjs`）覆盖：默认/全功能模式、多级继承、渐进式技能、旧格式迁移、
包扫描与作用域优先级、项目不受信任隔离、manifest 自定义资源路径、版本化 npm source、
命令冲突、子命令分发与两级补全菜单、link/del 级联与手动资源保护、包卸载隔离、配置容错、作用域删除、
fork 继承、非 TUI 拒绝、循环继承、模式递归树、失效模式保护、活体面板实时刷新、跨模块实例状态共享、删除后同名重建、整包折叠显示、面板高度自适应终端等 137 项断言。
补充验证（`.testenv/verify-fixes.mjs`）覆盖：package settings 资源过滤、本地技能扫描
（`.agents`、祖先目录、顶层 `.md`、`references` 排除）、RPC/TUI 多选（空格切换/回车下一步）、
扩展白名单、token 节省量级等 38 项断言。

> 已验证 Pi 版本：0.84.4。技能过滤依赖系统提示词中的技能块标记，Pi 升级后若标记变化需同步更新。

## 常见问题

**Q：切到某模式后技能没出现？**
技能采用渐进式加载：系统提示词只有描述，模型会在任务匹配时用 `read` 读取完整 SKILL.md；
也可以显式 `/skill:名称` 强制加载。

**Q：挂载了提示模板但命令没出现？**
提示模板经 `resources_discover` 发现，执行 `/reload` 即可。

**Q：`pi remove` 一个包后要做什么？**
插件会立即停止使用该包资源；执行 `/mode cleanup` 清理模式中的孤儿引用；执行 `/reload` 彻底清除当前进程中的扩展。

**Q：页脚显示的数字是什么？**
当前模式最终生效的工具/技能/包数量（含继承合并结果），非 Token 估算。

## License

MIT
