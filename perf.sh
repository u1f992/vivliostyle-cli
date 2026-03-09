#!/bin/bash
#
# Performance comparison: eliminate-jsdom branch vs main branch
#
# Prerequisites:
#   - Both branches must have been built with `pnpm exec tsup`
#   - A git worktree for main must exist (or adjust MAIN_DIR below)
#
# Usage:
#   ./perf.sh [runs]
#
# Default: 10 runs per branch

set -e

RUNS="${1:-10}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MAIN_DIR="${MAIN_DIR:-$(dirname "$SCRIPT_DIR")/vivliostyle-cli-main}"

EXAMPLES=(
  asciidoc-processor
  cmyk
  customize-generated-content
  customize-processor
  local-theme
  multiple-input-and-output
  single-html
  single-markdown
  table-of-contents
  theme-css
  theme-preset
  ts-config
  workspace-directory
)

build_all() {
  local cli_dir="$1"
  local cli="$cli_dir/dist/cli.js"
  if [ ! -f "$cli" ]; then
    echo "CLI not found: $cli" >&2
    return 1
  fi
  for example in "${EXAMPLES[@]}"; do
    local dir="$cli_dir/examples/$example"
    if [ ! -d "$dir" ]; then
      echo "SKIP: $example" >&2
      continue
    fi
    cd "$dir"
    node "$cli" build >/dev/null 2>&1 || echo "FAIL: $example" >&2
  done
}

echo "=== Performance benchmark: examples full PDF build ==="
echo "Runs per branch: $RUNS"
echo "Examples: ${#EXAMPLES[@]} projects"
echo ""

echo "--- eliminate-jsdom branch ---"
for i in $(seq 1 "$RUNS"); do
  { time build_all "$SCRIPT_DIR"; } 2>&1 | grep "^real"
done

echo ""
echo "--- main branch ---"
for i in $(seq 1 "$RUNS"); do
  { time build_all "$MAIN_DIR"; } 2>&1 | grep "^real"
done
