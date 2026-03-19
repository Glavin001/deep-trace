#!/usr/bin/env bash
#
# setup-app.sh — Clone vercel/next.js at a pinned SHA (sparse checkout) and extract examples.
#
# Usage: bash setup-app.sh <deep-trace-root> <work-dir>
#
# Reads pinned-versions.json for the repo URL, SHA, and example list.
# Clones once, extracts all examples to <work-dir>/<example-name>/.
#
set -euo pipefail

DEEP_TRACE_ROOT="${1:?Usage: setup-app.sh <deep-trace-root> <work-dir>}"
WORK_DIR="${2:?Usage: setup-app.sh <deep-trace-root> <work-dir>}"

PINNED_VERSIONS="$DEEP_TRACE_ROOT/tests/e2e-realworld/pinned-versions.json"

# Parse pinned-versions.json
REPO_URL=$(node -e "console.log(require('$PINNED_VERSIONS').repo)")
PINNED_SHA=$(node -e "console.log(require('$PINNED_VERSIONS').sha)")
EXAMPLES_JSON=$(node -e "console.log(JSON.stringify(require('$PINNED_VERSIONS').examples))")
EXAMPLES=$(node -e "require('$PINNED_VERSIONS').examples.forEach(e => console.log(e))")

CLONE_DIR="$WORK_DIR/.nextjs-repo"

echo "==> Cloning $REPO_URL at $PINNED_SHA (sparse checkout)..."
mkdir -p "$CLONE_DIR"

if [ ! -d "$CLONE_DIR/.git" ]; then
  git clone --depth 1 --filter=blob:none --sparse --no-checkout \
    "$REPO_URL" "$CLONE_DIR"
fi

cd "$CLONE_DIR"
git fetch --depth 1 origin "$PINNED_SHA"
git checkout "$PINNED_SHA" 2>/dev/null || git checkout FETCH_HEAD

# Set up sparse checkout for all examples
SPARSE_PATHS=""
for example in $EXAMPLES; do
  SPARSE_PATHS="$SPARSE_PATHS examples/$example"
done
git sparse-checkout set $SPARSE_PATHS

echo "==> Extracting examples to $WORK_DIR..."
for example in $EXAMPLES; do
  TARGET="$WORK_DIR/$example"
  if [ -d "$TARGET" ]; then
    echo "    $example already extracted, skipping"
    continue
  fi
  if [ -d "$CLONE_DIR/examples/$example" ]; then
    cp -r "$CLONE_DIR/examples/$example" "$TARGET"
    echo "    Extracted $example"
  else
    echo "    WARNING: examples/$example not found in repo at SHA $PINNED_SHA"
  fi
done

echo "==> Setup complete. Examples in $WORK_DIR:"
ls -d "$WORK_DIR"/*/ 2>/dev/null | while read d; do basename "$d"; done
