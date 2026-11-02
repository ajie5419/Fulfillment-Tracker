#!/usr/bin/env bash
# 在 ECS 上执行的发布脚本，由 .github/workflows/deploy.yml 通过 SSH 调用。
# 对应 docs/上线手册.md 5.3：构建 → 迁移 → 启动 → 健康检查；失败回退到 prev 镜像。
#
# 用法（在 /opt/fulfillment 的父目录执行）：scripts/deploy-remote.sh <tag>
set -euo pipefail

TAG="${1:?用法: $0 <tag>，例如 fulfillment-v0.1.0}"
APP_DIR="${APP_DIR:-/opt/fulfillment}"
IMAGE=fulfillment-tracker
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3100/api/health}"

log() { printf '[deploy] %s\n' "$*"; }
fail() { printf '[deploy] 失败: %s\n' "$*" >&2; exit 1; }

cd "$APP_DIR"

log "切换到 $TAG"
git fetch --tags --force origin
git checkout --force "$TAG"
git rev-parse --short HEAD

# 回滚点：取"正在运行"的容器所用的镜像 ID，而不是 latest 标签。
# latest 会被 docker compose build 改成新构建的镜像；若迁移或启动失败，用 latest 当 prev
# 就把失败镜像记成了回滚点，下一次失败就没法回到真正在跑的那一版。
if docker inspect fulfillment >/dev/null 2>&1; then
  RUNNING_IMAGE=$(docker inspect -f '{{.Image}}' fulfillment)
  log "保存回滚镜像 $IMAGE:prev <- ${RUNNING_IMAGE:7:12}（当前运行中）"
  docker tag "$RUNNING_IMAGE" "$IMAGE:prev"
elif docker image inspect "$IMAGE:prev" >/dev/null 2>&1; then
  log "没有运行中的容器，保留已有的 $IMAGE:prev 作为回滚点"
else
  log "没有运行中的容器，也没有 $IMAGE:prev，跳过回滚点（首次上线）"
fi

log "构建镜像"
docker compose build

# 迁移必须在启动新版本前跑完；失败时容器还没切换，直接退出即可
log "执行数据库迁移"
docker compose run --rm --no-deps fulfillment prisma migrate deploy

log "启动"
docker compose up -d

# 健康检查：容器自带 HEALTHCHECK（每 30 秒一次），这里最多等 90 秒
log "等待健康检查"
for i in $(seq 1 18); do
  if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
    log "健康检查通过（约 $((i * 5)) 秒）"
    docker compose ps
    exit 0
  fi
  sleep 5
done
log "健康检查未通过，回退到 prev"
docker compose logs --tail 80 fulfillment || true
if docker image inspect "$IMAGE:prev" >/dev/null 2>&1; then
  docker tag "$IMAGE:prev" "$IMAGE:latest"
  docker compose up -d
  fail "已回退到 $IMAGE:prev，请检查日志"
fi
fail "没有 $IMAGE:prev 可回退，请人工处理（见 docs/上线手册.md 5.6）"
