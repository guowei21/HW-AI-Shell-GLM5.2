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

# 确保 SSH 服务（22 端口）常开（幂等：密钥/配置已存在则不重复，运行中不重启）
echo '==> 准备 SSH 服务（:22）'
mkdir -p /root/.ssh && chmod 700 /root/.ssh
if [ ! -f /root/.ssh/id_ed25519 ]; then
  ssh-keygen -t ed25519 -N "" -f /root/.ssh/id_ed25519 -q >/dev/null 2>&1 || true
  cat /root/.ssh/id_ed25519.pub >> /root/.ssh/authorized_keys 2>/dev/null || true
  chmod 600 /root/.ssh/authorized_keys 2>/dev/null || true
fi
SSHD_CFG=/etc/ssh/sshd_config
# 自修复：AuthorizedKeysFile 行曾被 echo -e "\n" 未生效粘行污染（值变成
# ".ssh/authorized_keysPermitRootLogin prohibit-password" → sshd 找不到公钥 → 拒绝登录）
sed -i 's|^AuthorizedKeysFile.*PermitRootLogin.*|AuthorizedKeysFile  .ssh/authorized_keys|' "$SSHD_CFG" 2>/dev/null || true
grep -qs '^PermitRootLogin' "$SSHD_CFG" || echo 'PermitRootLogin prohibit-password' >> "$SSHD_CFG"
grep -qs '^PasswordAuthentication' "$SSHD_CFG" || echo 'PasswordAuthentication no' >> "$SSHD_CFG"
if ! pgrep -x sshd >/dev/null 2>&1; then
  /usr/sbin/sshd >/dev/null 2>&1 || service ssh start >/dev/null 2>&1 || true
  sleep 1
fi
ss -tln 2>/dev/null | grep -q ':22' && echo '    SSH :22 已开启（密钥登录）' || echo '    ⚠ SSH 未开启（容器可能无 sshd）'
# 上传 SSH 私钥到面板（供面板显示/一键复制）
if [ -f /root/.ssh/id_ed25519 ]; then
  KEYJSON="$("$NODE_BIN" -e "const fs=require('fs');process.stdout.write(JSON.stringify({sshKey:fs.readFileSync('/root/.ssh/id_ed25519','utf8')}))" 2>/dev/null || true)"
  if [ -n "$KEYJSON" ]; then
    curl -fsS -X POST "${AUTH[@]}" -H 'Content-Type: application/json' -d "$KEYJSON" "$WORKER_URL/api/config" >/dev/null 2>&1 || true
    echo '    SSH 私钥已上传面板'
  fi
fi

echo '==> 1/5 拉取配置'
CONFIG="$(curl -fsSL "${AUTH[@]}" "$WORKER_URL/api/bootstrap")"
TOKEN="$(echo "$CONFIG" | "$NODE_BIN" -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const o=JSON.parse(d);console.log(o.token||'')}catch{}})" 2>/dev/null || true)"
API_KEY="$(echo "$CONFIG" | "$NODE_BIN" -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const o=JSON.parse(d);console.log(o.apiKey||'')}catch{}})" 2>/dev/null || true)"
DOMAIN="$(echo "$CONFIG" | "$NODE_BIN" -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const o=JSON.parse(d);console.log(o.domain||'')}catch{}})" 2>/dev/null || true)"
MODEL="$(echo "$CONFIG" | "$NODE_BIN" -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const o=JSON.parse(d);console.log(o.model||'')}catch{}})" 2>/dev/null || true)"
AUTO_APPROVE="$(echo "$CONFIG" | "$NODE_BIN" -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const o=JSON.parse(d);console.log(o.autoApprove?1:0)}catch{console.log(0)}})" 2>/dev/null || true)"
[[ -n "$AUTO_APPROVE" ]] || AUTO_APPROVE=0
[[ -n "$TOKEN" ]] || { echo '错误：bootstrap 未返回 token（面板里填了吗？）' >&2; exit 1; }
echo "    域名: ${DOMAIN:-（未配置）}"
echo "    自动批准: $([ "$AUTO_APPROVE" = 1 ] && echo '开启（工具/命令自动允许）' || echo '关闭（每步确认）')"

