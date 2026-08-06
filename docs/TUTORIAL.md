# 完整部署教程（实测通过版）

从零开始，把 **华为 AI Shell 容器内的 glm-5.2 模型能力** 部署为公网可用的 **OpenAI 兼容 API**。
本教程基于实际部署全程编写，每一步都经过验证。

```text
最终架构：
浏览器(管理面板) ──> admin.你的域名.com ──> Cloudflare Worker（面板 + KV + 脚本分发）
客户端(API 请求) ──> api.你的域名.com ────> Cloudflare Tunnel ──> AI Shell 容器 :5173 ──> hwcloud acp ──> glm-5.2
```

---

## 一、前置准备（30 分钟）

### 1.1 域名接入 Cloudflare（必须）

1. 注册 Cloudflare 账号：dash.cloudflare.com；
2. **Add a site** → 输入你的域名（如 `example.com`）→ 选择免费计划；
3. 按提示把域名的 Nameservers 改成 Cloudflare 给的两个（去你的域名注册商处改）；
4. 等状态变为 **Active**（通常几分钟~几小时）。

### 1.2 创建 Cloudflare API Token

用于自动部署。dash.cloudflare.com → 右上角头像 → **My Profile → API Tokens → Create Token → Create Custom Token**：

| 权限 | 用途 |
|---|---|
| 账户 → Cloudflare Tunnel → 编辑 | 自动创建隧道 |
| 账户 → Workers Scripts → 编辑 | 部署 Worker |
| 账户 → Workers KV Storage → 编辑 | 管理 KV |
| 区域 → DNS → 编辑 | 绑定域名 DNS |

> **区域资源**务必 Include 你的域名（这一步隐式授权 DNS 操作）。

创建后**立刻复制** Token（只显示一次）。

### 1.3 获取 Account ID

Dashboard 首页右侧的 **Account ID**（一串 32 位十六进制，形如 `ee736230...`）。

### 1.4 准备环境

- 一台能访问 GitHub 的电脑（国内需代理）；
- Node.js ≥ 18 + npm；
- 你的 AI Shell 容器能上网（后面验证）。

---

## 二、部署管理面板（Worker）（约 5 分钟）

```bash
# 1. 克隆仓库并安装依赖
git clone https://github.com/guowei21/HW-AI-Shell-GLM5.2.git
cd HW-AI-Shell-GLM5.2
npm install

# 2. 配置 Cloudflare 凭据
export CLOUDFLARE_API_TOKEN=<你的API Token>
export CLOUDFLARE_ACCOUNT_ID=<你的Account ID>

# 3. 创建 KV namespace（只需一次），把输出的 id 填入 wrangler.toml
npx wrangler kv namespace create KV
#    输出：id = "xxxx..." → 编辑 wrangler.toml，替换 id = "..." 为真实值

# 4. 设置面板登录密钥 ADMIN_KEY（只需一次）
npx wrangler secret put ADMIN_KEY

# 5. 上传提示词与技能到 KV（仓库自带 artifacts/：SOUL 提示词 + 14 个 CTF/安全技能，约 2.5MB）
#    容器部署时会整体替换容器内原有提示词/技能（未上传则保留原文件）
node upload-artifacts.mjs

# 6. 一键部署（自动：上传面板/脚本到 KV → 部署 Worker）
npm run deploy
```

部署成功会输出：

```text
Uploaded hw-ai-shell-glm5-2 (2.31 sec)
Deployed hw-ai-shell-glm5-2 triggers
  https://hw-ai-shell-glm5-2.<你的workers子域>.workers.dev
```

> ⚠️ **无需**设置 `wrangler secret put ADMIN_KEY`——管理密码由用户首次打开面板时自行设置（存 KV，可改）。

---

## 三、首次打开面板并设置密码（2 分钟）

1. 浏览器访问面板（`*.workers.dev` 国内直连可能不通，**需要代理**；或先做第四步绑定自定义域后直连）；
2. 首次打开显示"**设置管理密码**"表单 → 输入密码（≥8 位）→ 设置；
3. 回到登录界面，用刚设置的密码登录（会话 24h）。

> 之后可在面板内"**修改管理密码**"（改后旧会话立即失效，需重新登录）。

---

## 四、绑定面板自定义域名（可选但推荐，2 分钟）

`*.workers.dev` 在国内访问不稳定，绑定自己的子域（如 `admin.你的域名.com`）后可直连：

**方法 A：Dashboard**：Worker → `hw-ai-shell-glm5-2` → Settings → **Domains & Routes** → Add → 添加自定义域 `admin.你的域名.com`。

**方法 B：API 自动**（用你的 Token）：

```bash
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/workers/domains" \
  -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \
  -d '{"hostname":"admin.你的域名.com","service":"hw-ai-shell-glm5-2","environment":"production","zone_id":"<ZONE_ID>"}'
```

ZONE_ID 获取：`curl "https://api.cloudflare.com/client/v4/zones?name=你的域名" -H "Authorization: Bearer <TOKEN>"`

> ⚠️ 一个子域只能绑定一个服务。`admin.xxx` 给面板，`api.xxx` 给隧道（见下），互不冲突。

---

## 五、创建隧道并绑定 API 域名（5 分钟）

隧道把 AI Shell 容器的 `:5173` 暴露为公网 `api.你的域名.com`。

**方法 A：Dashboard 手动**
1. dash.cloudflare.com → **Zero Trust → Networks → Tunnels** → Create a tunnel → Cloudflared；
2. 命名（如 `aishell-tunnel`）→ 复制页面上的 **run token**（`--token` 后面一长串）；
3. 打开隧道 → **Public Hostname** → Add：
   - Subdomain: `api`，Domain: 你的域名
   - Service: `HTTP` → `localhost:5173`
