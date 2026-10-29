# UOMP

**The consent and audit layer between you and AI agents.**

Your memory stays where it is. Agents get temporary, scoped, revocable access — and you can see exactly what they read.

<p align="center">
  <a href="https://www.uomp.org">Website</a> •
  <a href="https://www.uomp.org/spec/">Protocol Spec</a> •
  <a href="https://github.com/0xSynapse/uomp-core/issues">Issues</a>
</p>

<p align="center">
  <a href="https://www.uomp.org"><img src="https://img.shields.io/badge/website-uomp.org-0A0A0A?logo=google-chrome&logoColor=white" alt="Website" /></a>
  <a href="https://www.uomp.org/spec/"><img src="https://img.shields.io/badge/spec-Draft--00-6B7280" alt="Spec" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License" /></a>
</p>

<p align="center">
  <a href="#english">English</a> | <a href="#中文">中文</a>
</p>

> **Status: early reference implementation, CLI-first.** The local loop works end-to-end: import Obsidian/Markdown notes, grant a scoped session, read through Memory Guard, inspect the audit log, and revoke. A stdio MCP server is available for early testing; Claude Desktop/Cursor validation and a browser consent UI are next. This is not production-ready yet.

---

<h2 id="english">English</h2>

### What UOMP is

UOMP is the missing layer between a user's personal context and the agents that want to use it.

Today, an agent that needs your notes, preferences, portfolio, or calendar has two bad options:

1. Ask you to upload everything to its vendor's cloud.
2. Ask for a long-lived, over-scoped API key.

Both are all-or-nothing. There is no standard way to say:

> "Read these notes for 30 minutes. Not those. Show me what you read. Stop now."

UOMP makes that sentence executable.

### Why now

- **MCP is standardizing how agents connect to tools and data** — but it does not define who is allowed to read what, for how long, or how to revoke it.
- **Personal context is fragmenting** across ChatGPT, Claude, Cursor, and vertical agents. Every app wants its own memory.
- **Memory vendors optimize recall.** Very few optimize user consent, least privilege, and audit across agents.

The opportunity is not another memory store. It is the control plane for memory access.

### What UOMP is — and what it isn't

| UOMP is | UOMP is not |
|---|---|
| A local consent, authorization, and audit layer | A new memory database or vector store |
| A way to govern access to memory you already have | A replacement for Mem0, Letta, Obsidian, or Notion |
| An open protocol plus a reference implementation | A model, agent framework, or cloud |
| Session-based, revocable, and auditable | A blockchain or FHE product today |
| Complementary to MCP | A marketplace or agent registry |

The core idea: **don't move the data; govern access to it.**

The name "User-Owned Memory Protocol" is historical. The value is the control plane, not a new storage format.

### Product thesis

1. Users will adopt a consent layer only if it gives them something useful immediately — not because it is a protocol.
2. The first useful thing is: **connect the memory you already have to the agents you already use, with control.**
3. Start with one user, one source, and one agent. Expand only after retention.

North star:

> Make it normal for a user to say: "This agent can read this part of my memory, for this task, for 30 minutes — and I can see and revoke it."

### The first real use case

**Give Claude Desktop or Cursor temporary access to your Obsidian vault.**

1. Import a local folder into UOMP: `uomp import ~/Obsidian/MyVault`.
2. The agent asks for scopes: "read project notes, not my personal journal."
3. You approve for 30 minutes in the CLI.
4. The agent reads through Memory Guard. Every access is logged.
5. You revoke. The next request fails with `403`.

The Markdown/Obsidian import and CLI consent loop now work end-to-end. A stdio MCP server is available for early testing; validating it with Claude Desktop and Cursor, plus a browser consent UI, is next.

### How it works

```
Agent (MCP client or SDK)
   │  uom.json: declares the scopes it wants
   ▼
Auth Service ── issues a short-lived capability token
   │
   ▼
Memory Guard ── checks session status, scope, expiry, and revocation
   │
   ├── existing memory source (SQLite, files, Obsidian, vector DB adapter)
   └── audit log
```

Design principles:

