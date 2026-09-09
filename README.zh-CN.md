# pi-mode-switcher

[English](README.md)

面向任务的 [Pi](https://pi.dev) 模式系统：根据当前工作选择匹配的工具、技能、提示词和包资源。

模式的目的不只是节省 token。它首先为模型提供更小、更相关的工作环境：

- 减少无关工具，降低工具选择负担；
- 注入任务专用的指令和 Skill；
- 明确区分开发、审查、研究和文档等工作流；
- 让工具调用和输出更加稳定；
- 同时减少提示词和 token 开销。

## 安装

```bash
pi install git:github.com/Escape-z/pi-mode-switcher
```

本地开发：

```bash
pi install C:/path/to/pi-mode-switcher
cd C:/path/to/pi-mode-switcher
npm install
```

`@earendil-works/pi-tui` 是可选依赖。安装后，模式和包资源选择器会使用支持搜索的多选界面；缺少该依赖时会自动回退到普通选择界面。

## 快速开始

安装后，Pi 默认进入最小的 `default` 模式。

```text
/full       启用当前运行时的完整配置
/default    返回最小配置
/mode       打开模式面板
/mode show  显式打开模式面板
```

每个不冲突的模式 ID 都可以作为顶层命令使用。例如，名为 `java` 的模式可以这样切换：

```text
/java
```

原来的写法仍然兼容：

```text
/mode use java
```

交互式创建模式：

```text
/mode add
```

## 内置模式

| 模式 | 作用 |
|---|---|
| `default` | 最小模式，保留 Pi 的 8 个内置工具，并从提示词中移除自动发现的 Skill。适合简单任务和干净的基线测试。 |
| `full` | 启用当前运行时注册的全部工具和自动发现的全部 Skill。适合探索项目，或当前模式尚未挂载所需资源时使用。 |

自定义模式以 JSON 文件保存：

- `~/.pi/agent/modes/`：全局模式；
- `.pi/modes/`：项目模式。

项目级资源遵循 Pi 的项目受信任规则。

## 模式控制什么

一个模式可以选择：

- **工具**：添加 Pi 或其他包注册的工具；
- **Skill**：只向模型暴露与当前模式相关的 Skill；
- **提示模板**：为模式贡献 prompt template；
- **系统提示词文本**：追加模式专用的工作指令；
- **包**：记录属于该模式的包资源。

模式是资源配置档案，不是独立模型。它不会改变 Pi 当前选择的 provider 或 model。

### 模式示例

项目可以使用以下模式：

```text
coding       代码实现、测试和项目命令
audit        diff 分析、安全检查和只读指导
docs         文档结构、术语和文档构建
research     网络搜索、来源评估和引用工作流
java         Java 专用工具和 Skill
```

典型用法是：

```text
/java
```

先选择领域模式，再由其他 Pi 扩展提供计划或实施流程。`pi-mode-switcher` 负责选择模型可用的资源，不强制规定计划模式或子 Agent 策略。

## 命令

### 模式命令

| 命令 | 说明 |
|---|---|
| `/<mode-id>` | 直接切换模式，例如 `/java` 或 `/review`。 |
| `/mode` | 打开模式面板。 |
| `/mode show` | 显式打开模式面板。 |
| `/mode clear` | 关闭模式面板。 |
| `/mode use <id>` | 兼容写法，用于切换模式。 |
| `/mode add` | 使用交互式向导创建模式。 |
| `/mode edit [id]` | 编辑模式；如果该模式当前正在使用，修改会立即生效。 |
| `/mode del [id]` | 删除自定义模式。内置的 `default` 和 `full` 始终可用。 |
| `/mode init` | 创建或修复 `full.json`。 |
| `/mode cleanup` | 清理已经卸载的包留下的引用。 |

### 资源命令

| 命令 | 说明 |
|---|---|
| `/link add [package]` | 将包或包内资源挂载到某个模式。 |
| `/link del [package]` | 移除包挂载，并清理该挂载拥有的资源。 |
| `/link show` | 显示包和资源的挂载关系。 |
| `/link clear` | 关闭挂载面板。 |

## 配置

模式文件使用 schema version 2：

```json
{
  "schemaVersion": 2,
  "name": "Java development",
  "inherit": "dev",
  "promptMode": "append",
  "addTools": ["grep", "find"],
  "addSkills": [
    { "scope": "global", "name": "java-review" },
    {
      "scope": "package",
      "package": "npm:pi-java-tools",
      "name": "java-workflow"
    }
  ],
  "packages": ["npm:pi-java-tools"],
  "prompts": [
    {
      "package": "npm:pi-java-tools",
      "name": "api-design.md"
    }
  ],
  "systemPrompt": "Follow the project's Java and Gradle conventions."
}
```

`promptMode` 控制子模式如何合并父模式的提示词：

- `append`：将子模式提示词追加到父模式之后；
- `override`：替换继承来的父模式提示词。

模式可以多级继承，例如：

```text
default → dev → java → spring
```

工具和资源采用并集继承。模式面板会报告无效父模式、循环继承、资源缺失和其他诊断信息，而不是静默隐藏问题。

## Skill 渐进式加载

对于自定义模式挂载的 Skill，Pi 最初只向模型提供 Skill 的名称、描述和文件位置。当任务匹配某个 Skill 时，模型可以使用 `read` 工具读取完整的 `SKILL.md`。

这样可以保持当前提示词简洁，同时按需访问详细流程、参考资料和脚本。

Skill 仍然依赖它所描述的底层能力。例如，文献研究 Skill 可以规定搜索和引用流程，但当前会话仍需要注册合适的网页或文档工具。

## 设计和边界

`pi-mode-switcher` 是一个**资源门控系统**，不是运行时包加载器。

Pi 启动时会加载受信任的扩展并注册它们的工具。插件在此基础上控制哪些已注册工具处于激活状态，以及哪些 Skill、提示模板和模式指令进入下一次模型请求。

| 资源 | 控制方式 | 生效时机 |
|---|---|---|
| 工具 | `pi.setActiveTools()` | 切换或挂载后立即生效 |
| 自动发现的 Skill | 从系统提示词中过滤 | 下一次请求生效 |
| 模式挂载的 Skill | 注入名称、描述和位置；正文按需读取 | 下一次请求生效 |
| 模式系统提示词 | 通过 `before_agent_start` 追加 | 下一次请求生效 |
| 提示模板 | 通过 `resources_discover` 提供 | `/reload` 后生效 |
| 扩展代码 | 运行时不可控 | 需要 reload 才能彻底移除 |

### 重要限制

- Pi 没有第三方扩展运行时卸载 API。移除包后，它不会在未来会话中加载，但当前已经注册的扩展代码可能要等到 `/reload` 才会清除。
- 8 个内置工具（`read`、`write`、`edit`、`bash`、`powershell`、`grep`、`find` 和 `ls`）在所有模式中都会保留。`addTools` 只负责添加已注册工具，不会替换这些内置工具。
- 某些扩展可能在本插件资源集合之外保留或恢复自己的工具。
- 模式提示词是行为指导，不是安全边界。如果需要严格的只读模式，应使用权限扩展或 `tool_call` 门控，并同时限制 shell 写操作。
- 即使某个 Skill 不在当前模式的自动发现列表中，用户仍可以通过 `/skill:<name>` 显式调用它。
- 项目级资源受 Pi 项目受信任决策控制。
- 如果模式 ID 与 Pi 内置命令或其他扩展的 slash 命令冲突，就不能占用对应的顶层命令；此时请使用 `/mode use <id>`。

## 推荐用法

建议使用少量、聚焦的模式，而不是创建一个包含所有工具和 Skill 的大模式：

```text
coding   → 实现工具 + 编码和验证 Skill
review   → 检查工具 + Review Skill 和禁止编辑的指导
docs     → 文档工具 + 写作和构建 Skill
research → 搜索工具 + 来源评估 Skill
```

目标不是让模型机械执行固定脚本，而是为当前任务提供正确的上下文和能力边界，同时把具体执行策略交给模型或其他工作流扩展。

## 开发

在仓库根目录运行测试：

```bash
npm test
```

测试台覆盖模式继承、资源发现、项目受信任、包挂载、Skill 渐进式加载、直接模式命令、活体面板和配置诊断。

## License

MIT
