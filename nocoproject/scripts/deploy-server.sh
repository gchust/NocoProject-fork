#!/usr/bin/env bash
# 从开发机手动把当前检出部署到 ali-agents 服务器（https://project.nocobase.cn/main）。说明见 docs/deploy.md。
# 平时由 CI 在 main 通过后自动部署（.github/workflows/ci.yml 的 deploy 作业）；这个脚本用于同步服务器脚本和应急发布。
#
#   pnpm deploy:server                          # 构建、上传、部署
#   NP_DEPLOY_SKIP_BUILD=1 pnpm deploy:server   # 复用已有的 linux-x64 dist/
#   NP_DEPLOY_SCRIPTS_ONLY=1 pnpm deploy:server # 只同步服务器脚本与 systemd 单元
set -euo pipefail

HOST="${NP_DEPLOY_HOST:-ali-agents-ts}"
cd "$(dirname "$0")/.."

echo "==> sync server scripts"
rsync -a --delete --exclude systemd scripts/server/ "$HOST:nocoproject/bin/"
rsync -a scripts/server/systemd/ "$HOST:.config/systemd/user/"
ssh "$HOST" 'systemctl --user daemon-reload && systemctl --user enable --now nocoproject-backup.timer >/dev/null 2>&1'
[ "${NP_DEPLOY_SCRIPTS_ONLY:-0}" = 1 ] && exit 0

TAG="$(git rev-parse --short HEAD)"
if [ -n "$(git status --porcelain -- . ':!output' ':!test-results')" ]; then
  TAG="${TAG}-dirty"
  echo "warning: working tree has uncommitted changes; deploying as ${TAG}" >&2
fi

if [ "${NP_DEPLOY_SKIP_BUILD:-0}" != 1 ]; then
  APP_BASE_PATH=/main pnpm build --target linux-x64 --node-version 24
fi
node -e '
const t = require("./dist/package.json").nocobase?.buildTarget ?? {};
if (t.platform !== "linux" || t.arch !== "x64" || t.nodeMajor !== 24) {
  console.error(`dist/ is built for ${JSON.stringify(t)}; run without NP_DEPLOY_SKIP_BUILD`);
  process.exit(1);
}'

echo "==> upload dist ($TAG)"
rsync -a --delete --exclude .env dist Dockerfile Dockerfile.dockerignore config.example.yml "$HOST:nocoproject/build/"
ssh "$HOST" "NP_DEPLOY_REBUILD=1 ~/nocoproject/bin/np-deploy '$TAG'"
