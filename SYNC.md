# SYNC — 与 ralph-flow 插件版的镜像边界

ralph-flow 现在有三个实现，共享**工作流语义**，不共享代码：

| 实现 | 位置 | 角色 |
|------|------|------|
| opencode 插件 | `@yibener/ralph-flow`（`src/{engine,driver,check,tools,commands}.ts`） | 本项目的**功能基准**（超集：doctor + create + 三层解析） |
| Claude Code 插件 | `ralph-flow`（`mcp-server/server.mjs`） | 领域 skill 与跨进程锁的来源 |
| **ralph-flow-pi（本项目）** | 独立 CLI | 引擎自持会话，每步全新上下文 |

改动任何一侧的「镜像的部分」时，三边必须逐字同步。

---

## 镜像的部分（必须逐字一致）

这些是用户可见的契约，改一处就要改三处：

- **YAML schema 与校验规则** — `parseWorkflowFile`：必填字段、静默丢弃步骤的条件、重复 id / 未知 on_pass·on_fail / manual_step 错字的硬错误、1MB 上限、错误文案（中文原文）
- **三层解析顺序** — 项目 → 全局 → 内置；同名遮蔽；无效文件向后回退
- **doctor 全套** — `lintWorkflow` / `diagnoseWorkflowFiles` / `diagnoseInstances` / `buildDoctorReport` 的检查项与报告结构
- **状态机路由** — `handleCheckPassed` / `handleCheckFailed` / `resolveSubWorkflowEntry`：失败计数不因跨步路由重置、max_failures 暂停、子工作流升级、config_error 分支
- **子工作流栈** — `pushState` / `popState`，`MAX_NESTING_DEPTH = 5`
- **提示词模板结构** — `buildDoPrompt` / `buildCheckPrompt` / `buildSubWorkflowUserTask` 的分节（用户需求 / 上次失败原因 / 重试信息 / 当前任务 / 产出目录 / 检查依据）；**尾段的完成指令除外，见下**
- **报告** — `buildReportText`
- **CHECK 只读白名单** — `RALPH_CHECK_BASH_PERMISSION` 的 glob 表
- **六个工具的行为与文案** — `ralphflow_start/continue/cancel/status/list/doctor`，含 continue 的分支语义
- **`{{artifacts_dir}}`** — 唯一模板记号，字节精确

`doctor-parity` 校验：本项目的 doctor 输出与 opencode 版对同一批坏 YAML **逐行一致**（归一化路径/标签后）。改动 doctor 后应重跑这个比对。

---

## 刻意不同的部分（不要「同步」回去）

### 1. 完成信号：文本标记 → 结构化工具

| | 插件版 | ralph-flow-pi |
|---|---|---|
| DO 完成 | 模型输出 `<promise>done</promise>`，引擎正则解析（末行 / 末 100 字符 / 剥代码围栏） | 模型调用 `report_done` 工具 |
| CHECK 结论 | 模型输出 `<promise-check>true\|false</promise-check>`（只认最后一行） | 模型调用 `verdict(pass, reason)` 工具 |

用户 YAML 里不出现这些标记（由引擎注入提示词），所以**不影响 YAML 兼容**。随之废弃：`detectDoneTag`、`stripCodeBlocks`、`matchCheckTag`、`parseCheckResult`、`getAdversarialCheckReason`，以及整套容错解析规则。

只有提示词的**尾段完成指令**因此不同，其余分节逐字保留。

### 1.5 前端形态：一个聊天入口，运行时临时接管同一块终端

opencode/Claude 版只有一个聊天界面。ralph-flow-pi 走过三版，记录下来是因为每一版都踩中一个真实问题，且解法不是显然的：

**v1（早期）：聊天做运行界面**——主聊天会话调 `ralphflow_start`，引擎结果 `post` 回 transcript。问题：主 agent 把自己当监工，拿到 `ralphflow_status` 这类工具就会自己去轮询、翻内部日志（实测一次 loop 轮询 100+ 次）。根因不是"聊天"本身，是**常驻聊天会话手里有"过问全局"的工具，且没有轮次边界能挡住它自己决定去查**。

**v2（方向 A）：运行完全砍掉聊天，专用视图**——`src/tui/run-app.ts` + `render.ts` + `run-model.ts`，基于 pi-tui 自建，无 LLM 中间人：引擎自主驱动，结构化事件（`onStepStart`/`onVerdict`/…）喂给纯 reducer，渲染是 model 的纯函数（全部可测）。轮询问题解决了，但矫枉过正——`ralphflow`（不带参数）变成强制先选工作流的专用菜单页，DO/CHECK 执行过程中用户完全没有输入通道（只有 gate/pause/stall 这几个引擎主动交出控制权的时刻能按模态热键 y/e/c、r/c），跟 Claude Code 的"随时能插一句"心智模型冲突。

**v3（当前）：入口收回聊天，运行是聊天里的临时接管**——`ralphflow` 默认走 `runChat`（跟 `create` 同一个聊天面），工作流是聊天里能触发的一件事（自然语言或 `/ralphflow-start`）。工作流真正跑起来时，`ralphflow_start`/`ralphflow_continue`/`ralphflow_watch`（`commands/tools.ts`）通过 Pi 扩展系统的 `ctx.ui.custom()` 借用**这同一个聊天会话自己的 TUI**（存下它当前的根组件、`clear()`、挂上 v2 那套运行视图跑、跑完再挂回去，见 `src/tui/embed.ts`），不新开进程也不新开 TUI。v2 的轮询问题为什么不会复发：`ralphflow_start` 这类工具的 `execute()` 会一直 `await` 到运行视图交还控制权才返回——模型在这整段时间只是一个挂起等待的 Promise，没有轮次可用，结构上不可能主动再调用别的工具。v2 那套"无 LLM 中间人的运行视图 + 常驻输入框插话"（详见下方及 run-view.ts）完整保留，只是**换了个入口和挂载方式**：Esc（输入框为空时）退回聊天，工作流在后台继续跑，`runner.ts` 的 `RunnerEvents` 从单一 sink 改成可 `addEventListener`/取消订阅的广播列表，让聊天的常驻"发消息进记录"监听器和运行视图的临时监听器能同时存在。