4. 保存后 Cloudflare 自动创建 DNS CNAME。

**方法 B：API 自动（推荐，全自动）**
```bash
# 1) 创建隧道，拿 tunnel id
curl -X POST "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/cfd_tunnel" \
  -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \
  -d '{"name":"aishell-tunnel","config":{"warp_routing":{"enabled":false}}}'
#    → result.id = <TUNNEL_ID>

# 2) 获取 run token
curl "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/cfd_tunnel/<TUNNEL_ID>/token" \
  -H "Authorization: Bearer <TOKEN>"
#    → result = <RUN_TOKEN>（直接是字符串）

# 3) 配置 ingress：api.xxx → localhost:5173
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/cfd_tunnel/<TUNNEL_ID>/configurations" \
  -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \
  -d '{"config":{"ingress":[{"hostname":"api.你的域名.com","service":"http://localhost:5173"},{"service":"http_status:404"}]}}'

# 4) 创建 DNS CNAME
curl -X POST "https://api.cloudflare.com/client/v4/zones/<ZONE_ID>/dns_records" \
  -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \
  -d '{"type":"CNAME","name":"api","content":"<TUNNEL_ID>.cfargotunnel.com","proxied":true}'
```

---

## 六、在面板填写配置（2 分钟）

1. 打开面板（`admin.你的域名.com` 或 workers.dev）→ 登录；
2. **隧道与域名**卡片：
   - **Public Hostname 域名**：填 `api.你的域名.com` → 保存；
   - **tunnel run token**：填第五步拿到的 token → 保存；
3. **API Key**：点"随机生成"→ 保存（客户端访问 /v1 用，必设）；
4. 页面底部会生成**容器部署命令**（自动带当前面板地址）。

---

## 七、AI Shell 容器部署（2 分钟）

### 7.1 打开 root 终端

AI Shell 网页终端默认不是 root——在 **AI Shell 终端界面连续按下两次 `Ctrl+C`** 即可切换到 root 终端（容器内，具备安装权限）。

### 7.2 执行部署命令

回到面板，**AI Shell 容器部署命令**卡片：点击"复制"按钮（会自动把 `<部署时的ADMIN_KEY>` 替换成你的管理密码），然后粘贴到 AI Shell root 终端执行：

```bash
ADMIN_KEY='<你的管理密码>' bash <(curl -fsSL https://admin.你的域名.com/scripts/deploy-remote.sh) https://admin.你的域名.com
```

该命令自动完成：
1. 拉取配置（域名、隧道 token、API Key）与代理源码；
2. 启动 OpenAI 兼容代理（监听 `:5173`）；
3. 安装并启动 cloudflared，用 token 连接隧道；
4. 每 60 秒向面板上报心跳（代理/模型/隧道状态）。

---

## 八、验证与使用

```bash
# 1. 代理健康（容器内）
curl -fsS http://127.0.0.1:5173/health

# 2. 公网 API（任意设备，隧道连上后）
curl -fsS https://api.你的域名.com/v1/models \
  -H "Authorization: Bearer <API Key>"

# 3. 聊天请求
curl -fsS https://api.你的域名.com/v1/chat/completions \
  -H "Authorization: Bearer <API Key>" \
  -H 'Content-Type: application/json' \
  -d '{"model":"glm-5.2","messages":[{"role":"user","content":"你好"}]}'
```

**客户端配置**（任何 OpenAI 兼容客户端）：

```text
Base URL: https://api.你的域名.com/v1
API Key:  <面板生成的 Key>
Model:    glm-5.2
```

面板"可用服务 URI"卡片会显示公网/本地地址，容器状态卡片实时显示心跳。

---

## 九、日常维护

| 操作 | 命令 |
|---|---|
| 改代码后重新部署 | `npm run deploy`（自动同步 KV + 部署） |
| 只看面板/脚本有没有同步 | `npm run sync` |
| 查看 Worker 实时日志 | `npx wrangler tail` |
| 容器重启/更新代理 | 重新执行第七步的命令 |
| 修改管理密码 | 面板 → 修改管理密码 |
| 隧道状态 | Dashboard → Zero Trust → Tunnels |

## 十、常见问题（踩坑记录）

| 现象 | 原因 | 解决 |
|---|---|---|
| 面板 503"admin.html 未上传" | `kv key put` 默认写本地 | sync-kv.mjs 已加 `--remote`（更新代码后重新部署） |
| Worker 返回文件路径文本 | `kv key put` 把参数当值 | 已加 `--path` 选项 |
| `kv namespace create` 报同名 | 账号已有同名 KV | `npx wrangler kv namespace list` 复用现有 id 填 wrangler.toml |
| 构建报 `KV namespace ... not valid [10042]` | wrangler.toml 里 KV id 是占位符 | 填入真实 namespace id |
| `*.workers.dev` 打不开 | 国内直连不稳定 | 绑定自定义域（第四章），或浏览器开代理 |
| 一键按钮"无法获取存储库内容" | 按钮工具对仓库支持不完整 | 改用本教程的本地 wrangler 部署 |
| 想用 `api.xxx/admin` 访问面板 | 同一子域已被隧道占用 | Cloudflare 不支持同域路径分流；用 `admin.xxx` 独立子域 |

---

> 部署过程中需要的所有脚本（`deploy-remote.sh` 容器端、`sync-kv.mjs` KV 同步、`src/index.js` Worker）都已在仓库内，`npm run deploy` 一条命令完成部署。
