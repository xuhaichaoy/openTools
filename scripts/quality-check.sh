#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"
echo "[quality] npm run build"
npm run build

echo "[quality] npm run test"
npm run test

echo "[quality] cargo test (mtools-server)"
(
  cd mtools-server
  cargo test
)

echo "[quality] cargo test (src-tauri)"
(
  cd src-tauri
  cargo test
)

echo "[quality] all checks passed"
