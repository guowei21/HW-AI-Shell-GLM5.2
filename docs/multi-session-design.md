# 多会话并发访问方案设计

> 针对 aishell-server-lite 控制器的单会话架构改造，使其支持多用户并发访问。

## 1. 现状分析

### 1.1 当前架构

| 组件 | 说明 | 并发瓶颈 |
|------|------|----------|
| aishell-controller | 监听 50005，管理 AI Shell 交互 | 单 page、单终端、全局状态 |
| chromium (browserless) | 无头浏览器 + CDP | 单浏览器实例，无 page 池 |
| sub2api | API 转发层 (50004) | 无 session 路由，所有请求走同一终端 |
| bootstrap.command.txt | 引导命令脚本 | 全局一次性执行，无 per-session 隔离 |

### 1.2 关键限制

- `(await browser.pages())[0]` — 始终取第一个页面，无法按请求分配
- 单一 `puppeteer.connect()` 连接，无连接池
- 状态接口返回单数字段（`browserConnected`、`terminalReady`、`shellReady`）
- 引导命令逐条注入同一 xterm 终端，无 session 隔离
- 无锁、无队列、无 mutex — 并发请求会互相干扰
- 全局 `lastBootstrapAt`、`lastBootstrapError` 等字段被所有请求共享

### 1.3 引导流程（当前）

```
请求 → POST /bootstrap?force=1
     → 读取 bootstrap.command.txt
     → 逐条注入 (await browser.pages())[0] 的 xterm 终端
     → 等待完成标记 __AISHELL_BOOTSTRAP_DONE_<runId>_<index>__:<status>
     → 更新全局 lastBootstrapAt
```

## 2. 设计目标

- **多会话隔离**：每个 API 请求（或每用户）拥有独立的浏览器 page + xterm 终端
- **会话池管理**：支持预热、按需创建、空闲回收
- **引导隔离**：每个会话独立执行引导命令，互不干扰
- **状态隔离**：per-session 状态，不再共享全局字段
- **向后兼容**：保留单会话模式作为降级选项
- **最小改动**：复用现有 CDP 注入和完成标记机制

## 3. 架构设计

### 3.1 整体架构

```
                    ┌─────────────────────────────────┐
                    │       aishell-controller        │
                    │         (port 50005)            │
                    │                                 │
  API Request ──────┤  ┌──────────────────────────┐   │
  (with sessionId)   │  │    SessionManager        │   │
                    │  │                          │   │
                    │  │  ┌─────┐ ┌─────┐ ┌────┐ │   │
                    │  │  │ S1  │ │ S2  │ │ .. │ │   │
                    │  │  │page │ │page │ │    │ │   │
                    │  │  │term │ │term │ │    │ │   │
                    │  │  │boot │ │boot │ │    │ │   │
                    │  │  └─────┘ └─────┘ └────┘ │   │
                    │  │                          │   │
                    │  │  Pool: max=10, idle=300s │   │
                    │  └──────────────────────────┘   │
                    │                                 │
                    └──────────┬──────────────────────┘
                               │ CDP
                    ┌──────────▼──────────────────────┐
                    │     chromium (browserless:9222)  │
                    │  Page1  Page2  Page3  ...  PageN │
                    └─────────────────────────────────┘
```

### 3.2 Session 对象

```javascript
class AIShellSession {
  constructor({ id, page, createdAt }) {
    this.id = id;              // 唯一会话 ID
    this.page = page;          // 独立 Puppeteer Page
    this.createdAt = createdAt;
    this.lastActiveAt = createdAt;
    this.bootstrapped = false;
    this.bootstrapError = null;
    this.lastBootstrapAt = 0;
    this.busy = false;         // 命令执行锁
    this.leaseExpiresAt = null;
  }
}
```

### 3.3 SessionManager

```javascript
class SessionManager {
  constructor({ browser, maxSessions = 10, idleTimeoutMs = 300000 }) {
    this.browser = browser;
    this.sessions = new Map();     // sessionId -> AIShellSession
    this.maxSessions = maxSessions;
    this.idleTimeoutMs = idleTimeoutMs;
    this.cleanupTimer = setInterval(() => this.reclaimIdle(), 60000);
  }

  // 获取或创建会话
  async acquire(sessionId) {
    let session = this.sessions.get(sessionId);
    if (!session) {
      if (this.sessions.size >= this.maxSessions) {
        const idle = this.findIdleSession();
        if (idle) { await this.destroy(idle.id); }
        else { throw new Error('Max sessions reached'); }
      }
      const page = await this.browser.newPage();
      session = new AIShellSession({ id: sessionId, page, createdAt: Date.now() });
      this.sessions.set(sessionId, session);
    }
    session.lastActiveAt = Date.now();
    return session;
  }

  // 释放会话（标记为空闲，不销毁）
  release(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) { session.busy = false; session.lastActiveAt = Date.now(); }
  }

  // 回收空闲会话
  reclaimIdle() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (!session.busy && now - session.lastActiveAt > this.idleTimeoutMs) {
        this.destroy(id);
      }
    }
  }

  // 销毁会话
  async destroy(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      await session.page.close().catch(() => {});
      this.sessions.delete(sessionId);
    }
  }

  // 状态汇总
  status() {
    return {
      total: this.sessions.size,
      max: this.maxSessions,
      sessions: Array.from(this.sessions.values()).map(s => ({
        id: s.id, bootstrapped: s.bootstrapped, busy: s.busy,
        uptimeMs: Date.now() - s.createdAt,
        idleMs: Date.now() - s.lastActiveAt,
      })),
    };
  }
}
```