`describeAttachOutcome`（`tools.ts`）踩过同一个轮询坑一次：detach 后返回给模型的文案曾经写"...也可以让我调用 ralphflow_watch 重新接管查看"，一个热心模型会把这当邀请立刻照做，形成"人退它进"的循环——修法是把这句话从文案里删掉，且给 `ralphflow_watch`/`ralphflow_status` 的工具描述都加上"只在用户明确要求时调用"。教训：**防轮询不能只靠拿掉 LLM 中间人这一层架构手段，工具描述和引擎返回文案里的措辞本身也是一道能被绕开的边界，两者都要看。**

### 2. 驱动模型：事件驱动寄生 → 引擎自持主循环

| 关注点 | opencode 插件 | ralph-flow-pi |
|---|---|---|
| DO 会话 | 宿主的用户聊天会话（跨步骤累积上下文 ← **本项目要解决的问题**） | 每步骤一个全新 `AgentSession`；同步骤重试延续原会话 |
| 驱动 | `session.idle` 事件 + `promptAsync` 注入 | runner 循环直接 `await` turn 结束 |
| CHECK | 独立 SDK session + `ralph-check` agent（`edit:deny`） | 全新只读会话：`tools:["read"]` + 白名单 bash 工具 |
| 只读保证 | 宿主 agent 权限表 | 工具集层面不存在写工具；`check-bash.ts` 自行校验白名单 |

废弃：`driver.ts` 的 idle 去重标记（`.last-phase-report`、`.post-tool-active`、`markPromptDelivered`）——没有 idle 事件就没有重复触发问题。

### 3. 数据布局

| | opencode | Claude | ralph-flow-pi |
|---|---|---|---|
| 项目数据根 | `.opencode/ralph-flow/` | `.claude/ralph-flow/` | `.ralph-flow/` |
| 全局配置 | `~/.config/opencode/ralph-flow/` | `~/.claude/` | `~/.config/ralph-flow-pi/` |
| 内置来源标签 | 「插件内置」`<插件目录>/` | — | 「内置」`<内置>/` |

实例目录内部结构沿用，另加：`sessions/<step>-<phase>-<n>.jsonl`（步骤会话持久化，崩溃后可 `SessionManager.open` 续）、`.runner-pid`（跨进程双驱守卫）。`.done-tag-detected` 更名 `.done-reported`（由 `report_done` 工具写）。

### 4. 并发模型

opencode 单插件进程无需锁；ralph-flow-pi 是普通 CLI，第二个 TUI 或 `ralph cancel` 是独立进程 —— 因此**从 Claude 版移植 `withInstanceLock`**（pid 文件 + hardlink 原子获取 + 死 pid 判 stale + EXDEV/EPERM 回退）。

### 5. `adversarial_check` 字段

- `model`：对象形式 `{providerID, modelID}` 在解析时归一化为 `"provider/model"` 字符串（pi-ai 原生解析字符串，且天然跨 provider）。裸模型名的 lint 文案随之改写。
- `agent`：**接受但忽略**（pi 没有 agent 概念），doctor 出警告，只读沙箱由工具集预设保证。

### 6. 无 legacy 迁移

本包全新数据目录，不迁移 opencode/Claude 版的既有实例（`migrateLegacyInstance` / `parseLegacyState` 未移植）。

### 7. skill 机制与触发写法

引擎与 skill 解耦（三边一致）：`do:` 只是提示词文本，模型读到后自行加载 skill。但**加载方式**不同：

| 实现 | 机制 |
|---|---|
| Claude | 插件原生 skill（`plugin.json` 的 `"skills"`） |
| opencode | `setup.ts` 把 skill 拷到 `~/.config/opencode/skills/`，模型用 skill 工具 |
| ralph-flow-pi | **Pi 原生**：`loadSkillsFromDir` 解析 SKILL.md，Pi 的系统提示词自动附上 `<available_skills>` 目录（name/description/**绝对 location**），模型用 `read` 工具按 location 自行加载 |

> 规划阶段设想过自己写一个 `use_skill` 工具——**没有做**：Pi 已有这套机制（`system-prompt.js` 在有 `read` 工具时自动注入目录，并指示"skill 内的相对路径按 SKILL.md 所在目录解析"）。自造只会与 Pi 的提示词打架。本项目只补了 Pi 不做的一件事：**三层遮蔽**（项目 → 全局 → 内置，与工作流规则一致），见 `src/engine/skills.ts`。

CHECK 会话 `noSkills: true`：skill 讲的是「怎么做」，把它给验证者等于诱导它同情自己评判的实现。

**导入用 `scripts/import-from-claude.mjs`，不要手改导入的文件。** 三条机械替换规则（脚本即规格）：

| # | 规则 |
|---|---|
| 1 | `调用 ralph-flow:<name> skill` → `使用 <name> skill（在可用 skill 列表中按 location 读取它）` |
| 2 | `.claude/ralph-flow/` → `.ralph-flow/` |
| 3 | 裸模型名（`model: Opus`）→ `model: "anthropic/claude-opus-4-5"`（pi-ai 只认 `provider/model`；这正是 opencode 版 doctor 会警告的写法） |

验收：`node dist/cli.js doctor` 对 4 个内置工作流 0 错 0 警，且 12 个 skill 全部列出。
