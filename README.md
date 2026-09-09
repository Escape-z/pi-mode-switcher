# pi-mode-switcher

[简体中文](README.zh-CN.md)

Task-focused modes for [Pi](https://pi.dev): choose the tools, skills, prompts, and package resources that match the work in front of you.

Modes are not only a token-saving feature. Their main purpose is to give the model a smaller, more relevant working environment:

- fewer irrelevant tools to choose from;
- task-specific instructions and Skills;
- clearer boundaries between coding, review, research, and documentation;
- more predictable tool use and output;
- lower prompt and token overhead as a useful side effect.

## Install

```bash
pi install git:github.com/Escape-z/pi-mode-switcher
```

For local development:

```bash
pi install C:/path/to/pi-mode-switcher
cd C:/path/to/pi-mode-switcher
npm install
```

`@earendil-works/pi-tui` is optional. When it is available, the mode and package pickers use a searchable multi-select UI; otherwise they fall back to regular selections.

## Quick start

After installing, Pi starts in the minimal `default` mode.

```text
/full       Enable the full runtime configuration
/default    Return to the minimal configuration
/mode       Open the mode panel
/mode show  Open the mode panel explicitly
```

Every valid, non-conflicting mode ID can be used as a top-level command. For example, a mode named `java` can be activated with:

```text
/java
```

The older form remains supported:

```text
/mode use java
```

Create a mode interactively:

```text
/mode add
```

## Built-in modes

| Mode | Purpose |
|---|---|
| `default` | Minimal mode with Pi's eight built-in tools and no automatically discovered Skills in the prompt. It is useful for simple tasks and a clean baseline. |
| `full` | Enables all tools registered in the current runtime and all automatically discovered Skills. It is useful when exploring a project or when a specialized resource is not yet mounted. |

Custom modes are stored as JSON files under:

- `~/.pi/agent/modes/` for global modes;
- `.pi/modes/` for project modes.

Project-local resources follow Pi's project trust rules.

## What a mode controls

A mode can select:

- **Tools** — add tools registered by Pi or another package;
- **Skills** — expose only the Skills relevant to the mode;
- **Prompts** — contribute prompt templates for the mode;
- **System prompt text** — append mode-specific operating instructions;
- **Packages** — record the packages whose resources belong to the mode.

A mode is a resource profile, not a separate model. It does not change the provider or model selected in Pi.

### Example profiles

A project might use profiles such as:

```text
coding       implementation, tests, and repository commands
review       diff analysis, security checks, and read-only guidance
docs         documentation structure, terminology, and doc builds
research     web search, source evaluation, and citation workflow
java         Java-specific tools and Skills
```

A typical workflow is:

```text
/java
```

for the domain profile, followed by a plan or implementation workflow supplied by another Pi extension. `pi-mode-switcher` focuses on the resources available to the model; it does not impose a particular planning or sub-agent strategy.

## Commands

### Mode commands

| Command | Description |
|---|---|
| `/<mode-id>` | Switch directly to a mode, for example `/java` or `/review`. |
| `/mode` | Show the mode panel. |
| `/mode show` | Show the mode panel explicitly. |
| `/mode clear` | Close the mode panel. |
| `/mode use <id>` | Compatibility form for switching modes. |
| `/mode add` | Create a mode with an interactive wizard. |
| `/mode edit [id]` | Edit a mode and apply changes immediately when it is active. |
| `/mode del [id]` | Delete a custom mode. Built-in `default` and `full` remain available. |
| `/mode init` | Create or repair `full.json`. |
| `/mode cleanup` | Remove references to packages that are no longer installed. |

### Resource commands

| Command | Description |
|---|---|
| `/link add [package]` | Mount a package or one of its resources into a mode. |
| `/link del [package]` | Remove a package mount and clean up resources owned by that mount. |
| `/link show` | Show package and resource mounts. |
| `/link clear` | Close the mount panel. |

## Configuration

A mode file uses schema version 2:

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

`promptMode` controls how a child mode combines its prompt with its parent:

- `append` adds the child prompt after the parent prompt;
- `override` replaces the inherited prompt.

Modes can inherit from other modes, for example:

```text
default → dev → java → spring
```

Inheritance uses union semantics for tools and resources. The mode panel reports invalid parents, cycles, missing resources, and other diagnostics instead of silently hiding them.

## Progressive Skill loading

For Skills mounted by a custom mode, Pi initially receives only the Skill name, description, and file location. The model can use the `read` tool to load the full `SKILL.md` when the task matches the Skill.

This keeps the active prompt focused while preserving on-demand access to detailed procedures, references, and scripts.

A Skill still requires the underlying capability it describes. For example, a literature-research Skill can specify a search and citation workflow, but the session must also have suitable web or document tools registered.

## Design and boundaries

`pi-mode-switcher` is a **resource gating system**, not a runtime package loader.

At startup, Pi loads trusted extensions and registers their tools. The plugin then controls which registered tools are active and which Skills, prompts, and mode instructions are included in the next model request.

| Resource | Control | Takes effect |
|---|---|---|
| Tools | `pi.setActiveTools()` | Immediately after switching or mounting |
| Automatically discovered Skills | Filtered from the system prompt | On the next request |
| Mode-mounted Skills | Name/description/location are injected; full content is read on demand | On the next request |
| Mode system prompt | Appended through `before_agent_start` | On the next request |
| Prompt templates | Contributed through `resources_discover` | After `/reload` |
| Extension code | Not controlled at runtime | Requires Pi reload to fully remove |

### Important limitations

- Pi does not provide a runtime unload API for third-party extension code. Removing a package prevents it from loading in a future session, but already registered code may remain until `/reload`.
- The eight built-in tools (`read`, `write`, `edit`, `bash`, `powershell`, `grep`, `find`, and `ls`) are kept available in every mode. `addTools` adds registered tools; it does not replace these built-ins.
- Some extensions may keep or restore their own tools outside this plugin's resource set.
- A mode's prompt is guidance, not a security boundary. If a strict read-only mode is required, use a permission or `tool_call` gate and restrict shell writes as well.
- A Skill may still be invoked explicitly with `/skill:<name>` even when it is not part of the mode's automatically discovered Skill list.
- Project-local resources are subject to Pi's trust decision.
- A mode ID that conflicts with a built-in or another extension's slash command cannot claim that top-level command; use `/mode use <id>` instead.

## Recommended use

Use a small number of focused modes rather than one mode containing every tool and Skill:

```text
coding   → implementation tools + coding and verification Skills
review   → inspection tools + review Skill and no-edit instructions
docs     → documentation tools + writing and build Skills
research → search tools + source-evaluation Skill
```

The goal is not to make the model follow a rigid script. The goal is to give it the right context and affordances for the current task, while leaving the execution strategy to the model or to other workflow extensions.

## Development

Run the test suite from the repository root:

```bash
npm test
```

The test harness covers mode inheritance, resource discovery, project trust, package mounts, progressive Skill loading, direct mode aliases, live panels, and configuration diagnostics.

## License

MIT
