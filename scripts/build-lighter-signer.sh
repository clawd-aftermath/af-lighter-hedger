#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
REPO=https://github.com/elliottech/lighter-go
TAG=v1.0.10
GO="${GO_BIN:-/opt/homebrew/bin/go}"
git clone --depth 1 --branch "$TAG" "$REPO" "$WORK/lighter-go"
cd "$WORK/lighter-go"
COMMIT="$(git rev-parse HEAD)"
[[ "$COMMIT" == 9d38261* ]] || { echo "Unexpected $TAG commit: $COMMIT" >&2; exit 1; }
GOOS=js GOARCH=wasm "$GO" build -trimpath -o "$WORK/lighter-signer.wasm" ./wasm/
GOROOT_SIGNER="$("$GO" env GOROOT)"
GLUE="$GOROOT_SIGNER/lib/wasm/wasm_exec.js"
[[ -f "$GLUE" ]] || GLUE="$GOROOT_SIGNER/misc/wasm/wasm_exec.js"
DEST="$ROOT/vendor/lighter-signer"
mkdir -p "$DEST"
cp "$WORK/lighter-signer.wasm" "$DEST/lighter-signer.wasm"
cp "$GLUE" "$DEST/wasm_exec.js"
cp LICENSE "$DEST/LICENSE"
# Preserve notices of packages actually linked into the binary, including
# nested package licenses. Paths in the bundle are module-relative, not local.
MODCACHE_SIGNER="$("$GO" env GOMODCACHE)"
GO_LICENSE="$GOROOT_SIGNER/LICENSE"
[[ -f "$GO_LICENSE" ]] || GO_LICENSE="$GOROOT_SIGNER/../LICENSE"
cp "$GO_LICENSE" "$DEST/THIRD-PARTY-NOTICES.txt"
GOOS=js GOARCH=wasm "$GO" list -deps -f '{{if .Module}}{{.Dir}}{{end}}' ./wasm/ > "$WORK/packages.txt"
while IFS= read -r PACKAGE_DIR; do
  [[ "$PACKAGE_DIR" == "$MODCACHE_SIGNER/"* ]] || continue
  CURRENT_DIR="$PACKAGE_DIR"
  while [[ "$CURRENT_DIR" == "$MODCACHE_SIGNER/"* ]]; do
    for LICENSE_PATH in "$CURRENT_DIR"/LICENSE* "$CURRENT_DIR"/COPYING* "$CURRENT_DIR"/NOTICE*; do
      [[ ! -f "$LICENSE_PATH" ]] || echo "$LICENSE_PATH"
    done
    CURRENT_DIR="$(dirname "$CURRENT_DIR")"
  done
done < "$WORK/packages.txt" | sort -u > "$WORK/notices.txt"
while IFS= read -r NOTICE_PATH; do
  printf '\n\n===== %s =====\n\n' "${NOTICE_PATH#"$MODCACHE_SIGNER/"}" >> "$DEST/THIRD-PARTY-NOTICES.txt"
  cat "$NOTICE_PATH" >> "$DEST/THIRD-PARTY-NOTICES.txt"
done < "$WORK/notices.txt"
GO_VERSION="$("$GO" version)"
WASM_SHA="$(shasum -a 256 "$DEST/lighter-signer.wasm" | cut -d ' ' -f 1)"
EXEC_SHA="$(shasum -a 256 "$DEST/wasm_exec.js" | cut -d ' ' -f 1)"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > "$DEST/BUILD-INFO.json" <<EOF
{
  "repo": "$REPO",
  "tag": "$TAG",
  "commit": "$COMMIT",
  "goVersion": "$GO_VERSION",
  "wasmSha256": "$WASM_SHA",
  "wasmExecSha256": "$EXEC_SHA",
  "builtAt": "$BUILT_AT"
}
EOF
echo "Built $TAG ($COMMIT) with $GO_VERSION"