- **Local-first by default.** Guard listens on `127.0.0.1`; data does not leave the machine unless remote access is explicitly enabled.
- **Least privilege.** Scopes are expressed as tags, keys, and fields — not "all memory."
- **Session-bound.** Tokens expire; `revoke` and `close` take effect on the next request.
- **Auditable.** Every access decision is logged.
- **Interoperable.** UOMP is a layer over existing memory sources, not a new silo.

### What works today

| Capability | Status |
|---|---|
| Local memory store | SQLite; CSV/JSON and Obsidian/Markdown import |
| Local knowledge import | Markdown folders; frontmatter tags; path-derived scopes; `--dry-run` |
| One-command install | `install.sh` source build (Node 22 + git) |
| Agent manifest | `uom.json` with requested scopes |
| Authorization | CLI, with tag/key/field scopes and deny lists |
| MCP | stdio server with `list_memory`, `search_memory`, and `read_memory` (experimental) |
| Capability tokens | EdDSA-signed JWT, 30-minute default |
| Enforcement | Memory Guard: scope filtering, aggregation, audit log |
| Revocation | `revoke` / `close` invalidate the next request |
| Remote access | Gateway with mTLS and Cloudflare Tunnel (advanced) |
| SDK | TypeScript (`@uomp/sdk`) |
| Examples | Calendar agent and stock analyst |
| Writes | Not available in the MVP; writes return `503` |
| Admin operations | Session create/grant/revoke require a local admin token |

### What we are building next

1. **MCP hardening** — validate with Claude Desktop/Cursor, then add resources, prompts, and client setup helpers.
2. **Packaged CLI release** — npm or a standalone binary, so users do not need a local build.
3. **Consent UI** — browser-based grant/revoke, scope preview, and audit timeline. Not CLI-only.
4. **More local connectors** — beyond Obsidian/Markdown.
5. **Python SDK** — meet agent developers where most agents are built.
6. **Design partner program** — 10 users with a real weekly workflow.

### How we will measure the first milestone

- 10 design partners using UOMP with their own data.
- 3+ agents connected per user.
- 3+ uses per week for 4 consecutive weeks.
- Time to first authorized read under 5 minutes.
- At least 50% of users revoke a session — control must be felt, not just claimed.

If these numbers do not hold, we change the workflow, not add features.

### Not on the critical path

These are experiments or research directions, not the current product roadmap:

- FHE (homomorphic encryption)
- On-chain audit
- Wallet authentication and the Dropbox browser dashboard
- New storage backends (S3/IPFS)
- Agent registry/marketplace
- Agent write workflows

They remain in the repository and design docs, but we will not let them delay the first retained-user workflow. See [`docs/on-chain-audit-design.md`](docs/on-chain-audit-design.md) and [`docs/store-abstraction-design.md`](docs/store-abstraction-design.md) for the research context.

### Quick start

Requirements: Node.js >= 22 and git.

**Install**

```bash
curl -fsSL https://www.uomp.org/install.sh | bash
uomp init
```

The installer clones UOMP into `~/.uomp/cli`, builds the CLI, and links `uomp` into `~/.local/bin`. If that directory is not on your `PATH`, the script prints the line to add.

From a source checkout, run `pnpm install && pnpm build`, then use `pnpm cli ...` instead of `uomp ...`.

**Import an Obsidian / Markdown vault**

```bash
uomp import ~/Obsidian/MyVault
uomp import ~/Obsidian/MyVault --dry-run
```

Directory paths become scopes: `projects/uomp/plan.md` is tagged `notes`, `notes/projects`, and `notes/projects/uomp`. Frontmatter `tags`, `title`, and `sensitivity` are preserved.

**Authorize an agent**

```bash
uomp authorize ./examples/calendar-agent --scope preference
```

This starts the local Auth + Guard server, creates a 30-minute session, and writes the token to `~/.uomp/sessions/<sessionId>.env` with mode `0600`. It prints the exact `source` command and the revoke command. The full token is not printed by default.

**Run the agent in a second terminal**

```bash
source ~/.uomp/sessions/<sessionId>.env
node ./examples/calendar-agent/index.js
```

Keep the `authorize` terminal open while the agent runs. Use `uomp sessions` to see active sessions and `uomp revoke <sessionId>` to invalidate one immediately. `uomp audit` shows every allow/deny decision; both commands support `--json` for scripts.

If you prefer to run the server separately:

