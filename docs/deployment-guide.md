# UOMP 部署模式指南

> **状态（2026-10）：** 当前主线是本地 CLI + MCP 闭环；浏览器/钱包模式和远程 Gateway 属于高级或预览能力。日常本地使用请先看 [README Quick start](../README.md#quick-start)。

## 概述

UOMP 支持三种部署模式。当前推荐本地模式；远程和浏览器模式属于高级/预览能力。

| 模式 | 用户需要做什么 | 适用场景 |
|------|--------------|---------|
| **本地模式（推荐）** | 安装 CLI | Node.js Agent 在同一台机器 |
| **远程模式（高级）** | 启动 Gateway + Tunnel | Agent 在云服务 / 另一台机器 |
| **浏览器模式（预览）** | 连接钱包 → 签名 | Web App、Dashboard |

---

## 1. 浏览器模式（预览，零安装）

> 预览能力：浏览器/钱包流程不在当前核心路径上，下面的 demo 和集成示例仅用于研究与早期反馈。

用户不需要安装 CLI、不需要启动 Gateway。只需要浏览器和钱包。

### 在线 Demo

👉 **[https://www.uomp.org/dashboard/](https://www.uomp.org/dashboard/)**

### 流程

```
打开页面 → 点 MetaMask / Argent X → 签名 "UOMP Store v1"
  → 编辑持仓（表格直接编辑或导入 CSV）
  → 💾 Save（AES-256 加密到浏览器 localStorage）
  → 📊 Analyze（浏览器内分析：P&L、HHI、行业分布）
  → 或发送到 DO Agent 做深度分析
```

无需 Gateway。无需 CLI。无需服务器。分析在浏览器内或直接发送到已部署的 Agent。

### 1.3 Webapp 开发者集成

```ts
import { BrowserSDK, UompClient } from '@uomp/sdk/browser';

// 方式 1：从钱包签名初始化（推荐）
const uomp = await BrowserSDK.fromWallet();
// → MetaMask/Argent X 弹窗 → 签名 → 派生 masterKey
// → 自动从 S3 拉取加密数据 → 解密 → 就绪

// 方式 2：从 sessionStorage 恢复（Token + Gateway URL）
const uomp = BrowserSDK.createFromStorage();

// 方式 3：从 URL hash 自动读取
// https://my-app.com/#token=eyJhbG...&gateway=https://my-gateway.example.com
const { token, gateway } = BrowserSDK.fromUrlHash();
```

### 1.4 读操作（不需要 Gateway）

```ts
// 浏览器 SDK 自动路由：
// Gateway 在线 → 走 Gateway（有 scope 过滤 + 审计日志）
// Gateway 不在线 → 走 S3 直读 + 浏览器内解密

const holdings = await uomp.memory.getByTag('portfolio:holdings');
const risk = await uomp.memory.getByTag('profile:risk');
const item = await uomp.memory.get('AAPL');

// 离线检测
if (!uomp.isGatewayOnline) {
  console.log('只读模式 — 启动 Gateway 后可写入');
}
```

### 1.5 写操作（需要 Gateway 或 Cloud Relay）

```ts
// 写操作自动走 Cloud Relay（如果配置了）
// Cloud Relay 总是在线，不需要用户启动 Gateway

await uomp.memory.set('AAPL', {
  symbol: 'AAPL',
  quantity: 150,
  cost_basis: 155.00,
});

// Payload 上传
await uomp.payload.upload(reportJSON);
```

### 1.6 React 组件示例

```tsx
function PortfolioApp() {
  const [uomp, setUomp] = useState<UompClient | null>(null);
  const [holdings, setHoldings] = useState([]);

  useEffect(() => {
    async function init() {
      const client = await BrowserSDK.fromWallet();
      setUomp(client);
      const data = await client.memory.getByTag('portfolio:holdings');
      setHoldings(data);
    }
    init();
  }, []);

  return (
    <div>
      <header>
        {uomp && !uomp.isGatewayOnline && (
          <Banner>Gateway 不在线 — 只读模式</Banner>
        )}
      </header>
      <HoldingsTable data={holdings} />
    </div>
  );
}
```

---

## 2. CLI 远程模式（Gateway + Cloudflare Tunnel）

Agent 运行在云服务 / 另一台机器上，通过 Gateway 回连用户本地 Memory Guard。

### 2.1 架构

```
┌──────────────┐   mTLS + Token   ┌──────────────┐   HTTP   ┌──────────────┐
│ Remote Agent │ ────────────────► │   Gateway    │ ───────► │ Memory Guard │
│ (DO / VPS)   │    Cloudflare     │   (用户本地)  │          │   :9374      │
│              │     Tunnel        │   :9443      │          └──────────────┘
└──────────────┘                   └──────────────┘
```

### 2.2 用户侧操作

```bash
# 1. 启动 Auth + Guard 服务（终端 1）
uomp serve

# 2. 启动 Gateway + Cloudflare Tunnel（终端 2）
uomp gateway start

# 输出：
# ═══ Public Gateway URL ═══
#   https://happy-frogs-sing.trycloudflare.com
# export UOMP_BASE_URL="https://happy-frogs-sing.trycloudflare.com"

# 3. 导入数据（如果还没导入）
uomp import ./holdings.csv --tag portfolio:holdings --sensitivity high --replace

# 4. 授权远程 Agent（本地 server 已在上一步启动）
uomp authorize ./examples/stock-analyst \
  --scope portfolio:holdings profile:risk \
  --output /tmp/uomp-remote.env \
  --no-server

# 5. 设置环境变量
source /tmp/uomp-remote.env
# 确保 UOMP_BASE_URL 指向 Gateway 公网地址
export UOMP_BASE_URL="https://happy-frogs-sing.trycloudflare.com"
```

### 2.3 Agent 侧代码（Node.js SDK）

```ts
import { UompClient } from '@uomp/sdk';

// 自动从环境变量 UOM_TOKEN + UOMP_BASE_URL 初始化
// Gateway 模式下 SDK 自动加载 ~/.uomp/.gateway-certs/ 做 mTLS
const uomp = UompClient.fromEnv();

// 读取数据
const holdings = await uomp.memory.getByTag('portfolio:holdings');
const risk = await uomp.memory.getByTag('profile:risk');

// 聚合查询（不暴露原始数据）
const totalMarketValue = await uomp.aggregate.sum(
  'portfolio:holdings',
  'value.market_value'
);

// 分析...
const analysis = doAnalysis(holdings, risk, quotes);

// 上传报告到 Gateway
const payloadId = await uomp.payload.upload(JSON.stringify(analysis));

// 提交删除证明 + 关闭 Session
await uomp.session.finalize();

console.log(`Total P&L: ${analysis.totalPnl}`);
console.log(`Report payload: ${payloadId}`);
```

### 2.4 显式配置（非环境变量）

```ts
const uomp = new UompClient({
  token: 'eyJhbG...',
  baseUrl: 'https://happy-frogs-sing.trycloudflare.com',
  agentId: 'stock-analyst',
  sessionId: 'sess_xxx',
});

// SDK 自动检测 https:// → 加载 mTLS 证书
// 自动从 JWT 解析 sessionId / agentId / scopes
console.log(uomp.tokenInfo?.scopes);    // 授权范围
console.log(uomp.tokenInfo?.expiresAt); // 过期时间
```

### 2.5 Gateway 管理命令

```bash
# 启动 Gateway + Cloudflare Tunnel（推荐）
uomp gateway start

# 仅 Gateway，不暴露公网（适合 VPS 有公网 IP）
uomp gateway start --no-tunnel

# 启用 CORS（浏览器 App 直连）
uomp gateway start --browser

# 查看 Gateway 状态
uomp gateway status
```

---

## 3. 本地模式（Agent 与 Guard 同机）

### 3.1 架构

```
┌──────────┐   HTTP   ┌──────────────┐   ┌──────────────┐
│  Agent   │ ───────► │ Memory Guard │──►│ Memory Store │
│ :local   │          │  :9374       │   │ SQLite       │
└──────────┘          └──────────────┘   └──────────────┘
```

### 3.2 操作

```bash
# 1. 启动服务
uomp serve

# 2. 授权到固定 env 文件
uomp authorize ./my-agent --scope my:data --output ~/.uomp/my-agent.env --no-server

# 3. 运行
source ~/.uomp/my-agent.env && node ./my-agent/index.js
```

---

## 4. 三种模式对比

| | 浏览器模式 | 远程模式 | 本地模式 |
|------|:---:|:---:|:---:|
| 用户安装 CLI | 仅首次配置 | ✅ | ✅ |
| 需要启动 Gateway | ❌（Cloud Relay） | ✅ | ❌ |
| 需要公网 IP | ❌ | ❌（Cloudflare Tunnel） | ❌ |
| Token 从哪里来 | CLI、URL hash | `uomp authorize --remote` | `uomp authorize` |
| 数据存在哪里 | S3（加密） | SQLite（本地） | SQLite（本地） |
| 读操作离线可用 | ✅（S3 直读） | ❌ | N/A |
| 写操作 | Cloud Relay | Gateway | 直连 Guard |
| 适用 Agent | Web App、Dashboard | 云 Agent、SaaS | Node.js Agent |
