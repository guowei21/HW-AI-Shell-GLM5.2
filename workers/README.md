# Cloudflare Workers 全托管方案（本地零部署）

把整个管理面搬到 Cloudflare Workers：**WebUI 面板、配置存储（KV）、脚本分发、容器心跳**全部在云端。
本地（Windows 宿主 / 你自己机器）**什么都不装**；只有 AI Shell 容器内执行一行命令拉起代理与隧道
（容器是华为云端环境，不属于"本地"）。

## 架构

```text
┌─ 浏览器 ─────────────────────────────────────────────┐
│  https://<worker>.workers.dev  （WebUI 管理面板）      │
│    · 填 tunnel token / 域名 / API key（存 KV）        │
│    · API key 随机生成 + 复制按钮                       │
│    · 看 AI Shell 容器状态（心跳）                     │
│    · 看公网/本地 URI + 复制                           │
└──────────────────────────┬───────────────────────────┘
                           │ HTTPS
┌──────────────────────────▼───────────────────────────┐
│  Cloudflare Workers（aishell-admin）                 │
│    GET  /                 → admin.html（WebUI）      │
│    POST /api/config       → 存 token/域名/apiKey → KV │
│    GET  /api/status       → 读配置 + 心跳            │
│    GET  /api/bootstrap    → 容器拉全量配置            │
│    POST /api/heartbeat    → 容器上报状态              │
│    GET  /scripts/<file>   → 脚本分发（免 git）        │
└──────────────────────────┬───────────────────────────┘
                           │ HTTPS（容器内 curl）
┌──────────────────────────▼───────────────────────────┐
│  AI Shell 容器（华为云端，root）                     │
│  ADMIN_KEY=xxx bash <(curl -fsSL .../scripts/deploy-remote.sh) ...   │
│    · 拉配置 → 起代理(:5173) → 起 cloudflared → 心跳   │
└──────────────────────────────────────────────────────┘
```

## 部署 Workers（一次）

```bash
cd workers
npm i -D wrangler

# 1. 建 KV 命名空间
npx wrangler kv namespace create KV
#    输出里有 id: "xxxx"，把它填进 wrangler.toml 的 KV namespace id

# 2. 设管理密钥（WebUI 与容器共用；保密！）
npx wrangler secret put ADMIN_KEY

# 3. 上传脚本到 KV（代理源码 + 容器端部署脚本）
node sync-kv.mjs

# 4. 部署
npx wrangler deploy
#    得到 https://<worker>.workers.dev
```

## 使用流程

1. **打开面板**：浏览器访问 `https://<worker>.workers.dev`，输入**面板登录密钥**（ADMIN_KEY）登录，
   获得 24h 会话 token（HMAC 签名，存浏览器 localStorage）；退出可点右上角"退出"；
2. **填隧道配置**：Public Hostname 域名 + tunnel run token（token 用 `tunnel-create.sh` 或
   GitHub Actions `tunnel-create.yml` 生成，填进面板保存到 KV）；
3. **生成 API key**：点"随机生成"→ 保存（**API key 存入 KV**，供容器 bootstrap 拉取）；复制按钮可一键复制；
4. **容器部署**：面板底部会生成一行命令（含部署时的 ADMIN_KEY），到 AI Shell 终端执行；
5. **看状态**：容器脚本每 60s 上报心跳，面板显示代理/模型/隧道在线状态与公网 URI。

## 鉴权设计

- **面板登录**：`POST /api/login` 用 ADMIN_KEY 换取 24h 会话 token（HMAC-SHA256 签名，hex 签名防
  base64 往返歧义）；后续请求带 `Authorization: Bearer <token>`；
- **容器访问**：容器没有登录环节，直接用 `X-Admin-Key` 头访问 `/api/bootstrap`、`/api/heartbeat`、`/scripts/`；
- **API key 独立存 KV**：与登录密钥分离，是客户端调用 `/v1` 的凭证，面板生成/查看/复制都基于 KV 值。

## 关键设计

- **免 git**：容器从 `/scripts/` 直接拉脚本与代理源码（KV 存储），`sync-kv.mjs` 负责上传；
- **凭据在云端**：token/API key 存 Workers KV（不落本地磁盘、不进仓库）；但注意 KV 是明文存储，
  依赖 ADMIN_KEY 保护访问——不要泄露 ADMIN_KEY；
- **心跳即状态**：容器主动上报，面板被动展示，无需反向连接；
- **可重复部署**：容器重启后重跑那一行命令即可（脚本内部会 kill 旧进程再拉起）。

## 目录

```text
workers/
  wrangler.toml        # Worker 配置（KV binding、兼容日期）
  sync-kv.mjs          # 上传脚本到 KV
  src/
    index.js           # Worker 主程序（路由/API/鉴权）
    admin.html         # WebUI 单文件（随机生成 key、复制按钮、状态卡片）
    deploy-remote.sh   # 容器端一键部署（拉配置/起代理/起隧道/心跳）
```
