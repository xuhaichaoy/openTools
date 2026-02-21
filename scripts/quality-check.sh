#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"
echo "[quality] pnpm build"
pnpm build

echo "[quality] pnpm test"
pnpm test

echo "[quality] pnpm lint"
pnpm lint

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
