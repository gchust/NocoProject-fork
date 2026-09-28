#!/usr/bin/env bash
# 每次 `pnpm build` 都执行（cli/nocoproject-build.ts 声明的 afterClientBuild 钩子）：把同级目录的 nocoproject-cli 打包到
# dist/client/assets/cli/，应用在 <服务器>/assets/cli/nocoproject-cli-<版本>.tgz 提供下载，“添加电脑”页面的安装命令指向这里。
# 应用只对 /assets/* 提供静态文件，且按一年 immutable 缓存，所以文件名带版本号：版本取 client/pages/np/constants.ts 的
# CLI_VERSION，与 CLI 的 package.json 不一致时失败。任何一步失败都让构建失败，构建产物里不会缺安装包。
set -euo pipefail
cd "$(dirname "$0")/.."

CLI_DIR=../nocoproject-cli
DEST=dist/client/assets/cli
test -f "$CLI_DIR/package.json" || { echo "$CLI_DIR is missing: the application build packs the CLI from it" >&2; exit 1; }
test -d dist/client/assets || { echo "dist/client/assets is missing: run this after the client build" >&2; exit 1; }

VERSION="$(node -p "require('$CLI_DIR/package.json').version")"
EXPECTED="$(sed -nE "s/^export const CLI_VERSION = '([^']+)';/\1/p" client/pages/np/constants.ts)"
if [ "$VERSION" != "$EXPECTED" ]; then
  echo "nocoproject-cli is $VERSION but CLI_VERSION in client/pages/np/constants.ts is '${EXPECTED}'" >&2
  exit 1
fi

rm -rf "$DEST"
mkdir -p "$DEST"
(cd "$CLI_DIR" && pnpm install --frozen-lockfile --silent && pnpm pack --pack-destination "$OLDPWD/$DEST" >/dev/null)
test -f "$DEST/nocoproject-cli-$VERSION.tgz"
echo "packed $DEST/nocoproject-cli-$VERSION.tgz"
