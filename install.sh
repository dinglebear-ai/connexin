#!/usr/bin/env bash
set -euo pipefail

readonly PACKAGE="@dinglebear/connexin"
readonly VERSION="${CONNEXIN_VERSION:-latest}"

if ! command -v node >/dev/null 2>&1; then
  echo "connexin requires Node.js 24 or newer" >&2
  exit 1
fi

node_major="$(node --eval 'process.stdout.write(process.versions.node.split(".")[0])')"
if ((node_major < 24)); then
  echo "connexin requires Node.js 24 or newer (found $(node --version))" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "connexin requires npm" >&2
  exit 1
fi

npm install --global "${PACKAGE}@${VERSION}"

echo "Installed ${PACKAGE}@${VERSION}. Run: connexin --help"
