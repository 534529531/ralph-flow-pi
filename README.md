# ralph-flow-pi

[![npm version](https://img.shields.io/npm/v/ralph-flow-pi?label=npm&logo=npm)](https://www.npmjs.com/package/ralph-flow-pi)
[![npm downloads](https://img.shields.io/npm/dm/ralph-flow-pi?label=downloads&logo=npm&color=red)](https://www.npmjs.com/package/ralph-flow-pi)
[![License: MIT](https://img.shields.io/npm/l/ralph-flow-pi?label=license)](https://github.com/534529531/ralph-flow-pi/blob/main/LICENSE)

**让 AI 自己把任务做完、自己验证、失败了自己重试 —— 不用你盯着，也不用你反复复制粘贴报错信息。**

命令行工具，基于 [Pi SDK](https://github.com/earendil-works/pi) 构建，是 [ralph-flow](https://github.com/534529531/ralph-flow)（opencode 插件版）的独立 CLI 重写。
<img width="3838" height="2160" alt="Screenshot from 2026-07-18 23-31-43" src="https://github.com/user-attachments/assets/a454e614-47e6-4b72-9739-fd423dd2f741" />

<img width="3840" height="2159" alt="Screenshot from 2026-07-18 23-31-02" src="https://github.com/user-attachments/assets/19637238-de26-40bb-a36c-10ef1b40f00f" />

<img width="3835" height="2160" alt="Screenshot from 2026-07-18 23-30-20" src="https://github.com/user-attachments/assets/8945b4a5-f06d-4a3b-977e-acba248ddac3" />



## 特性

- **不怕聊天越聊越长** —— 每一步都在一个全新会话里执行，不会因为任务做到第 7 步、聊天记录已经很长了，模型就开始丢三落四、跑偏方向
- **验证者不会官官相护** —— 验证这一步是独立开的只读会话，看不到你是怎么改的，只看结果说话；甚至可以指定用另一个模型当裁判（比如用 GPT 验证 Claude 写的代码）
- **崩溃 / 关掉重开不丢进度** —— 每一步的会话记录会落盘，中断后接着原来的会话继续，不用整个重来
- **界面就是聊天，随时能插话** —— 工作流跑起来时屏幕会自动切到实时视图，但直接打字就是在指挥它；按 `Esc` 随时退回聊天，工作流照常在后台跑，等你回来看
- **老工作流 YAML 直接能用** —— 迁移自插件版 ralph-flow，工作流定义和 7 个斜杠命令零改动兼容

## 快速开始

### 前置条件

- [Node.js](https://nodejs.org/) 20+
- 一个 Pi SDK 支持的模型账号或 API key（Anthropic / OpenAI / Gemini 等都行，见下面「配置模型凭据」）
- **macOS 或 Linux**。本工具基于 [Pi SDK](https://github.com/earendil-works/pi)，Pi 在 Windows 上支持较差（WSL 下可以正常运行）

### 安装

```bash
npm install -g ralph-flow-pi
```

或者不装，直接跑一次：

```bash
npx ralph-flow-pi
```

**从源码构建**（贡献代码用）：

```bash
git clone https://github.com/534529531/ralph-flow-pi.git
cd ralph-flow-pi
npm install
npm run build
node dist/cli.js
```

想在任意目录用 `ralphflow` 命令，在仓库目录下跑一次 `npm link`。

### 验证安装

```bash
ralphflow doctor
```

看到类似下面的输出说明装好了：

```
## 概览
- 可启动工作流：4 个
- 有问题的定义文件：0 个
...
```

### 配置模型凭据

第一次进 `ralphflow` 之后，在聊天里输入 `/login` 按提示登录；或者提前设好环境变量，比如：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

支持的 provider 很多（Anthropic、OpenAI、Gemini、Bedrock、OpenRouter 等），凭据体系是 Pi SDK 自己的，跟本工具无关。

## 使用方法

### 入口就是聊天

```bash
ralphflow
```

跟直接用 Claude Code 聊天没有区别——写代码、回答问题、聊需求都行，工作流只是聊天里能让它做的一件事。第一次用建议先跑一个小任务（比如"用 loop 工作流帮我建一个 hello.txt"），确认整条链路通了，再上真任务。

### 斜杠命令

| 命令 | 作用 | 什么时候用 |
|------|------|-----------|
| `/ralphflow-start` | 启动工作流（新实例） | 开始一个新任务，一句话里说清楚工作流名和任务描述 |
| `/ralphflow-continue` | 通过人工审查门 / 恢复暂停 / 接管中断实例 | 审查通过后 / 工作流暂停后 / 新会话续接 |
| `/ralphflow-watch` | 重新接管一个还在跑、你之前 `Esc` 退出的实例 | 想回去看看进度 |
| `/ralphflow-status` | 查看状态 | 想知道进展到哪了 |
| `/ralphflow-list` | 列出可用工作流 + 活跃实例 | 查看有哪些工作流/实例 |
| `/ralphflow-cancel` | 取消工作流实例 | 放弃当前任务 |
| `/ralphflow-create` | 交互式设计并创建自定义工作流 | 想定制自己的流程，不想手写 YAML |
| `/ralphflow-doctor` | 诊断所有工作流定义和实例状态 | 自定义工作流不生效 / 启动报错 / 例行体检 |

这些命令不是严格的位置参数，而是自然语言驱动：`/ralphflow-start` 需要你在同一句话里说清楚**用哪个工作流**和**做什么任务**，比如：

```
/ralphflow-start 用 loop 工作流，修复登录页面的表单验证 bug
```

工作流名或任务没说清楚，模型会直接问你，不会自己瞎猜。

### headless 子命令（不进交互界面，适合脚本 / CI）

```bash
ralphflow status [实例ID]   # 查看实例（不带 ID 时列出全部，支持 ID 唯一前缀）
ralphflow list               # 列出工作流与活跃实例
ralphflow doctor             # 诊断所有工作流定义与 skill
ralphflow continue [实例ID]  # 恢复暂停/审查门/崩溃的实例，跑到下一个停点再返回
ralphflow cancel [实例ID]    # 取消并归档报告
```

`continue` 是唯一"做完事之后还会继续跑一段"的 headless 命令——它恢复实例后驱动到下一次停下来（再次需要人工审查/暂停，或者完成）才退出进程，不会把自己变成一个常驻后台的守护进程。`create` 天生需要一段对话，没有 headless 形式。

## 内置工作流

| 名称 | 用途 |
|---|---|
| `loop` | 检查点驱动：先拆解任务为检查点清单，再循环执行直到全部通过 |
| `spec` | 需求分析 → 规格 → 设计 → 任务拆解 → 实现 → 验收 → 归档，适合完整功能开发 |
| `c-to-rust` | C 项目翻译为惯用安全 Rust，逐模块渐进移植 + TDD |
| `everything2rust` | 任意语言的系统重写为 Rust，行为契约 + 独立审计的方法论，适合大改造 |

### loop — 检查点驱动循环

适用场景：范围明确的单个任务。

```
帮我用 loop 工作流修复登录页面的表单验证 bug
帮我用 loop 工作流给 user.py 加单元测试，覆盖率 > 80%
```

```
checkpoints（拆解需求为可验证的检查点清单）
    ↓
loop（逐项实现并自验，直到全部打勾；最多重试 100 次）
    ↓
完成
```

### spec — 规格驱动开发

适用场景：需要从需求到实现的完整流程。

```
propose → specs → design → tasks → implement → verify → archive
```

每一步的产出文件都归档在 `.ralph-flow/artifacts/` 下，一路能看到 proposal.md、specs.md、design.md、tasks.md 等。

### c-to-rust / everything2rust

这两个是这个项目独有、插件版没有的能力：专门把现有代码库重写成 Rust。`c-to-rust` 针对 C 项目；`everything2rust` 更通用，能处理任意语言的项目，走的是"先摸清系统行为契约、再增量实现、再独立审计"的方法论，步骤更多、耗时更长，适合真正的大改造而不是小任务。`everything2rust` 的 `design` 步骤默认是人工审查门（见下）。

## 工作流机制详解

### 执行（DO）与验证（CHECK）

每一步分两段：AI 先执行任务（DO），完成后交给**另一个独立的只读会话**验证（CHECK）——验证者看不到你是怎么改的，只能通过检查实际结果来判断，通过则自动进入下一步，不通过则带着失败原因自动重试。

### 失败重试

CHECK 不通过时：
1. 失败次数 +1，若小于该步骤的 `max_fail_count`，自动重试同一步骤
2. 重试时会把上次失败原因带给 DO，避免重复犯同一个错
3. 达到 `max_fail_count` 仍不通过，工作流**暂停**，等你介入

### 人工审查门（manual_step）

某些步骤会在 DO 完成后主动停下来等你看一眼，比如 `everything2rust` 的 `design` 步骤（技术方案定下来了，值得你看一眼再往下走）：

```
DO 完成 → 停下来提示你审查
    → 满意：/ralphflow-continue 通过 → 进入 CHECK → 通过则自动继续
    → 不满意：直接打字说要改什么 → 模型修改后再次进入审查门
```

### 随时插话，随时退出

工作流跑的时候屏幕会自动接管成实时运行视图（步骤条 + 当前阶段耗时），但**这不是另一个 App，是同一个聊天会话借用了同一块终端**：

- DO 执行中直接打字就是插话，模型会把你说的话接进去接着干
- `Esc`（输入框为空时）随时退回聊天，工作流**不会停**，继续在后台跑；需要你时（人工审查/暂停/完成）会自动出现在聊天记录里，同时响一声终端提示音
- 想再看，直接说"带我看看"，或者打 `/ralphflow-watch`——模型不会自己主动去查，只有你要求时才会

### 多实例并行

同一个聊天会话可以同时跑多个工作流实例——`ralphflow_start` 不会因为你已经有一个在跑就拒绝新的一个。开几个聊天会话也一样能各自并行跑；`status`/`list` 能看到当前所有活跃实例，`continue`/`watch`/`cancel` 都支持用实例 ID 的唯一前缀指定目标。唯一的限制是终端画面本身一次只能接管着看一个实例的实时运行视图——`Esc` 退出一个再 `/ralphflow-watch` 另一个即可切换，其余实例在后台不受影响地继续跑。

## 实际使用示例

### 全自动跑完一个简单任务

```
你: 帮我用 loop 工作流修复 user.py 里的空指针异常

[屏幕自动接管为运行视图]

  ✓ ✓ ▶ ○ ○      loop · DO  0:42
  ▸ 读取 user.py，定位空指针触发点...
  ▸ 编写修复，运行测试...

  ✓ ✓ ✓ ○ ○      loop · CHECK  0:08
  独立会话正在核对修复是否生效...

  ✅ 工作流完成！报告已归档到 .ralph-flow/reports/
```

### CHECK 不通过，自动重试一次

```
✓ ✓ ✗（1/5）      loop · CHECK 失败
原因：进度条组件未实现，拖拽区域缺少样式。

[自动带着失败原因重新进入 DO]

  ▸ 补充进度条组件，补齐样式...

✓ ✓ ✓ ○ ○         CHECK 通过

✅ 工作流完成！
```

### 人工审查门

```
✓ ✓ ▶（design，等待审查）

设计方案已经写好，看看 .ralph-flow/artifacts/.../design.md，
觉得可以就 /ralphflow-continue，不行就直接说要改哪里。

你: 用 trait 而不是 enum 来抽象这层，方便以后加新后端

[模型修改设计，再次停在审查门]

你: /ralphflow-continue

[进入独立验证 → 通过 → 自动继续后续步骤]
```

### Esc 退出，后台照跑，回来再看

```
你: 帮我跑一下 spec 工作流，实现登录接口

[自动接管为运行视图，DO 正在跑...]

[按 Esc]

引擎: 已切回聊天。工作流在后台继续运行。
      想再看实时进度：直接说"看着它跑"，或者输入 /ralphflow-watch。

你: 今天北京天气怎么样？

引擎: [正常回答天气，不会顺手提起工作流，也不会自己跑去查状态]

（几分钟后，CHECK 通过、工作流完成）

引擎: 🔔 spec 工作流完成了，报告在 .ralph-flow/reports/。
```

## 自定义工作流

### 交互式创建（推荐）

打 `/ralphflow-create` 或者 `ralphflow create`，描述你想自动化的流程，模型会和你一起设计步骤图、生成 YAML，并自己跑 `doctor` 校验到零问题，写完即可用。

### 手写 YAML

工作流可以放在两个位置，解析顺序 **项目 → 全局 → 内置**（同名时靠前的遮蔽靠后的）：

| 位置 | 作用范围 |
|---|---|
| `.ralph-flow/workflows/` | 仅本项目 |
| `~/.config/ralph-flow-pi/workflows/` | 全局，所有项目可用，更新不会覆盖 |

```yaml
description: 先分析再实现

steps:
  - id: analyze
    desc: 任务分析
    do: 分析需求，产出设计文档。
    input: 用户需求
    output: "design.md"
    check: 打开 design.md，核对是否完整、技术上合理。
    on_pass: execute
    on_fail: analyze
    max_fail_count: 3

  - id: execute
    desc: 实现
    do: 按设计实现，跑测试直到全绿。
    input: design.md
    output: 测试通过的可工作代码
    check: 自己跑测试套件，核对实现与 design.md 一致。
    on_pass: done
    on_fail: execute
    max_fail_count: 5
```

写完运行 `ralphflow doctor` 校验。**记住一件事**：每个步骤是全新的上下文窗口，步骤之间**只有** `input`/`output` 里写的话和 artifacts 目录里的文件会传过去——需要上一步的结论，就明确写出它在哪个文件里。

### 跨模型对抗验证

```yaml
adversarial_check:
  model: "openai/gpt-5.2"    # 用 GPT 验证 Claude 写的代码
  timeout_ms: 1800000
```

检查者与执行者不同源，同源偏见被结构性削弱——这是插件版做不到的，它锁死在单一宿主的模型上。

### CHECK 阶段的自定义命令

CHECK 阶段默认只放行一份内置的 bash 白名单（`cat`/`grep`/`git diff`/`cargo test`/`npm test`/`pytest` 等）。如果你的项目用自定义 CLI、`just`、`bazel`、`./scripts/check.sh` 这类命令，需要显式声明：

```yaml
adversarial_check:
  extra_allowed_bash:
    - "./scripts/check.sh *"
    - "just test*"
```

`ralphflow doctor` 会报告每条被拒绝的模式及原因；`rm`/`curl`/`sudo`/`git`/`npm` 等约 50 个命令永远无法通过这个字段打开。

## 常见问题

**loop 还是 spec 怎么选？**

任务范围明确、一个人一天能干完的用 `loop`（修 bug、写测试、重构、写文档）；需要从需求到实现走完整流程的用 `spec`（新功能开发、架构改造）。拿不准就 `/ralphflow-create` 让它帮你设计。

**验证会不会很慢、很贵？**

可以给 CHECK 指定更便宜更快的模型：

```yaml
adversarial_check:
  model: "anthropic/claude-haiku-4-5"
  timeout_ms: 600000
```

**验证失败了，但我觉得它判错了？**

CHECK 是一次独立、只读的判断，也会看漏东西。趁 DO 重试阶段插一句话说明情况，模型会带着你的说明一起处理；如果已经暂停了，`/ralphflow-continue` 时也可以先留一句话。

**能同时跑多个工作流吗？**

能，而且不需要开多个聊天会话——一个会话就可以同时启动、驱动多个工作流实例，`/ralphflow-status`、`/ralphflow-list` 随时能看到全部。想同时跑多个会话也一样支持，互不干扰。

**状态存在哪？**

`.ralph-flow/instances/<实例ID>/state.json`，完成或取消后实例目录清理，最终报告归档到 `.ralph-flow/reports/`。

## 故障排查

**`ralphflow` 命令找不到**

确认 `npm install -g ralph-flow-pi`（或 `npm link`）成功：

```bash
npm ls -g --depth=0 | grep ralph-flow-pi
```

**`ralphflow list` 里没有我自定义的工作流**

跑 `ralphflow doctor`，它会告诉你这份 YAML 生效的是哪个文件、有没有被同名文件遮蔽、以及具体校验错误（不止第一条）。

**YAML 解析失败**

常见原因：缩进用了 Tab（应该用空格）、特殊字符没加引号、缺少必填字段（`id`/`desc`/`on_pass`/`on_fail`/`max_fail_count`）。

**模型没反应 / 提示凭据错误**

确认 `/login` 走完了流程，或者对应 provider 的环境变量（如 `ANTHROPIC_API_KEY`）已经设置。

**Windows 上运行报错**

Pi SDK 对 Windows 原生支持有限，推荐在 WSL2 中安装使用。在 WSL 终端里执行 `npm install -g ralph-flow-pi` 即可。

**Esc 退出后忘了怎么回去看进度**

直接说"帮我看看工作流跑得怎么样了"，或者打 `/ralphflow-watch`；忘了实例名先 `/ralphflow-list` 或 `ralphflow list`。

## 文件存储结构

```
你的项目/
└── .ralph-flow/
    ├── instances/<实例ID>/       # 运行时状态，完成/取消后清理
    │   ├── state.json
    │   ├── state-stack.json      # 子工作流栈
    │   └── sessions/             # 每次 DO/CHECK 尝试的会话记录
    ├── artifacts/<任务摘要>/     # 工作流产出的文档，长期保留
    ├── reports/                  # 完成/取消后的最终报告
    │   └── <实例ID>-final-report.md
    ├── workflows/                # 项目自定义工作流（仅本项目，优先级最高）
    └── logs/                     # 执行日志

~/.config/ralph-flow-pi/
└── workflows/                    # 全局自定义工作流（所有项目可用）
```

## 从插件版迁移

- **工作流 YAML**：直接可用，零改动
- **数据目录**：本包用 `.ralph-flow/`，不会自动迁移插件版已有的实例——迁移前先把在跑的工作流跑完或取消
- **`adversarial_check.agent`**：接受但忽略（本引擎没有 agent 概念，只读沙箱是内置的），`ralphflow doctor` 会提示
- **裸模型名**（`model: sonnet`）：需改成 `"anthropic/claude-sonnet-4-5"` 这种带 provider 前缀的写法，`ralphflow doctor` 会提示

## 开发

```bash
npm install
npm run build
npm test              # 401 个测试，无需 API key
ralphflow doctor
```

从上游插件重新同步领域 skill 与工作流：

```bash
node scripts/import-from-claude.mjs <claude-plugin-path>
```

不要手改导入的文件——机械替换规则和三个实现之间必须逐字一致的语义边界见 [SYNC.md](SYNC.md)。

## 已知边界

- Pi SDK 处于 0.x 且迭代很快，版本精确 pin，所有 SDK 接触收口在 `src/pi/` 一处，升级前先跑 `adapter.test.ts` 这道门。
- CHECK 阶段的 bash 白名单是黑名单式的逐条排查（拦截命令替换、写重定向、脚本内嵌写语法等），不是形式化证明的沙箱。它管的是命令的**名字和语法**，不管被放行的程序运行时实际做了什么——`cargo test`/`npm test` 一旦放行就会真的执行你的测试代码/构建脚本，拿到进程的完整权限。这跟你自己手动跑一遍项目测试套件时承担的信任边界是一样的，需要更强隔离时应该把整个 `ralphflow` 进程放进容器，而不是指望这份白名单。

MIT
