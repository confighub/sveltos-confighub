#!/usr/bin/env python3
"""Renders one agent run (Claude Code stream-json) as a readable transcript:
the agent's notes, each command it ran, each file it wrote, edited or read, and
what came back.

  python3 render.py <run.jsonl> > run.md"""
import json, sys

MAX = 40  # lines of a command's output kept in the transcript

def clip(text):
    lines = text.rstrip("\n").split("\n")
    if len(lines) <= MAX:
        return "\n".join(lines)
    return "\n".join(lines[:MAX] + [f"... ({len(lines) - MAX} more lines)"])

FILE_LINES = 20  # lines of a written file, or of each side of an edit, kept

def fence(path):
    ext = path.rsplit(".", 1)[-1].lower() if "." in path else ""
    return {"yaml": "yaml", "yml": "yaml", "sh": "bash", "json": "json", "py": "python"}.get(ext, "text")

def cut(text, n):
    lines = str(text).rstrip("\n").split("\n")
    return lines if len(lines) <= n else lines[:n] + [f"... ({len(lines) - n} more lines)"]

def tool_call(name, inp):
    """One tool call, labelled by what it does: a shell command is shown as one,
    a file the agent wrote, edited or read is named as such."""
    if name in ("Bash", None) and inp.get("command"):
        return ["```bash", f"$ {inp['command']}", "```", ""]
    if name == "Monitor" and inp.get("command"):
        return ["**Watches** the output of, in the background:", "", "```bash", f"$ {inp['command']}", "```", ""]
    if name == "Write":
        path = inp.get("file_path", "")
        return [f"**Writes** `{path}`:", "", f"```{fence(path)}", *cut(inp.get("content", ""), FILE_LINES), "```", ""]
    if name == "Edit":
        path = inp.get("file_path", "")
        old = ["- " + l for l in cut(inp.get("old_string", ""), FILE_LINES)]
        new = ["+ " + l for l in cut(inp.get("new_string", ""), FILE_LINES)]
        return [f"**Edits** `{path}`:", "", "```diff", *old, *new, "```", ""]
    if name == "Read":
        return [f"**Reads** `{inp.get('file_path', '')}`", ""]
    if name == "ToolSearch":
        return [f"**Looks up its tools:** `{inp.get('query', '')}`", ""]
    return [f"**{name}:** `{json.dumps(inp)}`", ""]

path = sys.argv[1]
agent = path.rsplit("/", 1)[-1].split("-", 1)[0].capitalize()
out = [f"# {agent}: one run", "", "> **AI generated.** Everything below the line is what the agent wrote and ran, as it happened.", "", "---", ""]
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
                out += tool_call(block.get("name"), block.get("input", {}))
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
