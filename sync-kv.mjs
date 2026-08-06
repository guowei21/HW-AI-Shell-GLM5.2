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
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// sync-kv.mjs 位于仓库根：ROOT 就是本文件所在目录（本地与 CI 的 repo 根一致）
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TOML = path.join(ROOT, 'wrangler.toml');
const KV_PLACEHOLDER = 'REPLACE_WITH_KV_NAMESPACE_ID';

// 若 wrangler.toml 中 KV namespace id 仍是占位符，自动创建并回填（本地/CI 均可，需已认证 wrangler）
function ensureKV() {
  let toml = readFileSync(TOML, 'utf8');
  if (!toml.includes(KV_PLACEHOLDER)) return;
  console.log('==> KV namespace id 为占位符，自动创建 KV namespace ...');
  const out = execSync('npx wrangler kv namespace create KV', {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const m = out.match(/id\s*=\s*"([a-zA-Z0-9]{32})"/);
  if (!m) throw new Error('无法解析 KV namespace id，输出: ' + out.slice(0, 300));
  writeFileSync(TOML, toml.replace(KV_PLACEHOLDER, m[1]));
  console.log(`==> 已创建 KV namespace: ${m[1]}，已写入 wrangler.toml`);
}

ensureKV();

const files = {
  'page:admin.html': path.join(ROOT, 'src', 'admin.html'),
  'script:aishell-acp-openai-proxy.mjs': path.join(ROOT, 'aishell-acp-openai-proxy.mjs'),
  'script:deploy-remote.sh': path.join(ROOT, 'src', 'deploy-remote.sh'),
};

for (const [key, file] of Object.entries(files)) {
  const content = readFileSync(file, 'utf8');
  const tmp = path.join(os.tmpdir(), `aishell-kv-${key.replace(/[^a-z0-9]/gi, '_')}`);
  writeFileSync(tmp, content);
  console.log(`上传 ${key} (${content.length} bytes) ...`);
  execSync(`npx wrangler kv key put --binding=KV "${key}" --path "${tmp}" --remote`, { stdio: 'inherit', cwd: path.dirname(fileURLToPath(import.meta.url)) });
  unlinkSync(tmp);
}
console.log('同步完成');
