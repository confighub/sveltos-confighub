#!/usr/bin/env bash
# Prints what an agent last said in a run: its approval request or report.
# With --all, every one of its runs' last words in that run, oldest first,
# each under a heading, so a reviewer sees the whole story.
#
#   bash $DEMO/agents/last-request.sh <run-name> [agent] [--all]       (agent defaults to angel)
set -euo pipefail
[ -n "${AI_CHAOS_DIR:-}" ] || . "$(cd "$(dirname "$0")/.." && pwd)/env.sh"
run=${1:?usage: last-request.sh <run-name> [agent] [--all]}; shift
agent=angel all=
for a in "$@"; do case $a in --all) all=--all ;; *) agent=$a ;; esac; done
if [ "$all" = --all ]; then files=$(ls -tr "$CHAOS_RUNS/$run/$agent"-*.jsonl); else files=$(ls -t "$CHAOS_RUNS/$run/$agent"-*.jsonl | head -1); fi
python3 - $files <<'PY'
import json, os, sys
for f in sys.argv[1:]:
    last = ""
    for raw in open(f):
        try:
            ev = json.loads(raw)
        except ValueError:
            continue
        if ev.get("type") == "result" and isinstance(ev.get("result"), str):
            last = ev["result"]
        elif ev.get("type") == "assistant":
            for b in ev.get("message", {}).get("content", []):
                if b.get("type") == "text" and b.get("text", "").strip():
                    last = b["text"]
    if len(sys.argv) > 2:
        print(f"===== {os.path.basename(f)}")
    print(last.strip())
    print()
PY
