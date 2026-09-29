#!/usr/bin/env bash
# Asks an assistant to explain what `cub sveltos impact` found, for the person
# who reviews the change. It reads the results and, with read-only cub
# commands, ConfigHub's history. The verdicts are not its to make, and it
# approves nothing.
#
#   cub sveltos impact ... --json > results.json
#   bash examples/meridian-slice/explain/explain.sh results.json
#
# It uses Claude Code in print mode (claude -p), with cub logged in.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
results=${1:?usage: explain.sh <results.json>}

prompt="$(cat "$here/prompt.md")

The results, as JSON:

$(cat "$results")"

claude -p "$prompt" \
  --allowedTools "Bash(cub unit get:*)" "Bash(cub unit data:*)" "Bash(cub unit diff:*)" \
    "Bash(cub unit list:*)" "Bash(cub revision list:*)" "Bash(cub revision data:*)" \
    "Bash(cub space list:*)" "Bash(cub space get:*)" "Bash(cub changeorder get:*)" \
  --disallowedTools Edit Write NotebookEdit WebFetch WebSearch
