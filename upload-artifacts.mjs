// 上传提示词（SOUL.md）与技能包到 Cloudflare KV
// 用法（需已配置 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID，在 git bash 中运行）：
//   node upload-artifacts.mjs
// 目录结构约定：
//   artifacts/
//     soul.md          # 默认系统提示词（可选）——容器部署默认使用，替换容器 SOUL.md
//     soul-keysmith.md # 第二套提示词（可选）——安全研究模式，SOUL_KIND=keysmith 时使用
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
const SOUL_KEYS = path.join(ART, 'soul-keysmith.md');
const SKILLS = path.join(ART, 'skills');

function run(cmd) {
  execSync(cmd, { stdio: 'inherit', shell: process.env.SHELL || true });
}

console.log('=== 上传提示词与技能到 KV ===\n');

// 1. SOUL.md（默认提示词）
if (existsSync(SOUL)) {
  const size = statSync(SOUL).size;
  console.log(`[1/3] 上传默认提示词 soul.md（${size} 字节）→ soul:SOUL.md ...`);
  run(`npx wrangler kv key put --binding=KV "soul:SOUL.md" --path "${SOUL}" --remote`);
  console.log('  ✓ 默认提示词已上传\n');
} else {
  console.log('[1/3] 未找到 artifacts/soul.md，跳过\n');
}

// 1b. soul-keysmith.md（第二套提示词）
if (existsSync(SOUL_KEYS)) {
  const size = statSync(SOUL_KEYS).size;
  console.log(`[2/3] 上传第二套提示词 soul-keysmith.md（${size} 字节）→ soul:keysmith ...`);
  run(`npx wrangler kv key put --binding=KV "soul:keysmith" --path "${SOUL_KEYS}" --remote`);
  console.log('  ✓ keysmith 提示词已上传（容器部署时 SOUL_KIND=keysmith 切换）\n');
} else {
  console.log('[2/3] 未找到 artifacts/soul-keysmith.md，跳过\n');
}

// 2. Skills 打包上传
if (existsSync(SKILLS)) {
  const items = readdirSync(SKILLS).filter((n) => statSync(path.join(SKILLS, n)).isDirectory());
  if (items.length) {
    const tmp = path.join(os.tmpdir(), `aishell-skills-${Date.now()}.tar.gz`);
    console.log(`[3/3] 打包 ${items.length} 个技能 → tar.gz 上传 KV ...`);
    console.log('      技能: ' + items.join(', '));
    // git bash 环境（PATH 含 Git usr/bin），tar 可用；打包 skills 目录整体（含目录名层级）
    run(`tar czf "${tmp}" -C "${ART}" skills`);
    const pkgSize = statSync(tmp).size;
    run(`npx wrangler kv key put --binding=KV "skills:package" --path "${tmp}" --remote`);
    rmSync(tmp, { force: true });
    console.log(`  ✓ skills 包已上传（${items.length} 个技能，${(pkgSize / 1024 / 1024).toFixed(2)} MB）\n`);
  } else {
    console.log('[3/3] artifacts/skills/ 下没有技能子目录，跳过\n');
  }
} else {
  console.log('[3/3] 未找到 artifacts/skills/ 目录，跳过\n');
}

console.log('完成。容器重跑部署命令即可替换生效（默认提示词；加 SOUL_KIND=keysmith 用第二套）。');
