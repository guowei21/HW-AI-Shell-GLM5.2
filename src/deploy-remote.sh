#!/usr/bin/env bash
# =============================================================================
# AI Shell 容器一键部署（经 Cloudflare Workers 分发，免 git）
#
# 由 WebUI 生成命令调用，例如：
#   ADMIN_KEY='xxx' bash <(curl -fsSL https://<worker>.workers.dev/scripts/deploy-remote.sh) https://<worker>.workers.dev
#
# 动作：
#   1. 从 Worker /api/bootstrap 拉取配置（tunnel token / 域名 / API key）
#   2. 从 Worker /scripts/... 拉取代理源码
#   3. 启动 aishell-acp-openai-proxy（:5173）
#   4. 启动 cloudflared tunnel（--token）
#   5. 上报心跳 /api/heartbeat，并循环保活上报
# 可重复执行（重启容器后重跑即可）。
# =============================================================================
set -euo pipefail

WORKER_URL="${1:-${WORKER_URL:-}}"
ADMIN_KEY="${ADMIN_KEY:-}"
PROXY_PORT="${PROXY_PORT:-5173}"
PROXY_DIR="${PROXY_DIR:-/root/aishell-openai-proxy}"
HWCLOUD_BIN="${HWCLOUD_BIN:-/opt/hwcloud/v1.0.0-beta.10/hwcloud}"
NODE_BIN="${NODE_BIN:-/usr/local/nodejs/bin/node}"
HEARTBEAT_INTERVAL="${HEARTBEAT_INTERVAL:-60}"

if [[ -z "$WORKER_URL" || -z "$ADMIN_KEY" ]]; then
  echo '用法: ADMIN_KEY=xxx bash <(curl -fsSL <worker>/scripts/deploy-remote.sh) <worker>' >&2
  exit 1
fi
AUTH=(-H "X-Admin-Key: $ADMIN_KEY")

echo '==> 1/5 拉取配置'
CONFIG="$(curl -fsSL "${AUTH[@]}" "$WORKER_URL/api/bootstrap")"
TOKEN="$(echo "$CONFIG" | "$NODE_BIN" -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const o=JSON.parse(d);console.log(o.token||'')}catch{}})" 2>/dev/null || true)"
API_KEY="$(echo "$CONFIG" | "$NODE_BIN" -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const o=JSON.parse(d);console.log(o.apiKey||'')}catch{}})" 2>/dev/null || true)"
DOMAIN="$(echo "$CONFIG" | "$NODE_BIN" -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const o=JSON.parse(d);console.log(o.domain||'')}catch{}})" 2>/dev/null || true)"
[[ -n "$TOKEN" ]] || { echo '错误：bootstrap 未返回 token（面板里填了吗？）' >&2; exit 1; }
echo "    域名: ${DOMAIN:-（未配置）}"

echo '==> 2/5 拉取代理源码'
mkdir -p "$PROXY_DIR"
curl -fsSL "${AUTH[@]}" "$WORKER_URL/scripts/aishell-acp-openai-proxy.mjs" \
  -o "$PROXY_DIR/aishell-acp-openai-proxy.mjs"
chmod 600 "$PROXY_DIR/aishell-acp-openai-proxy.mjs"

echo '==> 3/5 启动代理（:5173）'
pkill -f 'aishell-acp-openai-proxy.mjs' 2>/dev/null || true
nohup env \
  LOCAL_PROXY_API_KEY="$API_KEY" \
  HOST=0.0.0.0 PORT="$PROXY_PORT" \
  HWCLOUD_BIN="$HWCLOUD_BIN" \
  "$NODE_BIN" "$PROXY_DIR/aishell-acp-openai-proxy.mjs" \
  >"$PROXY_DIR/proxy.log" 2>&1 &
sleep 2

echo '==> 4/5 启动 Cloudflare Tunnel'
if ! command -v cloudflared >/dev/null 2>&1; then
  echo '    安装 cloudflared...'
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64|amd64) CF_ARCH=amd64 ;;
    aarch64|arm64) CF_ARCH=arm64 ;;
    *) echo "不支持的架构 $ARCH" >&2; exit 1 ;;
  esac
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}" \
    -o /usr/local/bin/cloudflared
  chmod 755 /usr/local/bin/cloudflared
fi
pkill -f 'cloudflared tunnel run' 2>/dev/null || true
nohup cloudflared tunnel run --token "$TOKEN" >"$PROXY_DIR/cloudflared.log" 2>&1 &

echo '==> 5/5 心跳上报与保活'
heartbeat() {
  local up models_json tun
  up="$(curl -fsS "http://127.0.0.1:$PROXY_PORT/health" 2>/dev/null || echo '{}')"
  models_json="$(curl -fsS "http://127.0.0.1:$PROXY_PORT/v1/models" 2>/dev/null | head -c 2000 || echo '{"data":[]}')"
  if pgrep -f 'cloudflared tunnel run' >/dev/null 2>&1; then tun='{"running":true}'; else tun='{"running":false}'; fi
  curl -fsS -X POST "${AUTH[@]}" -H 'Content-Type: application/json' \
    -d "{\"upstream\":$up,\"models\":$models_json,\"tunnel\":$tun,\"host\":\"$(hostname)\"}" \
    "$WORKER_URL/api/heartbeat" >/dev/null 2>&1 || true
}
while true; do heartbeat; sleep "$HEARTBEAT_INTERVAL"; done &
echo
echo '================ 部署完成 ================'
echo "代理:  http://127.0.0.1:$PROXY_PORT/v1"
echo "公网:  ${DOMAIN:+https://$DOMAIN/v1}（隧道连上后生效）"
echo '=========================================='
