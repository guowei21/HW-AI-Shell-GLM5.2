# 提示词与技能（上传到 KV，容器部署时整体替换）

## 目录结构

```
artifacts/
  soul.md          # 默认系统提示词（可选）——部署默认使用，整文件替换容器 /root/.huawei/hwcloud/SOUL.md
  soul-keysmith.md # 第二套提示词（可选）——安全研究模式（codex-keysmith），SOUL_KIND=keysmith 时使用
  skills/          # 技能包（可选）——部署时删除容器 /root/.agents/skills/ 全部原技能后解压替换
    <skill-name>/      # 每个子目录一个技能，标准 SKILL.md 结构
      SKILL.md
      scripts/ ... references/ ...（按技能需要）
```

## 两套提示词说明

| 文件 | 内容 | 部署方式 |
|---|---|---|
| `soul.md` | AGENTS.md Operator Core（通用工程师人格） | 默认（不带额外参数） |
| `soul-keysmith.md` | codex-keysmith unrestricted（安全研究模式，配合 CTF 技能） | `SOUL_KIND=keysmith` |

## 使用流程

1. **放文件**：把 `soul.md`（可选 `soul-keysmith.md`）和技能目录放进 `artifacts/`；
2. **上传 KV**（需 Cloudflare token 环境变量，git bash 中运行）：
   ```bash
   export CLOUDFLARE_API_TOKEN=<你的token>
   export CLOUDFLARE_ACCOUNT_ID=<你的账号ID>
   node upload-artifacts.mjs
   ```
3. **容器部署**：重跑面板的部署命令——
   ```bash
   # 默认提示词（soul.md / AGENTS.md）
   ADMIN_KEY='<密码>' bash <(curl -fsSL https://admin.你的域名.com/scripts/deploy-remote.sh) https://admin.你的域名.com

   # 第二套提示词（soul-keysmith.md / 安全研究模式）
   SOUL_KIND=keysmith ADMIN_KEY='<密码>' bash <(curl -fsSL https://admin.你的域名.com/scripts/deploy-remote.sh) https://admin.你的域名.com
   ```
   脚本会自动：拉 SOUL（按 kind）→ 删旧写新；拉技能包 → 删除容器原技能 → 解压替换 → 重启代理（hwcloud 读到新配置）。

## 机制说明

- **KV key**：`soul:SOUL.md`（默认提示词）、`soul:keysmith`（第二套）、`skills:package`（tar.gz 二进制，单包 ≤ 25MB，3MB 绰绰有余）；
- **下载接口**：`GET /api/artifacts/soul`（默认）、`GET /api/artifacts/soul?kind=keysmith`（第二套）、`GET /api/artifacts/skills`（gzip 二进制，arrayBuffer 读取）；均需 `X-Admin-Key` 鉴权，部署脚本自动携带；
- **替换语义**：SOUL 整文件覆盖；技能为**删除容器原有全部技能**后整体解压，实现"我们部署的才是唯一生效的"；
- **未上传**：KV 无对应 key 时保留容器原文件，不影响已有部署。

## 注意事项

- 技能包内结构必须是 `skills/<skill-name>/...`（上传脚本已按此打包）；
- 替换技能后 hwcloud 重启生效（部署脚本已自动重启代理）；
- 大文件（>1MB）上传建议直接 `node upload-artifacts.mjs`，不要走面板（面板适合小配置）。
