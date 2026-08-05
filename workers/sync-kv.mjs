#!/usr/bin/env node
/**
 * 同步脚本到 KV —— 把仓库里的代理源码与容器端部署脚本上传到 Workers KV，
 * 供 /scripts/<name> 分发（免 git 部署）。
 *
 * 用法：
 *   ADMIN_KEY 由 wrangler 注入；KV 绑定在 worker 内，此处用 wrangler 的 kv key 命令：
 *   npx wrangler kv key put --binding=KV "script:aishell-acp-openai-proxy.mjs" < ../aishell-acp-openai-proxy.mjs
 *   npx wrangler kv key put --binding=KV "script:deploy-remote.sh" < src/deploy-remote.sh
 *
 * 也可直接执行本脚本（需先登录 wrangler）：
 *   node sync-kv.mjs
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const files = {
  'page:admin.html': path.join(ROOT, 'workers', 'src', 'admin.html'),
  'script:aishell-acp-openai-proxy.mjs': path.join(ROOT, 'aishell-acp-openai-proxy.mjs'),
  'script:deploy-remote.sh': path.join(ROOT, 'workers', 'src', 'deploy-remote.sh'),
};

for (const [key, file] of Object.entries(files)) {
  const content = readFileSync(file, 'utf8');
  const tmp = `/tmp/aishell-kv-${key.replace(/[^a-z0-9]/gi, '_')}`;
  writeFileSync(tmp, content);
  console.log(`上传 ${key} (${content.length} bytes) ...`);
  execSync(`npx wrangler kv key put --binding=KV "${key}" "${tmp}"`, { stdio: 'inherit', cwd: path.dirname(fileURLToPath(import.meta.url)) });
  unlinkSync(tmp);
}
console.log('同步完成');
