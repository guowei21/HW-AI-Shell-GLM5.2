/**
 * AI Shell 管理中枢 —— Cloudflare Workers
 *
 * 职责（全部云端，本地零部署）：
 *   1. 托管 WebUI（GET /）——可视化面板（admin.html 存 KV，key: page:admin.html）
 *   2. 配置存储（KV）：tunnel token、公网域名、API key、容器心跳
 *   3. 脚本分发（GET /api/bootstrap + /scripts/）：AI Shell 容器一行 curl 拉取后自动部署
 *
 * 鉴权（管理密码存 KV，key: admin_key，首次打开面板时由用户自行设置，可在面板内修改）：
 *   - 首次：GET /api/setup-status 返回 needsSetup；用户设置密码 POST /api/setup
 *   - 面板：POST /api/login 用管理密码换取 24h 会话 token（HMAC 签名），
 *           后续请求带 Authorization: Bearer <token>
 *   - 容器：直接带 X-Admin-Key 头（容器没有登录环节，需密码本身）
 *   - 修改密码：POST /api/change-password（需登录态 + 旧密码）
 *
 * 部署：
 *   npx wrangler kv namespace create KV        # 建 KV，把 id 填进 wrangler.toml
 *   node sync-kv.mjs                           # 上传 admin.html + 脚本到 KV
 *   npx wrangler deploy                        # 无需设置 ADMIN_KEY secret（密码由用户首次设置）
 *
 * 路由：
 *   GET  /                → WebUI（KV: page:admin.html）
 *   GET  /api/health      → 健康检查（无需鉴权）
 *   GET  /api/setup-status→ 是否首次（无需鉴权）
 *   POST /api/setup       → 首次设置管理密码（仅未设置时）
 *   POST /api/login       → 密码换会话 token
 *   POST /api/change-password → 修改管理密码（需登录态 + 旧密码）
 *   GET  /api/status      → 面板：读 KV 配置 + 心跳
 *   POST /api/config      → 面板：保存 token/域名/API key
 *   GET  /api/bootstrap   → 容器：拉 token/域名/API key 全量配置
 *   POST /api/heartbeat   → 容器：上报运行状态
 *   GET  /scripts/<file>  → 容器：拉取仓库脚本（免 git 部署）
 */

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const KV = env.KV;

    // WebUI（无需鉴权，管理操作本身走 /api 鉴权）
    if (method === 'GET' && (path === '/' || path === '/index.html')) {
      const html = await KV.get('page:admin.html');
      if (html === null) return json({ error: 'admin.html 未上传，请先运行 node sync-kv.mjs' }, 503);
      return htmlRes(html);
    }

    // 健康检查（无鉴权）
    if (path === '/api/health') {
      return json({ ok: true, worker: 'hw-ai-shell-glm5-2', ts: Date.now() });
    }

    // 是否首次使用（管理密码未设置，无鉴权）
    if (method === 'GET' && path === '/api/setup-status') {
      const current = await getAdminKey(env);
      return json({ needsSetup: !current });
    }

    // 首次设置管理密码（仅当当前没有任何管理密码时）
    if (method === 'POST' && path === '/api/setup') {
      const body = await request.json().catch(() => ({}));
      const key = String(body.key || '').trim();
      const current = await getAdminKey(env);
      if (current) return json({ ok: false, error: '管理密码已设置，请直接登录' }, 400);
      if (key.length < 8) return json({ ok: false, error: '管理密码至少 8 位' }, 400);
      await KV.put('admin_key', key);
      return json({ ok: true });
    }

    // 登录：密码 → 会话 token
    if (method === 'POST' && path === '/api/login') {
      const body = await request.json().catch(() => ({}));
      const key = String(body.key || '').trim();
      const current = await getAdminKey(env);
      if (!current || key !== current) {
        return json({ ok: false, error: '密码错误' }, 401);
      }
      const token = await signSession(current, Date.now() + SESSION_TTL_MS);
      return json({ ok: true, token, expiresIn: SESSION_TTL_MS });
    }

    // 统一鉴权：Bearer 会话 token 或 X-Admin-Key
    const authorized = await isAuthorized(request, env);
    if (!authorized) return json({ error: 'unauthorized' }, 401);

    // 修改管理密码（需登录态 + 旧密码正确）
    if (method === 'POST' && path === '/api/change-password') {
      const body = await request.json().catch(() => ({}));
      const oldKey = String(body.oldKey || '').trim();
      const newKey = String(body.newKey || '').trim();
      const current = await getAdminKey(env);
      if (!current || oldKey !== current) return json({ ok: false, error: '旧密码错误' }, 401);
      if (newKey.length < 8) return json({ ok: false, error: '新密码至少 8 位' }, 400);
      await KV.put('admin_key', newKey);
      return json({ ok: true, message: '密码已修改，请用新密码重新登录' });
    }

    if (method === 'GET' && path === '/api/status') {
      const [domain, token, apiKey, heartbeatRaw] = await Promise.all([
        KV.get('domain'), KV.get('token'), KV.get('api_key'), KV.get('heartbeat'),
      ]);
      let heartbeat = null;
      if (heartbeatRaw) { try { heartbeat = JSON.parse(heartbeatRaw); } catch { heartbeat = null; } }
      return json({
        domain: domain || '',
        hasToken: !!token,
        apiKey: apiKey || '',
        heartbeat,
      });
    }

    if (method === 'POST' && path === '/api/config') {
      const body = await request.json().catch(() => ({}));
      const ops = [];
      if (body.domain !== undefined) ops.push(KV.put('domain', String(body.domain).trim()));
      if (body.token !== undefined) ops.push(KV.put('token', String(body.token).trim()));
      if (body.apiKey !== undefined) ops.push(KV.put('api_key', String(body.apiKey).trim()));
      await Promise.all(ops);
      return json({ ok: true });
    }

    // 容器端拉取全量配置（bootstrap）
    if (method === 'GET' && path === '/api/bootstrap') {
      const [token, domain, apiKey] = await Promise.all([
        KV.get('token'), KV.get('domain'), KV.get('api_key'),
      ]);
      if (!token) return json({ ok: false, error: 'tunnel token 未配置，请先在面板填写' }, 400);
      return json({ ok: true, token, domain: domain || '', apiKey: apiKey || '' });
    }

    // 容器心跳上报
    if (method === 'POST' && path === '/api/heartbeat') {
      const body = await request.json().catch(() => ({}));
      const heartbeat = {
        ts: Date.now(),
        upstream: body.upstream ?? null,   // 代理 /health 摘要
        models: body.models ?? null,       // /v1/models 摘要
        tunnel: body.tunnel ?? null,       // cloudflared 状态
        host: body.host || '',
      };
      await KV.put('heartbeat', JSON.stringify(heartbeat));
      return json({ ok: true });
    }

    // 脚本分发（免 git：容器 curl 拉取）
    if (method === 'GET' && path.startsWith('/scripts/')) {
      const name = decodeURIComponent(path.slice('/scripts/'.length));
      const content = await KV.get(`script:${name}`);
      if (content === null) return json({ error: `script not found: ${name}` }, 404);
      return new Response(content, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    return json({ error: 'not found' }, 404);
  },
};

