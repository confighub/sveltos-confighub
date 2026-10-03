#!/usr/bin/env python3
"""Renders one agent run (Claude Code stream-json) as a readable transcript:
the agent's notes, each command it ran, and what came back."""
import json, sys

MAX = 40  # lines of a command's output kept in the transcript

def clip(text):
    lines = text.rstrip("\n").split("\n")
    if len(lines) <= MAX:
        return "\n".join(lines)
    return "\n".join(lines[:MAX] + [f"... ({len(lines) - MAX} more lines)"])

path = sys.argv[1]
agent = path.rsplit("/", 1)[-1].split("-", 1)[0].capitalize()
out = [f"# {agent}: one run", "", "> **AI generated.** Everything below the line is what the agent wrote and ran, as it happened.", "", "---", ""]
pending = {}
for raw in open(path):
    raw = raw.strip()
    if not raw:
        continue
    try:
        ev = json.loads(raw)
    except ValueError:
        continue
    kind = ev.get("type")
    if kind == "assistant":
        for block in ev.get("message", {}).get("content", []):
            if block.get("type") == "text" and block.get("text", "").strip():
                out += [block["text"].strip(), ""]
            elif block.get("type") == "tool_use":
                inp = block.get("input", {})
                cmd = inp.get("command") or inp.get("file_path") or json.dumps(inp)
                pending[block.get("id")] = cmd
                out += ["```bash", f"$ {cmd}", "```", ""]
    elif kind == "user":
        for block in ev.get("message", {}).get("content", []):
            if isinstance(block, dict) and block.get("type") == "tool_result":
                content = block.get("content")
                if isinstance(content, list):
                    content = "\n".join(c.get("text", "") for c in content if isinstance(c, dict))
                text = clip(str(content or "").strip())
                if text:
                    out += ["```text", text, "```", ""]
    elif kind == "result":
        cost = ev.get("total_cost_usd")
        out += ["---", "", f"Turns: {ev.get('num_turns')}. Duration: {round((ev.get('duration_ms') or 0) / 1000)} s."
                + (f" Cost: ${cost:.2f}." if isinstance(cost, (int, float)) else ""), ""]
print("\n".join(out))
