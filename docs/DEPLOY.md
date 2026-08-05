# 部署指南

本项目管理面板是一个 Cloudflare Worker（`workers/`），通过 **Cloudflare 一键部署** 部署：
`https://aishell-admin.<ACCOUNT_ID>.workers.dev` 上的管理面板。

> 部署只需要把**管理面板（Worker）**跑起来；真正的模型代理在 AI Shell 容器内，
> 由面板生成的"容器部署命令"拉取脚本完成，与本部署无关。

## 部署步骤

1. **打开部署按钮**

   ```markdown
   [![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/guowei21/HW-AI-Shell-GLM5.2)
   ```

   或在浏览器直接访问：
   `https://deploy.workers.cloudflare.com/?url=https://github.com/guowei21/HW-AI-Shell-GLM5.2`

2. **登录 Cloudflare**，并按提示授权 GitHub（Cloudflare 会把仓库克隆/创建到你 GitHub 账号下，方便后续开发）。

3. **配置页**：
   - 仓库名 / Worker 名（默认 `aishell-admin`）可自定义；
   - Cloudflare 会自动读取 `wrangler.toml`，**自动创建 KV namespace** 并绑定（无需手动操作）；
   - 检测到 `workers/.dev.vars.example` 里的 `ADMIN_KEY` → **要求你输入 ADMIN_KEY 的值**（自定义强随机密钥，作为 secret 加密存储，此值就是面板登录密钥）。

4. 点击 **Deploy**。Cloudflare 会自动：
   - 把 `admin.html`、代理源码、容器部署脚本上传到 KV；
   - 部署 Worker。

5. **部署完成**，面板地址：

   ```
   https://aishell-admin.<ACCOUNT_ID>.workers.dev
   ```

   可在 Cloudflare Dashboard → Workers & Pages → `aishell-admin` → 设置里看到 Worker 详情。

## 常见问题

| 现象 | 处理 |
|---|---|
| 部署报 KV 相关错误 | 一键部署会自动创建 KV；若个别账号环境未自动创建，去 Dashboard → Workers & Pages → KV 手动建一个 namespace，把 id 填进 `workers/wrangler.toml` 的 `REPLACE_WITH_KV_NAMESPACE_ID` 后重新部署 |
| 忘记 ADMIN_KEY | Dashboard → Workers & Pages → `aishell-admin` → 设置 → 变量和机密，重新添加 `ADMIN_KEY` |
| 想用自定义域名访问面板 | Dashboard → Worker → 设置 → 域和路由 → 添加自定义域 |

## 部署后使用

1. 打开面板 `https://aishell-admin.<ACCOUNT_ID>.workers.dev`，输入 ADMIN_KEY 登录（会话 24h）；
2. 填 **Public Hostname 域名** 与 **tunnel run token**（token 在 Cloudflare Dashboard → Zero Trust → Networks → Tunnels 手动创建隧道获取）；
3. 点"**随机生成**"API Key → 保存（存 KV）→ 复制；
4. 复制面板底部的容器部署命令，到 AI Shell 终端（root）执行：
   ```bash
   ADMIN_KEY='<你的ADMIN_KEY>' bash <(curl -fsSL https://aishell-admin.<ACCOUNT_ID>.workers.dev/scripts/deploy-remote.sh) https://aishell-admin.<ACCOUNT_ID>.workers.dev
   ```
   该命令自动：拉取配置与代理源码 → 启动代理(:5173) → 启动 Cloudflare Tunnel → 每 60s 上报心跳；
5. 面板实时显示容器状态与公网 URI `https://<域名>/v1`；客户端用 API Key 访问。
