#!/usr/bin/env bash
# Runs on every `pnpm build` (the afterClientBuild hook declared by cli/nocoproject-build.ts): packs the sibling
# nocoproject-cli directory into dist/client/assets/cli/. The app serves it for download at
# <server>/assets/cli/nocoproject-cli-<version>.tgz, and the "add a computer" page's install command points there.
# The app only serves static files under /assets/* and caches them immutably for a year, so the filename carries
# the version: the version comes from CLI_VERSION in client/pages/np/constants.ts, and this fails if it doesn't
# match the CLI's package.json. Any step failing fails the build, so the build output never ends up missing the installer.
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
