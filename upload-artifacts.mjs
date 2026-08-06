// 上传提示词（SOUL.md）与技能包到 Cloudflare KV
// 用法（需已配置 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID，在 git bash 中运行）：
//   node upload-artifacts.mjs
// 目录结构约定：
//   artifacts/
//     soul.md          # 自定义系统提示词（可选）
//     skills/          # 技能包（可选，每个子目录一个技能，含 SKILL.md 等）
//       <skill-name>/
//         SKILL.md
//         scripts/ ... references/ ...（按技能需要）
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const ART = path.join(ROOT, 'artifacts');
const SOUL = path.join(ART, 'soul.md');
const SKILLS = path.join(ART, 'skills');

function run(cmd) {
  execSync(cmd, { stdio: 'inherit', shell: process.env.SHELL || true });
}

console.log('=== 上传提示词与技能到 KV ===\n');

// 1. SOUL.md
if (existsSync(SOUL)) {
  const size = statSync(SOUL).size;
  console.log(`[1/2] 上传 SOUL.md（${size} 字节）...`);
  run(`npx wrangler kv key put --binding=KV "soul:SOUL.md" --path "${SOUL}" --remote`);
  console.log('  ✓ SOUL.md 已上传\n');
} else {
  console.log('[1/2] 未找到 artifacts/soul.md，跳过 SOUL\n');
}

// 2. Skills 打包上传
if (existsSync(SKILLS)) {
  const items = readdirSync(SKILLS).filter((n) => statSync(path.join(SKILLS, n)).isDirectory());
  if (items.length) {
    const tmp = path.join(os.tmpdir(), `aishell-skills-${Date.now()}.tar.gz`);
    console.log(`[2/2] 打包 ${items.length} 个技能 → tar.gz 上传 KV ...`);
    console.log('      技能: ' + items.join(', '));
    // git bash 环境（PATH 含 Git usr/bin），tar 可用；打包 skills 目录整体（含目录名层级）
    run(`tar czf "${tmp}" -C "${ART}" skills`);
    const pkgSize = statSync(tmp).size;
    run(`npx wrangler kv key put --binding=KV "skills:package" --path "${tmp}" --remote`);
    rmSync(tmp, { force: true });
    console.log(`  ✓ skills 包已上传（${items.length} 个技能，${(pkgSize / 1024 / 1024).toFixed(2)} MB）\n`);
  } else {
    console.log('[2/2] artifacts/skills/ 下没有技能子目录，跳过\n');
  }
} else {
  console.log('[2/2] 未找到 artifacts/skills/ 目录，跳过\n');
}

console.log('完成。容器重跑部署命令即可替换生效。');