# 应用模型配置：写入容器 settings.json 的 current_model（面板/环境变量 MODEL 均可覆盖）
if [[ -n "${MODEL:-${HUAWEI_GLM_MODEL:-}}" ]]; then
  TARGET_MODEL="${MODEL:-${HUAWEI_GLM_MODEL:-}}"
  SETTINGS_FILE="$HOME/.huawei/hwcloud/settings.json"
  if [[ -f "$SETTINGS_FILE" ]]; then
    CUR_MODEL="$("$NODE_BIN" -e "try{const o=require('$SETTINGS_FILE');console.log(o.current_model||'')}catch{console.log('')}" 2>/dev/null || true)"
    if [[ "$CUR_MODEL" != "$TARGET_MODEL" ]]; then
      "$NODE_BIN" -e "const fs=require('fs');const p='$SETTINGS_FILE';const o=JSON.parse(fs.readFileSync(p,'utf8'));o.current_model=process.argv[1];fs.writeFileSync(p,JSON.stringify(o,null,2))" "$TARGET_MODEL" 2>/dev/null \
        && echo "    模型: $TARGET_MODEL（已写入 settings.json，原为 ${CUR_MODEL:-无}）" \
        || echo "    ⚠ 模型写入失败"
    else
      echo "    模型: $TARGET_MODEL（已生效）"
    fi
  else
    echo "    ⚠ settings.json 不存在，跳过模型配置"
  fi
else
  echo "    模型: （面板未设置，保持容器默认）"
fi

echo '==> 2/5 拉取代理源码'
mkdir -p "$PROXY_DIR"
curl -fsSL "${AUTH[@]}" "$WORKER_URL/scripts/aishell-acp-openai-proxy.mjs" \
  -o "$PROXY_DIR/aishell-acp-openai-proxy.mjs"
chmod 600 "$PROXY_DIR/aishell-acp-openai-proxy.mjs"

# 清理残留进程（配置与源码已拉取成功才停止旧服务；中途失败时旧服务不受影响）
echo '==> 停止旧服务（代理/隧道/心跳）'
pkill -f "sleep ${HEARTBEAT_INTERVAL}" 2>/dev/null || true   # 旧心跳循环在 sleep 状态
pkill -f 'aishell-acp-openai-proxy.mjs' 2>/dev/null || true
pkill -f 'cloudflared tunnel run' 2>/dev/null || true
rm -f "$PROXY_DIR/heartbeat.pid" 2>/dev/null || true
sleep 1   # 给旧进程一点时间退出

echo '==> 部署提示词与技能（替换式）'
# SOUL.md（系统提示词）：SOUL_KIND=keysmith 用第二套（安全研究），默认 default（AGENTS.md 工程师人格）
# 上传过则整文件替换，否则保留容器原文件
SOUL_FILE="$HOME/.huawei/hwcloud/SOUL.md"
SOUL_KIND="${SOUL_KIND:-default}"
SOUL_URL="$WORKER_URL/api/artifacts/soul?kind=$SOUL_KIND"
if SOUL_CONTENT="$(curl -fsSL "${AUTH[@]}" "$SOUL_URL" 2>/dev/null)"; then
  rm -f "$SOUL_FILE"
  printf '%s\n' "$SOUL_CONTENT" > "$SOUL_FILE"
  echo "    SOUL.md 已替换（$SOUL_KIND，$(wc -c < "$SOUL_FILE" 2>/dev/null || echo 0) 字节）"
else
  echo "    （KV 未上传该 SOUL（$SOUL_KIND），保留容器原 SOUL.md）"
fi
# 技能包：KV 有包则整体替换（删除容器原有全部技能），否则保留
SKILLS_DIR="$HOME/.agents/skills"
if curl -fsSL "${AUTH[@]}" "$WORKER_URL/api/artifacts/skills" -o /tmp/aishell-skills.tar.gz 2>/dev/null && tar tzf /tmp/aishell-skills.tar.gz >/dev/null 2>&1; then
  rm -rf "$SKILLS_DIR"
  mkdir -p "$HOME/.agents"
  tar xzf /tmp/aishell-skills.tar.gz -C "$HOME/.agents"
  N_SKILLS="$(find "$SKILLS_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)"
  echo "    技能包已替换（$N_SKILLS 个技能）"
else
  echo "    （KV 无技能包，保留容器原技能）"
fi
rm -f /tmp/aishell-skills.tar.gz

