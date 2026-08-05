# Huawei AI Shell GLM-5.2 → OpenAI 兼容 API

> 本项目仅供个人学习与使用。

**把华为 AI Shell 容器内的 glm-5.2 模型能力，转换为标准的 OpenAI Chat Completions 接口！**

- **OpenAI 兼容** - 任意客户端（Codex / ChatBox / 自写脚本）改个 Base URL 即可使用 GLM-5.2
- **全云端管理** - 管理面板托管于 Cloudflare Workers，本机零部署
- **可视化面板** - WebUI 配置 tunnel token / 域名 / API Key，随机生成一键复制
- **配置存 KV** - 部署脚本经 Worker 分发，容器状态心跳实时上报
- **一行部署** - AI Shell 容器内执行一行命令，自动完成代理部署 + Cloudflare Tunnel 穿透

## 部署（一键）

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/guowei21/HW-AI-Shell-GLM5.2)

1. 点击上方按钮，登录 Cloudflare 账号；
2. 选择账户，点击 **Deploy**；
3. 按提示设置 `ADMIN_KEY`（面板登录密钥，自定义、保密）；
4. 部署完成，打开面板 `https://aishell-admin.<ACCOUNT_ID>.workers.dev`。

> 也可本地部署：`cd workers && npm i -D wrangler && npx wrangler secret put ADMIN_KEY && node sync-kv.mjs && npx wrangler deploy`

## 使用

1. 打开面板，输入 ADMIN_KEY 登录（会话 24h）；
2. 填 **Public Hostname 域名** 与 **tunnel run token**（token 在 Cloudflare Dashboard 手动创建隧道获取，或用 `.github/workflows/tunnel-create.yml` 自动创建）；
3. 点"**随机生成**"API Key → 保存（存 KV）→ **复制**；
4. 复制面板底部的容器部署命令，到 AI Shell 终端（root）执行：

   ```bash
   ADMIN_KEY='<你的ADMIN_KEY>' bash <(curl -fsSL https://aishell-admin.<ACCOUNT_ID>.workers.dev/scripts/deploy-remote.sh) https://aishell-admin.<ACCOUNT_ID>.workers.dev
   ```

   该命令自动：拉取配置与代理源码 → 启动代理(:5173) → 启动 Cloudflare Tunnel → 每 60s 上报心跳。

5. 面板实时显示容器状态与公网 URI `https://<域名>/v1`；客户端用 API Key 访问。

## 目录

```text
aishell-acp-openai-proxy.mjs    # 代理源码（经 Worker 分发到容器）
workers/
  src/index.js                  # Worker：登录鉴权/KV/心跳/bootstrap/脚本分发
  src/admin.html                # WebUI 面板
  src/deploy-remote.sh          # 容器端一键部署
  sync-kv.mjs                   # 上传脚本到 KV
  wrangler.toml / package.json
.github/workflows/              # GitHub Actions（可选：自动部署 / 建隧道）
```

## 安全

- `ADMIN_KEY` 经 `wrangler secret` 加密存储，不入代码；
- 面板用登录会话（Bearer token）鉴权，容器用 `X-Admin-Key` 头；
- API Key 为空时代理免鉴权，公网使用务必设置；
- AI Shell 登录态无外部保活，失效需手动在网页重新登录并重跑容器部署命令。
