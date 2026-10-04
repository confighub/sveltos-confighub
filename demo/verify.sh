#!/usr/bin/env bash
# Checks the demo kit itself, offline, without touching a cluster or ConfigHub:
#   - every shell, Node and Python script parses;
#   - every prompt file is used by a step (its scenario, or approve.sh for Milton's);
#   - every ${VARIABLE} a prompt names is explained where the prompt is used;
#   - every relative link and image in the demo's Markdown resolves.
#
#   bash demo/verify.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
cd "$here"
fail=0
bad() { echo "  FAIL $*"; fail=1; }

echo "== scripts parse"
for f in *.sh setup/*.sh agents/*.sh proof/*.sh; do bash -n "$f" || bad "$f"; done
for f in setup/*.mjs; do node --check "$f" || bad "$f"; done
for f in agents/*.py; do python3 -c 'import ast, sys; ast.parse(open(sys.argv[1]).read())' "$f" || bad "$f"; done

echo "== every prompt is used, and its variables explained"
for p in $(find prompts -type f -name '*.txt' | sort); do
  name=$(basename "$p")
  case $p in
    prompts/milton-review.txt) where="approve.sh" ;;
    *) d=$(basename "$(dirname "$p")"); where="scenarios/$d.md" ;;
  esac
  [ -f "$where" ] || { bad "$p: no $where"; continue; }
  grep -q -F "$name" "$where" || bad "$p is not used in $where"
  for v in $(grep -o '\${[A-Z_][A-Z0-9_]*}' "$p" | tr -d '${}' | sort -u); do
    case $v in AI_CHAOS_DIR|DEMO) continue ;; esac
    grep -q "$v" "$where" || bad "$p: \${$v} is not explained in $where"
  done
done

echo "== links in the demo's Markdown resolve"
for f in $(find . -name '*.md' -not -path './recording/runs/*' | sort); do
  dir=$(dirname "$f")
  for link in $(grep -o '](\([^)#: ]*\)' "$f" | sed 's/^](//' | sort -u); do
    case $link in http*|mailto*|"") continue ;; esac
    [ -e "$dir/$link" ] || bad "$f links to $link, which is not there"
  done
done

if [ "$fail" = 0 ]; then echo "all checks pass"; else exit 1; fi