```bash
# Terminal 1
uomp serve

# Terminal 2
uomp authorize ./examples/calendar-agent --scope preference --no-server

# Terminal 3
source ~/.uomp/sessions/<sessionId>.env
node ./examples/calendar-agent/index.js
```

**Sensitive-data demo: stock analyst**

```bash
uomp import ./examples/stock-analyst/sample-risk.json --replace
uomp import ./examples/stock-analyst/sample-holdings.csv \
  --tag portfolio:holdings --sensitivity high --replace

uomp authorize ./examples/stock-analyst \
  --scope portfolio:holdings profile:risk

# In a second terminal, source the env file printed above, then run:
source ~/.uomp/sessions/<sessionId>.env
node ./examples/stock-analyst/index.js
```

**Developer shortcut**

```bash
uomp agent run ./examples/calendar-agent
```

> Admin operations (`createSession`, `grant`, `revoke`) require the local admin token stored at `~/.uomp/.secrets/admin-token`. The Node SDK only reads `UOMP_ADMIN_TOKEN` when the base URL is loopback.

### Use with Claude Desktop / Cursor (experimental)

The CLI includes a stdio MCP server with three tools: `list_memory`, `search_memory`, and `read_memory`. `list_memory` and `search_memory` return keys and metadata only; `read_memory` returns content. Every call still goes through Memory Guard scope, expiry, revocation, and audit.

The MCP server is only a stdio bridge; keep the UOMP HTTP server running:

```bash
# Terminal 1
uomp serve

# Terminal 2
uomp import ~/Obsidian/MyVault
uomp authorize ./examples/mcp-client \
  --scope notes/projects \
  --output ~/.uomp/mcp-client.env \
  --no-server

uomp mcp --session ~/.uomp/mcp-client.env --print-config
```

Paste the output into your MCP client config. It looks like:

```json
{
  "mcpServers": {
    "uomp": {
      "command": "/usr/local/bin/node",
      "args": [
        "/home/me/.uomp/cli/src/packages/cli/dist/cli.js",
        "mcp",
        "--session",
        "/home/me/.uomp/mcp-client.env"
      ]
    }
  }
}
```

Restart the client, then ask it to list notes under `notes/projects` and read one. Keep the `uomp serve` terminal running. The MCP server re-reads the env file on startup and before every tool call. With a fixed `--output` path, re-run `uomp authorize` and the next call picks up the new token; if `--session` points at a session ID instead, restart the client. A custom `--output` file is not removed by `uomp revoke`.

Validated with the official MCP SDK and OpenCode v2.2.0. Claude Desktop/Cursor validation is still pending.

### Security model

UOMP enforces:

- the token's tag/key/field scope;
- session expiry;
- immediate revocation after `revoke` or `close`;
- an audit record for every request.

UOMP does **not** protect against:

- a malicious process running as the same OS user (it can read `~/.uomp` and the admin token);
- an authorized agent retaining plaintext it received;
- a compromised user machine;
- a malicious agent that ignores the scopes it was granted.

This is why the project does not claim "trustless." The goal is **informed consent, least privilege, revocation, and audit** — not a guarantee that an authorized agent forgets what it saw.

### Project structure

```
packages/
  core/       shared types and constants
  store/      memory store and adapter interfaces
  token/      capability token issuance and verification
  auth/       session and admin authorization
  guard/      scope enforcement and audit
  sdk/        TypeScript client
  cli/        `uomp` command-line tool
apps/
  server/     combined Auth + Guard service
  gateway/    remote access (mTLS + tunnel)
  relay/      stateless relay (preview)
examples/
  calendar-agent/
  stock-analyst/
  mcp-client/
  browser-dashboard/  (preview)
specs/
  draft-00.md
```

### Get involved

We are looking for **10 design partners** who:

- use at least two AI agents regularly;
- keep personal or project knowledge in local files, Obsidian, or a similar tool;
- are willing to try a weekly workflow and give direct feedback.

Open an issue or read the protocol draft:

