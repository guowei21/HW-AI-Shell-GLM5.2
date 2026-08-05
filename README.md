# Huawei AI Shell GLM 代理 · Cloudflare Workers 全托管版

把已登录的 Huawei AI Shell 模型能力转换为 OpenAI Chat Completions 接口。
**全部管理面在 Cloudflare Workers 云端（本地零部署）**：WebUI 管理面板、配置存储（KV）、
脚本分发、容器心跳，全部由 Worker 承担。AI Shell 容器内只需执行一行命令完成部署。

```text
浏览器 → https://<worker>.workers.dev          （WebUI 管理面板）
           ├─ 登录（ADMIN_KEY → 24h 会话）→ 填 token/域名/API key → KV
           ├─ API key 随机生成 + 复制按钮
           └─ 看容器状态（心跳）、公网/本地 URI + 复制
                ↑ HTTPS                    ↑ HTTPS（容器内一行 curl）
Workers：/api/login /api/status /api/config /api/bootstrap /api/heartbeat /scripts/
                ↑
AI Shell 容器（华为云端）：deploy-remote.sh 拉配置/拉脚本 → 起代理 :5173 → 起 cloudflared → 心跳
```

## 架构要点

- **免 git 部署**：容器从 Worker 的 `/scripts/` 拉代理源码与部署脚本（存 KV），执行一行命令即完成；
- **凭据分层**：
  - `ADMIN_KEY`：面板**登录密钥**（`wrangler secret` 存储），登录换取 24h HMAC 会话 token；
  - `API key`：客户端访问 `/v1` 的凭证，**存 KV**（面板生成/查看/复制）；
  - `tunnel token`：Cloudflare Tunnel 凭据，**存 KV**（容器 bootstrap 拉取）；
- **容器心跳**：部署脚本每 60s 上报 `POST /api/heartbeat`，面板据此显示上游/隧道在线状态；
- **无本地组件**：不需要 Windows 宿主装任何东西，cloudflared 直接在容器内运行。

## 目录结构

```text
aishell-acp-openai-proxy.mjs   # 代理源码（经 Worker 分发到容器）
workers/
  wrangler.toml                # Worker 配置（KV binding）
  sync-kv.mjs                  # 上传 admin.html / 代理源码 / 部署脚本 到 KV
  src/
    index.js                   # Worker 主程序（路由/API/登录鉴权）
    admin.html                 # WebUI（登录、配置、状态、API key 生成+复制）
    deploy-remote.sh           # 容器端一键部署（拉配置/起代理/起隧道/心跳）
.github/workflows/deploy.yml   # 一键部署：push 后自动部署 Worker + 上传 KV
docs/multi-session-design.md   # 旧架构设计存档（已过时）
archive/ research/             # 历史备份与逆向研究（不入库）
```

## 一键部署（GitHub Actions）

push 到 `main` 自动执行：安装 wrangler → 上传 KV → 部署 Worker → 设置 ADMIN_KEY。

### 仓库 Secrets 需配置

| Secret | 值 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token（权限：Workers Scripts Edit、Workers KV Storage Edit、Account Settings Read） |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账户 ID |
| `CF_KV_NAMESPACE_ID` | KV 命名空间 ID（`npx wrangler kv namespace create KV` 得到） |
| `ADMIN_KEY` | 面板登录密钥（自定，保密） |

### 本地首次部署（或不用 CI）

```bash
cd workers && npm i -D wrangler
npx wrangler kv namespace create KV          # 把 id 填进 wrangler.toml + GitHub Secret
npx wrangler secret put ADMIN_KEY
node sync-kv.mjs && npx wrangler deploy
```

## 使用流程

1. 打开 `https://<worker>.workers.dev`，输入 ADMIN_KEY 登录；
2. 填 Public Hostname 域名 + tunnel run token（用 `tunnel-create.sh` 或 GitHub Actions 建隧道得到）；
3. "随机生成"API key → 保存（存 KV）→ 复制；
4. 面板底部复制容器部署命令，到 AI Shell 终端执行；
5. 面板显示容器心跳（代理/模型/隧道）与公网 URI。

## 安全边界

- `ADMIN_KEY` 走 `wrangler secret`（加密存储），不入代码/仓库；
- 所有 `/api/*` 需鉴权：面板用 Bearer 会话，容器用 `X-Admin-Key`；
- KV 中凭据为明文，依赖 `ADMIN_KEY` 保护，切勿泄露；
- 代理本地必须带 `LOCAL_PROXY_API_KEY`（即面板存的 API key），为空时所有请求免鉴权；
- AI Shell 登录态无外部保活，失效需手动在网页重新登录并重跑部署命令。