// ---- 会话 token（HMAC-SHA256 签名；payload base64url + 签名 hex）------------
async function signSession(secret, exp) {
  const payload = btoa(JSON.stringify({ exp }));
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigBuf = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  const sig = [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${payload}.${sig}`;
}

async function verifySession(token, secret) {
  try {
    const [payload, sig] = token.split('.');
    if (!payload || !sig || !/^[0-9a-f]{64}$/i.test(sig)) return false;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const signature = Uint8Array.from(sig.match(/.{2}/g).map((h) => parseInt(h, 16)));
    const ok = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(payload));
    if (!ok) return false;
    const data = JSON.parse(atob(payload));
    return typeof data.exp === 'number' && data.exp > Date.now();
  } catch {
    return false;
  }
}

// 获取当前有效管理密码：KV 优先（用户设置/修改后以 KV 为准），env 作为兼容兜底
async function getAdminKey(env) {
  const kv = await env.KV.get('admin_key');
  return kv || env.ADMIN_KEY || '';
}

async function isAuthorized(request, env) {
  const current = await getAdminKey(env);
  if (!current) return false;
  const bearer = request.headers.get('Authorization') || '';
  if (bearer.startsWith('Bearer ')) {
    return verifySession(bearer.slice(7).trim(), current);
  }
  const key = request.headers.get('X-Admin-Key') || '';
  return key === current;
}

function htmlRes(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