- [Issues](https://github.com/0xSynapse/uomp-core/issues)
- [Protocol draft](https://www.uomp.org/spec/)

### License

Apache 2.0. See [`LICENSE`](LICENSE).

---

<h2 id="中文">中文</h2>

### UOMP 是什么

**UOMP 是用户和 AI Agent 之间的授权、撤销与审计层。**

你的记忆留在原来的地方。Agent 只获得临时、限定范围、可撤销的访问权限，并且你能看到它到底读了什么。

今天，一个需要你的笔记、偏好、持仓或日历的 Agent，通常只有两个选择：

1. 让你把所有数据上传到它的云端；
2. 向你要一个长期、过宽的 API key。

两者都是“全有或全无”。用户没有一个标准方式表达：

> “这 30 分钟可以读这些笔记，不能读那些；告诉我你读了什么；现在停止。”

UOMP 就是让这句话可执行的那一层。

### 为什么是现在

- **MCP 正在标准化 Agent 连接工具和数据的方式**，但它没有定义“谁可以读什么、读多久、如何撤销”。
- **个人上下文正在分裂**：ChatGPT、Claude、Cursor 和垂直 Agent 各存一份记忆。
- **记忆厂商优化的是召回率**，很少有人优化跨 Agent 的用户同意、最小权限和审计。

机会不是再做一个记忆库，而是做记忆访问的控制面。

### UOMP 是什么，不是什么

| UOMP 是 | UOMP 不是 |
|---|---|
| 本地授权、撤销与审计层 | 新的记忆数据库或向量库 |
| 治理你已有记忆的访问方式 | Mem0、Letta、Obsidian、Notion 的替代品 |
| 开放协议 + 参考实现 | 模型、Agent 框架或云服务 |
| 基于会话、可撤销、可审计 | 今天的区块链或 FHE 产品 |
| MCP 的补充层 | Agent 市场或 Registry |

核心思想：**不要搬数据，治理对数据的访问。**

“User-Owned Memory Protocol”这个名字是历史产物。真正的价值在控制面，而不是新的存储格式。

### 产品判断

1. 用户只会采用一个授权层，前提是它立刻带来实际价值——而不是因为它是一个协议。
2. 第一个实际价值是：**把你已经有的记忆，接给你已经在用的 Agent，并且保持控制。**
3. 先做一个用户、一个数据源、一个 Agent。留存成立后再扩展。

北极星：

> 让用户习惯说：“这个 Agent 可以为这次任务读这部分记忆，30 分钟，我能看见，也能随时撤销。”

### 第一个真实场景

**让 Claude Desktop 或 Cursor 临时访问你的 Obsidian 笔记库。**

1. 用 `uomp import ~/Obsidian/MyVault` 导入一个本地目录，或接入已有的记忆源。
2. Agent 声明范围：“读项目笔记，不读私人日记。”
3. 你在 CLI 里批准 30 分钟。
4. Agent 通过 Memory Guard 读取，每次访问都有日志。
5. 你撤销，下一个请求直接 `403`。

Markdown/Obsidian 导入和 CLI 授权闭环现在已经跑通。stdio MCP server 已经可以早期试用；接下来是用 Claude Desktop / Cursor 验证，以及浏览器授权界面。

### 工作方式

```
Agent（MCP 客户端或 SDK）
   │  uom.json：声明它想要的范围
   ▼
Auth Service ── 签发短期 Capability Token
   │
   ▼
Memory Guard ── 校验会话状态、范围、过期时间、是否已撤销
   │
   ├── 已有的记忆源（SQLite、文件、Obsidian、向量库适配器）
   └── 审计日志
```

设计原则：

- **默认本地优先。** Guard 监听 `127.0.0.1`；除非显式开启远程访问，数据不离开本机。
- **最小权限。** 范围用 tags、keys、fields 表达，而不是“全部记忆”。
- **会话绑定。** Token 会过期；`revoke` / `close` 在下一个请求立即生效。
- **可审计。** 每次访问决策都有日志。
- **可互操作。** UOMP 是已有记忆源之上的一层，不是新的数据孤岛。

### 今天已经可用

| 能力 | 状态 |
|---|---|
| 本地记忆存储 | SQLite，支持 CSV/JSON 和 Obsidian/Markdown 导入 |
| 本地知识导入 | Markdown 目录、frontmatter tags、按路径生成范围、`--dry-run` |
| 一条命令安装 | `install.sh` 源码构建（Node 22 + git） |
| Agent 声明 | `uom.json`，声明请求范围 |
| 授权 | CLI，支持 tag/key/field 范围和 deny 列表 |
| MCP | stdio server，提供 `list_memory`、`search_memory` 和 `read_memory`（实验） |
| Capability Token | EdDSA 签名 JWT，默认 30 分钟 |
| 执行 | Memory Guard：范围过滤、聚合、审计日志 |
| 撤销 | `revoke` / `close` 后下一个请求失效 |
| 远程访问 | Gateway + mTLS + Cloudflare Tunnel（高级） |
| SDK | TypeScript（`@uomp/sdk`） |
| 示例 | Calendar Agent、Stock Analyst |
| 写入 | MVP 不支持，写入返回 `503` |
| 管理员操作 | create/grant/revoke 需要本机管理员令牌 |

### 下一步做什么

1. **MCP 完善**：先用 Claude Desktop / Cursor 验证，再补 resources、prompts 和客户端配置助手。
2. **打包发布 CLI**：npm 或独立二进制，用户不需要本地构建。
3. **授权界面**：浏览器里完成授权/撤销、范围预览、审计时间线，不再只靠 CLI。
4. **更多本地连接器**：在 Obsidian/Markdown 之外继续扩展。
5. **Python SDK**：去 Agent 开发者最多的地方。
6. **设计伙伴计划**：10 个有真实每周工作流的用户。

### 第一个里程碑怎么衡量

- 10 个设计伙伴用自己的数据使用 UOMP。
- 每个用户连接 3 个以上 Agent。
- 连续 4 周、每周使用 3 次以上。
- 首次授权到第一次读取的时间小于 5 分钟。
- 至少 50% 的用户使用过撤销——控制权必须被真实感受到。

如果这些数字不成立，就换场景，不要加功能。

### 不在当前主线上

以下是实验或研究方向，不是当前产品路线图：

- FHE（全同态加密）
- 链上审计
- 钱包登录和 Dropbox 浏览器 Dashboard
- 新的存储后端（S3/IPFS）
- Agent Registry / 市场
- Agent 写入流程

它们会留在仓库和设计文档里，但不会拖慢第一个留存闭环。研究背景见 [`docs/on-chain-audit-design.md`](docs/on-chain-audit-design.md) 和 [`docs/store-abstraction-design.md`](docs/store-abstraction-design.md)。

### 快速开始

环境要求：Node.js >= 22 和 git。

**安装**

```bash
curl -fsSL https://www.uomp.org/install.sh | bash
uomp init
```

安装脚本会把 UOMP 克隆到 `~/.uomp/cli`，构建 CLI，并把 `uomp` 链接到 `~/.local/bin`。如果这个目录不在 `PATH` 里，脚本会打印需要添加的那一行。

从源码运行时，执行 `pnpm install && pnpm build`，然后用 `pnpm cli ...` 代替 `uomp ...`。

**导入 Obsidian / Markdown 笔记库**

```bash
uomp import ~/Obsidian/MyVault
uomp import ~/Obsidian/MyVault --dry-run
```

目录路径会变成授权范围：`projects/uomp/plan.md` 会带上 `notes`、`notes/projects`、`notes/projects/uomp` 三个 tag。Frontmatter 里的 `tags`、`title`、`sensitivity` 会保留。

**授权一个 Agent**

```bash
uomp authorize ./examples/calendar-agent --scope preference
```

这条命令会启动本地 Auth + Guard server，创建 30 分钟会话，并把 token 写入 `~/.uomp/sessions/<sessionId>.env`（权限 `0600`）。它会打印需要执行的 `source` 命令和撤销命令；默认不打印完整 token。

**在第二个终端运行 Agent**

```bash
source ~/.uomp/sessions/<sessionId>.env
node ./examples/calendar-agent/index.js
```

Agent 运行期间保持 `authorize` 终端打开。`uomp sessions` 查看活跃会话，`uomp revoke <sessionId>` 立即撤销。`uomp audit` 查看每次允许/拒绝决策；两个命令都支持 `--json`，方便脚本处理。

如果你想分开运行 server：

```bash
# 终端 1
uomp serve

# 终端 2
uomp authorize ./examples/calendar-agent --scope preference --no-server

# 终端 3
source ~/.uomp/sessions/<sessionId>.env
node ./examples/calendar-agent/index.js
```

**高敏感数据示例：Stock Analyst**

```bash
uomp import ./examples/stock-analyst/sample-risk.json --replace
uomp import ./examples/stock-analyst/sample-holdings.csv \
  --tag portfolio:holdings --sensitivity high --replace

uomp authorize ./examples/stock-analyst \
  --scope portfolio:holdings profile:risk

# 在第二个终端 source 上面打印的 env 文件，然后运行：
source ~/.uomp/sessions/<sessionId>.env
node ./examples/stock-analyst/index.js
```

**开发者快捷方式**

```bash
uomp agent run ./examples/calendar-agent
```

> 管理员操作（`createSession`、`grant`、`revoke`）需要本机管理员令牌，默认存放在 `~/.uomp/.secrets/admin-token`。Node SDK 仅在 base URL 为 loopback 时读取 `UOMP_ADMIN_TOKEN`。

### 配合 Claude Desktop / Cursor 使用（实验）

CLI 内置一个 stdio MCP server，提供三个工具：`list_memory`、`search_memory` 和 `read_memory`。`list_memory` 和 `search_memory` 只返回 key 和元数据，`read_memory` 返回内容。每次调用仍然经过 Memory Guard 的范围、过期、撤销和审计。

MCP server 只是一个 stdio 桥接；UOMP HTTP server 需要保持运行：

```bash
# 终端 1
uomp serve

# 终端 2
uomp import ~/Obsidian/MyVault
uomp authorize ./examples/mcp-client \
  --scope notes/projects \
  --output ~/.uomp/mcp-client.env \
  --no-server

uomp mcp --session ~/.uomp/mcp-client.env --print-config
```

把输出粘贴到 MCP 客户端配置里。它看起来像：

```json
{
  "mcpServers": {
    "uomp": {
      "command": "/usr/local/bin/node",
      "args": [
        "/home/me/.uomp/cli/src/packages/cli/dist/cli.js",
        "mcp",
        "--session",
        "/home/me/.uomp/mcp-client.env"
      ]
    }
  }
}
```

重启客户端，然后让它列出 `notes/projects` 下的笔记并读取其中一条。保持 `uomp serve` 终端运行。MCP server 会在启动时和每次工具调用前重新读取 env 文件。使用固定的 `--output` 路径时，重新执行 `uomp authorize` 后下一次调用会自动使用新 token，不需要重启客户端；如果 `--session` 直接指向 session ID，则需要重启。自定义 `--output` 文件不会被 `uomp revoke` 自动删除。

已用官方 MCP SDK 和 OpenCode v2.2.0 验证。Claude Desktop / Cursor 的验证仍在进行。

### 安全模型

UOMP 会强制执行：

- Token 的 tag/key/field 范围；
- 会话过期；
- `revoke` / `close` 后立即失效；
- 每次请求的审计记录。

UOMP 不能防护：

- 以同一 OS 用户运行的恶意进程（它可以读 `~/.uomp` 和管理员令牌）；
- 被授权的 Agent 保留它收到的明文；
- 被攻陷的用户机器；
- 无视授权范围的恶意 Agent。

所以这个项目不会宣称“trustless”。目标是 **知情同意、最小权限、可撤销、可审计**，而不是保证被授权的 Agent 会忘记它看到过什么。

### 项目结构

```
packages/
  core/       共享类型和常量
  store/      记忆存储和适配器接口
  token/      Capability Token 签发与验证
  auth/       会话与管理员授权
  guard/      范围执行与审计
  sdk/        TypeScript 客户端
  cli/        `uomp` 命令行工具
apps/
  server/     Auth + Guard 组合服务
  gateway/    远程访问（mTLS + 隧道）
  relay/      无状态中继（预览）
examples/
  calendar-agent/
  stock-analyst/
  mcp-client/
  browser-dashboard/  （预览）
specs/
  draft-00.md
```

### 参与进来

我们在找 **10 个设计伙伴**：

- 经常使用至少两个 AI Agent；
- 个人或项目知识保存在本地文件、Obsidian 或类似工具里；
- 愿意尝试一个每周工作流，并直接给反馈。

欢迎开 issue 或阅读协议草案：

- [Issues](https://github.com/0xSynapse/uomp-core/issues)
- [协议草案](https://www.uomp.org/spec/)

### License

Apache 2.0，见 [`LICENSE`](LICENSE)。
