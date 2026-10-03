#!/usr/bin/env bash
# Prints the last thing an agent said in a run: its approval request or report.
#
#   bash $DEMO/agents/last-request.sh <run-name> [agent]       (agent defaults to angel)
set -euo pipefail
[ -n "${AI_CHAOS_DIR:-}" ] || . "$(cd "$(dirname "$0")/.." && pwd)/env.sh"
run=$1 agent=${2:-angel}
f=$(ls -t "${CHAOS_RUNS:?source demo/env.sh first}/$run/$agent"-*.jsonl | head -1)
python3 - "$f" <<'PY'
import json, sys
last = ""
for raw in open(sys.argv[1]):
    ev = json.loads(raw)
    if ev.get("type") == "result" and isinstance(ev.get("result"), str):
        last = ev["result"]
    elif ev.get("type") == "assistant":
        for b in ev.get("message", {}).get("content", []):
            if b.get("type") == "text" and b.get("text", "").strip():
                last = b["text"]
print(last.strip())
PY
