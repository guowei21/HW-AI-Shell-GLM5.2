# 部署指南（实测成功版）

本项目管理面板是一个 Cloudflare Worker（`hw-ai-shell-glm5-2`），部署方式按可靠性排序：
**本地 wrangler 一键部署（实测成功）** → **Dashboard 连接 Git（Workers Builds）** → 一键按钮（可选）。

> 部署只需要把**管理面板（Worker）**跑起来；真正的模型代理在 AI Shell 容器内，
> 由面板生成的"容器部署命令"拉取脚本完成，与本部署无关。

---

## 方式一：本地 wrangler 一键部署（实测成功 ✅）

### 前提

- Node.js ≥ 18 + npm；
- Cloudflare 账号，准备好 **API Token**（Dashboard → My Profile → API Tokens → Create：
  权限勾选 **Workers Scripts Edit** + **Workers KV Storage Edit**）与 **Account ID**（Dashboard 右侧）；
- 可访问 GitHub（国内需代理）。

### 步骤

```bash
# 1. 克隆仓库并安装依赖
git clone https://github.com/guowei21/HW-AI-Shell-GLM5.2.git
cd HW-AI-Shell-GLM5.2
npm install

# 2. 配置凭据（每次部署前执行）
export CLOUDFLARE_API_TOKEN=<你的API Token>
export CLOUDFLARE_ACCOUNT_ID=<你的账户ID>

# 3. 创建 KV namespace（只需一次；若已存在同名 KV 可跳过，直接把现有 id 填入 wrangler.toml）
npx wrangler kv namespace create KV
#    输出：id = "xxxx..." → 替换 wrangler.toml 中的 id = "..."

# 4. 设置面板登录密钥 ADMIN_KEY（只需一次）
npx wrangler secret put ADMIN_KEY
#    按提示输入自定义强随机值（此值即面板登录密码）

# 5. 一键部署（自动：上传 admin.html/代理源码/部署脚本到 KV → 部署 Worker）
npm run deploy
```

### 验证

```bash
# 面板（国内网络需代理，或绑定自定义域名）
curl https://hw-ai-shell-glm5-2.<ACCOUNT_ID>.workers.dev/api/health
# → {"ok":true,"worker":"hw-ai-shell-glm5-2",...}
```

---

## 方式二：Cloudflare Dashboard 连接 Git（Workers Builds）

1. Dashboard → **Workers & Pages** → Create application → Workers → Create Worker → **Connect to Git**；
2. 授权 GitHub，选择仓库 `guowei21/HW-AI-Shell-GLM5.2`；
3. **关键配置**（容易踩坑）：
   - **Deploy command 必须设为 `npm run deploy`**（默认 `npx wrangler deploy` 不会执行
     `sync-kv.mjs`，面板/脚本不会上传到 KV，且 KV 占位符不会被替换）；
   - **KV namespace 必须已创建**（方式一第 3 步，或 Dashboard → KV 手动创建），并把 id 填进
     `wrangler.toml`——否则构建报 `KV namespace 'REPLACE_WITH_KV_NAMESPACE_ID' is not valid [code: 10042]`；
   - Worker 名默认取仓库派生名（`hw-ai-shell-glm5-2`），与 `wrangler.toml` 一致即可消除 warning；
4. Save and Deploy。**注意**：Workers Builds 会自动把代码克隆到你的 GitHub 账号下新建的
   **seed 仓库**（同名 `hw-ai-shell-glm5-2`），用于构建——这是官方机制，无需手动管理；
5. 设置 `ADMIN_KEY`：Worker → Settings → Variables and Secrets。

---

## 踩坑记录（成功经验）

| 坑 | 现象 | 解法 |
|---|---|---|
| `kv key put` 默认写本地 | 面板 503"admin.html 未上传" | 命令加 **`--remote`**（写远程 KV） |
| wrangler 4.x `kv key put` 把参数当值 | Worker 返回 `D:\...\tempfile` 路径文本 | 加 **`--path`** 选项（读文件内容） |
| KV namespace 同名 | `kv namespace create` 报错 | 先 `npx wrangler kv namespace list` 查已有 namespace，**复用现有 id** 填 wrangler.toml |
| CI Deploy command 默认 | 构建只跑 `wrangler deploy`，面板 503 | Dashboard Builds 里改成 **`npm run deploy`** |
| `workers.dev` 国内直连不通 | 面板 8s 超时 | 浏览器代理访问，或 Worker 绑定**自定义域名** |
| 一键按钮"无法获取存储库内容" | 按钮工具拉仓库失败 | 改用方式一/方式二（按钮工具对子目录等支持不完整） |

---

## 部署后使用

1. 打开面板 `https://hw-ai-shell-glm5-2.<ACCOUNT_ID>.workers.dev`（或自定义域名），输入 ADMIN_KEY 登录（会话 24h）；
2. 填 **Public Hostname 域名** 与 **tunnel run token**（token 在 Cloudflare Dashboard → Zero Trust → Networks → Tunnels 创建）；
3. 点"**随机生成**"API Key → 保存（存 KV）→ 复制；
4. 复制面板底部的容器部署命令，到 AI Shell 终端（root）执行：
   ```bash
   ADMIN_KEY='<你的ADMIN_KEY>' bash <(curl -fsSL https://hw-ai-shell-glm5-2.<ACCOUNT_ID>.workers.dev/scripts/deploy-remote.sh) https://hw-ai-shell-glm5-2.<ACCOUNT_ID>.workers.dev
   ```
   该命令自动：拉取配置与代理源码 → 启动代理(:5173) → 启动 Cloudflare Tunnel → 每 60s 上报心跳；
5. 面板实时显示容器状态与公网 URI `https://<域名>/v1`；客户端用 API Key 访问。

## 常用命令

```bash
npm run deploy   # 同步 KV + 部署 Worker（改了代码后重跑）
npm run sync     # 只把面板/脚本重新上传到 KV
npx wrangler tail  # 实时查看 Worker 日志
```
