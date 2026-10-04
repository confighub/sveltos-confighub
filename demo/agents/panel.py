#!/usr/bin/env python3
"""One agent run as a terminal panel (HTML), for the post's images: the agent's
notes in plain text, each command it ran, and the first lines of what came back.

  panel.py <run.jsonl> [--max-steps N] [--pick REGEX ...] [--keep REGEX ...] [--basenames] [--out file.html]
"""
import argparse, html, json, re

p = argparse.ArgumentParser()
p.add_argument("run")
p.add_argument("--max-steps", type=int, default=12)
p.add_argument("--lines", type=int, default=4, help="output lines kept per command")
p.add_argument("--width", type=int, default=150, help="characters kept per output line")
p.add_argument("--title")
p.add_argument("--explained", action="store_true", help="keep only the steps the agent wrote a note before")
p.add_argument("--pick", action="append", default=[], help="keep only the commands matching one of these regular expressions, in run order")
p.add_argument("--keep", action="append", default=[], help="of each command's output, keep the lines matching one of these regular expressions (the first lines when none match)")
p.add_argument("--basenames", action="store_true", help="show long absolute paths by their last element")
p.add_argument("--out")
a = p.parse_args()

agent = a.run.rsplit("/", 1)[-1].split("-", 1)[0]
colour = {"devil": "#ff6b6b", "angel": "#7cc4ff", "milton": "#e8c15a"}.get(agent, "#cccccc")
steps, last_note = [], None
for raw in open(a.run):
    try:
        ev = json.loads(raw)
    except ValueError:
        continue
    if ev.get("type") == "assistant":
        for b in ev.get("message", {}).get("content", []):
            if b.get("type") == "text" and b.get("text", "").strip():
                last_note = b["text"].strip()
            elif b.get("type") == "tool_use":
                cmd = b.get("input", {}).get("command")
                if not cmd:
                    continue
                steps.append({"note": last_note, "cmd": cmd, "out": None, "id": b.get("id")})
                last_note = None
    elif ev.get("type") == "user":
        for b in ev.get("message", {}).get("content", []):
            if isinstance(b, dict) and b.get("type") == "tool_result":
                c = b.get("content")
                if isinstance(c, list):
                    c = "\n".join(x.get("text", "") for x in c if isinstance(x, dict))
                for s in steps:
                    if s["id"] == b.get("tool_use_id"):
                        s["out"] = str(c or "")
final = last_note

def esc(s):
    return html.escape(s)

def short(s):
    if not a.basenames:
        return s
    return re.sub(r"(?:/[^\s'\"/]+){3,}/([^\s'\"/]+)", r"\1", s)

rows = []
shown = [s for s in steps if s["note"]] if a.explained else steps
if a.pick:
    shown = [s for s in shown if any(re.search(r, s["cmd"]) for r in a.pick)]
for s in shown[: a.max_steps]:
    if s["note"]:
        rows.append(f'<div class="note">{esc(s["note"])}</div>')
    cmd = short(s["cmd"])
    cmd = cmd if len(cmd) < 220 else cmd[:217] + "..."
    rows.append(f'<div class="cmd"><span class="p">$</span> {esc(cmd)}</div>')
    if s["out"]:
        lines = [l for l in s["out"].splitlines() if l.strip()]
        kept = [l for l in lines if any(re.search(r, l) for r in a.keep)]
        lines = (kept or lines)[: a.lines]
        rows.append('<div class="out">' + esc(short("\n".join(l[: a.width] for l in lines))) + "</div>")
if len(steps) > min(a.max_steps, len(shown)):
    rows.append(f'<div class="more">... {len(steps) - min(a.max_steps, len(shown))} more commands in the full transcript</div>')
if final:
    paras = [x for x in final.split("\n\n") if x.strip()]
    first = "\n".join(paras[:2]).replace("**", "").lstrip("# ")
    rows.append(f'<div class="note final">{esc(first[:600])}</div>')
title = a.title or agent.capitalize()
doc = f"""<!doctype html><html><head><meta charset="utf-8"><style>
body{{margin:0;background:#0f1115;font:14px/1.45 Menlo,monospace;color:#d6d6d6}}
.panel{{padding:20px 24px;max-width:1100px}}
.h{{color:{colour};font-weight:700;font-size:16px;margin-bottom:12px}}
.h small{{color:#888;font-weight:400}}
.note{{color:#f0f0f0;font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:15px;margin:14px 0 6px;white-space:pre-wrap}}
.final{{border-left:3px solid {colour};padding-left:10px}}
.cmd{{color:#9be59b;white-space:pre-wrap;word-break:break-all}}
.p{{color:{colour}}}
.out{{color:#9aa0a6;white-space:pre-wrap;margin:2px 0 4px 14px}}
.more{{color:#777;margin-top:10px}}
</style></head><body><div class="panel"><div class="h">{esc(title)} <small>AI generated, as it ran</small></div>
{''.join(rows)}</div></body></html>"""
if a.out:
    open(a.out, "w").write(doc)
else:
    print(doc)