echo '==> 3/5 启动代理（:5173）'
pkill -f 'aishell-acp-openai-proxy.mjs' 2>/dev/null || true
nohup env \
  LOCAL_PROXY_API_KEY="$API_KEY" \
  HOST=0.0.0.0 PORT="$PROXY_PORT" \
  HWCLOUD_BIN="$HWCLOUD_BIN" \
  ACP_AUTO_APPROVE="$AUTO_APPROVE" \
  "$NODE_BIN" "$PROXY_DIR/aishell-acp-openai-proxy.mjs" \
  >"$PROXY_DIR/proxy.log" 2>&1 &
sleep 2

echo '==> 4/5 启动 Cloudflare Tunnel'
if ! command -v cloudflared >/dev/null 2>&1 || [ ! -x "$(command -v cloudflared 2>/dev/null)" ]; then
  echo '    安装 cloudflared（多镜像加速）...'
  rm -f /usr/local/bin/cloudflared   # 清理上次下载残留（避免权限/损坏问题）
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64|amd64) CF_ARCH=amd64 ;;
    aarch64|arm64) CF_ARCH=arm64 ;;
    *) echo "不支持的架构 $ARCH" >&2; exit 1 ;;
  esac
  CFDL="cloudflared-linux-${CF_ARCH}"
  DL_OK=0
  for URL in \
    "https://ghfast.top/https://github.com/cloudflare/cloudflared/releases/latest/download/${CFDL}" \
    "https://mirror.ghproxy.com/https://github.com/cloudflare/cloudflared/releases/latest/download/${CFDL}" \
    "https://gh-proxy.com/https://github.com/cloudflare/cloudflared/releases/latest/download/${CFDL}" \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/${CFDL}"; do
    echo "    尝试: $URL"
    if curl -fsSL --connect-timeout 10 --max-time 180 "$URL" -o /usr/local/bin/cloudflared; then
      DL_OK=1
      echo '    下载成功'
      break
    fi
    echo '    失败，换下一个源...'
  done
  if [ "$DL_OK" -ne 1 ]; then
    echo 'cloudflared 下载失败，请检查网络后重试（或手动下载放 /usr/local/bin/cloudflared）' >&2
    exit 1
  fi
  chmod 755 /usr/local/bin/cloudflared
fi
pkill -f 'cloudflared tunnel run' 2>/dev/null || true
nohup cloudflared tunnel run --token "$TOKEN" >"$PROXY_DIR/cloudflared.log" 2>&1 &

echo '==> 5/5 心跳上报与保活'
heartbeat() {
  local up models_json tun
  up="$(curl -fsS -H "Authorization: Bearer $API_KEY" "http://127.0.0.1:$PROXY_PORT/health" 2>/dev/null || echo '{}')"
  models_json="$(curl -fsS -H "Authorization: Bearer $API_KEY" "http://127.0.0.1:$PROXY_PORT/v1/models" 2>/dev/null | "$NODE_BIN" -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const o=JSON.parse(d);console.log(JSON.stringify((o.data||[]).map(m=>m.id).filter(Boolean)))}catch{console.log('[]')}})" 2>/dev/null || echo '[]')"
  if pgrep -f 'cloudflared tunnel run' >/dev/null 2>&1; then tun='{"running":true}'; else tun='{"running":false}'; fi
  curl -fsS -X POST "${AUTH[@]}" -H 'Content-Type: application/json' \
    -d "{\"upstream\":$up,\"models\":$models_json,\"tunnel\":$tun,\"host\":\"$(hostname)\"}" \
    "$WORKER_URL/api/heartbeat" >/dev/null 2>&1 || true
}
# 清理旧心跳循环（防重复部署后残留双循环写 KV）
if [ -f "$PROXY_DIR/heartbeat.pid" ]; then
  kill "$(cat "$PROXY_DIR/heartbeat.pid" 2>/dev/null)" 2>/dev/null || true
  rm -f "$PROXY_DIR/heartbeat.pid"
fi
while true; do heartbeat; sleep "$HEARTBEAT_INTERVAL"; done &
echo $! > "$PROXY_DIR/heartbeat.pid"
echo
echo '================ 部署完成 ================'
echo "代理:  http://127.0.0.1:$PROXY_PORT/v1"
echo "公网:  ${DOMAIN:+https://$DOMAIN/v1}（隧道连上后生效）"
echo '=========================================='
