# Huawei AI Shell GLM-5.2 → OpenAI 兼容 API

> 本项目仅供个人学习与使用。

**把华为 AI Shell 容器内的 glm-5.2 模型能力，转换为标准的 OpenAI Chat Completions 接口！**

- **OpenAI 兼容** - 任意客户端（Codex / ChatBox / 自写脚本）改个 Base URL 即可使用 GLM-5.2
- **全云端管理** - 管理面板托管于 Cloudflare Workers，本机零部署
- **可视化面板** - WebUI 配置 tunnel token / 域名 / API Key，随机生成一键复制
- **配置存 KV** - 部署脚本经 Worker 分发，容器状态心跳实时上报
- **一键部署** - AI Shell 容器内执行一行命令，自动完成代理部署 + Cloudflare Tunnel 穿透

## 部署

实测推荐**本地 wrangler 一键部署**（几分钟完成），也可用 Cloudflare 一键按钮或 Dashboard 连接 Git。
详细步骤与踩坑记录见 [docs/DEPLOY.md](docs/DEPLOY.md)。

### 方式一：本地 wrangler 一键部署（实测成功 ✅）

```bash
# 1. 安装依赖（项目根目录）
npm install

# 2. 配置凭据（Cloudflare API Token，权限需含 Workers Scripts Edit + KV Storage Edit）
export CLOUDFLARE_API_TOKEN=<你的API Token>
export CLOUDFLARE_ACCOUNT_ID=<你的账户ID>     # Dashboard 右侧 Account ID

# 3. 创建 KV namespace（只需一次），把输出的 id 填入 wrangler.toml
npx wrangler kv namespace create KV
#    输出形如 id = "xxxx..." → 替换 wrangler.toml 里的 id = "..."

# 4. 设置面板登录密钥 ADMIN_KEY（只需一次，自定义强随机值）
npx wrangler secret put ADMIN_KEY

# 5. 一键部署（自动：上传面板/代理源码/部署脚本到 KV → 部署 Worker）
npm run deploy
```

部署完成，面板地址：

```
https://hw-ai-shell-glm5-2.<ACCOUNT_ID>.workers.dev
```

### 方式二：Cloudflare 一键按钮（可选）

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/guowei21/HW-AI-Shell-GLM5.2)

> ⚠️ `workers.dev` 域名在国内直连不稳定，建议在 Dashboard → Worker → Settings → Domains & Routes
> 绑定自定义域名后访问面板。

## 使用

1. 打开面板，输入 ADMIN_KEY 登录（会话 24h）；
2. 填 **Public Hostname 域名** 与 **tunnel run token**（token 在 Cloudflare Dashboard 手动创建隧道获取）；
3. 点"**随机生成**"API Key → 保存（存 KV）→ **复制**；
4. 复制面板底部的容器部署命令，到 AI Shell 终端（root）执行：

   ```bash
   ADMIN_KEY='<你的ADMIN_KEY>' bash <(curl -fsSL https://hw-ai-shell-glm5-2.<ACCOUNT_ID>.workers.dev/scripts/deploy-remote.sh) https://hw-ai-shell-glm5-2.<ACCOUNT_ID>.workers.dev
   ```

   该命令自动：拉取配置与代理源码 → 启动代理(:5173) → 启动 Cloudflare Tunnel → 每 60s 上报心跳。

5. 面板实时显示容器状态与公网 URI `https://<域名>/v1`；客户端用 API Key 访问。

## 目录

```text
aishell-acp-openai-proxy.mjs    # 代理源码（经 Worker 分发到容器）
src/index.js                    # Worker：登录鉴权/KV/心跳/bootstrap/脚本分发
src/admin.html                  # WebUI 面板
src/deploy-remote.sh            # 容器端一键部署
sync-kv.mjs                     # 上传脚本到 KV（含自动创建 KV、--remote/--path 修正）
wrangler.toml / package.json    # Worker 配置文件
```

## 安全

- `ADMIN_KEY` 经 `wrangler secret` 加密存储，不入代码；
- 面板用登录会话（Bearer token）鉴权，容器用 `X-Admin-Key` 头；
- API Key 为空时代理免鉴权，公网使用务必设置；
- AI Shell 登录态无外部保活，失效需手动在网页重新登录并重跑容器部署命令。