## 4. 接口改造

### 4.1 会话标识传递

**方案 A：Header 传递（推荐）**

```
POST /bootstrap?force=1
X-Session-Id: user-abc123
Authorization: Bearer <token>
```

**方案 B：URL 参数**

```
POST /sessions/{sessionId}/bootstrap?force=1
```

推荐方案 A，对现有接口改动最小。

### 4.2 改造后的接口

| 接口 | 方法 | 改造点 |
|------|------|--------|
| `/health` | GET | 返回 `sessions` 汇总信息 |
| `/status` | GET | 返回 per-session 状态列表 |
| `/bootstrap` | POST | 按 `X-Session-Id` 隔离执行 |
| `/sessions/{id}` | DELETE | 主动销毁指定会话 |
| `/sessions` | GET | 列出所有会话 |

### 4.3 引导流程（改造后）

```
请求 -> POST /bootstrap?force=1 + X-Session-Id: user-abc123
     -> sessionManager.acquire("user-abc123")
     -> 获取/创建独立 page
     -> 在该 page 上执行引导命令
     -> 等待完成标记（per-session）
     -> 更新 session.bootstrapped = true
     -> sessionManager.release("user-abc123")
```

## 5. 关键改造点

### 5.1 browser.pages()[0] -> session.page

**当前：**
```javascript
const page = (await browser.pages())[0];
```

**改造后：**
```javascript
const session = await sessionManager.acquire(sessionId);
const page = session.page;
```

### 5.2 全局状态 -> per-session 状态

**当前：**
```javascript
let lastBootstrapAt = 0;
let lastBootstrapError = '';
```

**改造后：**
```javascript
// 状态存储在 session 对象上
session.lastBootstrapAt = Date.now();
session.bootstrapError = null;
```

### 5.3 引导命令执行

**当前：**
```javascript
async function runBootstrap({ force = false } = {}) {
  const current = (await browser.pages())[0];
  // ... 逐条注入同一终端
}
```

**改造后：**
```javascript
async function runBootstrap({ sessionId, force = false } = {}) {
  const session = await sessionManager.acquire(sessionId);
  const current = session.page;
  // ... 逐条注入该 session 的独立终端
  // 完成标记检测也限定在 session.page 范围内
  session.bootstrapped = true;
  sessionManager.release(sessionId);
}
```

### 5.4 terminalContains / terminalState 限定到 page

函数签名不变，`current` 变为 `session.page`，天然隔离。

### 5.5 sub2api 转发层路由

sub2api 需要按请求分配 `X-Session-Id`：

- **简单模式**：每个 API key 对应一个固定 sessionId
- **高级模式**：每个请求生成唯一 sessionId，用完即回收

```
# sub2api 转发时注入 header
proxy_set_header X-Session-Id $request_id;
```

## 6. 会话生命周期

```
创建 --> 引导 --> 就绪 --> 服务请求 --> 空闲 --> 回收
  |         |        |          |           |
  |         |        |          |           └─ 超时 300s 自动销毁
  |         |        |          └─ 请求完成，标记 idle
  |         |        └─ bootstrapped=true
  |         └─ 执行 bootstrap.command.txt
  └─ browser.newPage() + 导航到 AI Shell URL
```

## 7. 配置项

```bash
# 环境变量
MAX_SESSIONS=10                  # 最大并发会话数
SESSION_IDLE_TIMEOUT_MS=300000   # 空闲回收超时
SESSION_PREWARM=2                # 预热会话数（可选）
SINGLE_SESSION_MODE=false        # 单会话降级模式
```

## 8. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 内存增长 | 每个 page 占用 ~50-100MB | 限制 maxSessions + 空闲回收 |
| 引导耗时 | 每个新会话需执行完整引导 | 预热池 + 引导结果缓存（若可行） |
| 浏览器崩溃 | 影响所有会话 | 健康检查 + 自动重连 + 会话迁移 |
| 租约竞争 | 多会话同时续期 | per-session 租约管理 |
| 华为云限制 | AI Shell 实例数上限 | 确认平台侧并发限制 |

## 9. 实施计划

| 阶段 | 内容 | 预估工作量 |
|------|------|------------|
| P1 | SessionManager + AIShellSession 类 | 2h |
| P2 | 接口改造（X-Session-Id 传递 + 路由） | 1h |
| P3 | runBootstrap per-session 改造 | 1h |
| P4 | 状态接口改造 | 0.5h |
| P5 | sub2api 转发层 session 路由 | 1h |
| P6 | 空闲回收 + 预热池 | 1h |
| P7 | 单会话降级模式 | 0.5h |
| P8 | 测试 + 部署验证 | 2h |
| **合计** | | **~9h** |

## 10. 降级策略

设置 `SINGLE_SESSION_MODE=true` 时：

- SessionManager 退化为单会话
- 忽略 `X-Session-Id`，所有请求共享同一 page
- 行为与当前版本完全一致
- 用于回滚或平台不支持多实例的场景

## 11. 后续扩展

- **会话亲和性**：同一用户的请求路由到同一会话，避免重复引导
- **引导快照**：对已引导的 page 做快照，新会话从快照恢复，跳过引导
- **水平扩展**：多控制器实例 + Redis 共享会话元数据
- **WebSocket 推送**：实时推送 per-session 状态变更
