#!/usr/bin/env python3
"""One outage as a timeline (HTML), for the post: who did what, when, from a
TSV of time, who, what, source. Gaps of more than ten minutes are marked, so a
wait for a person shows as a wait.

  timeline.py <timeline.tsv> --title "..." [--out file.html]
"""
import argparse, html

p = argparse.ArgumentParser()
p.add_argument("tsv")
p.add_argument("--title", default="")
p.add_argument("--out")
a = p.parse_args()

colour = {"devil": "#e5484d", "angel": "#3e8ed0", "approver": "#c99a06", "sveltos": "#2f9e44", "fleet": "#6b7280", "confighub": "#7c5cc4", "review": "#0f766e"}
label = {"devil": "Devil", "angel": "Angel", "approver": "Approver", "sveltos": "Sveltos", "fleet": "Fleet", "confighub": "ConfigHub", "review": "Review"}

def minutes(t):
    h, m, *s = (int(x) for x in t.split(":"))
    return h * 60 + m + (s[0] if s else 0) / 60

rows, prev = [], None
for line in open(a.tsv):
    if not line.strip() or line.startswith("#"):
        continue
    t, who, what = line.rstrip("\n").split("\t")[:3]
    if prev is not None and minutes(t) - prev > 10:
        gap = round(minutes(t) - prev)
        rows.append(f'<div class="gap">{gap // 60} h {gap % 60} min later</div>' if gap >= 60 else f'<div class="gap">{gap} min later</div>')
    prev = minutes(t)
    c = colour.get(who, "#888")
    rows.append(f'<div class="row"><div class="t">{html.escape(t)}</div><div class="dot" style="background:{c}"></div>'
                f'<div class="w" style="color:{c}">{html.escape(label.get(who, who))}</div><div class="x">{html.escape(what)}</div></div>')

doc = f"""<!doctype html><html><head><meta charset="utf-8"><style>
body{{margin:0;background:#fff;font:15px/1.4 -apple-system,Helvetica,Arial,sans-serif;color:#1f2328}}
.panel{{padding:22px 26px;max-width:980px}}
h1{{font-size:19px;margin:0 0 4px}}
.sub{{color:#6b7280;font-size:13px;margin-bottom:14px}}
.row{{display:grid;grid-template-columns:78px 14px 92px 1fr;align-items:baseline;gap:8px;padding:5px 0;border-left:2px solid #e5e7eb;margin-left:96px;padding-left:0;position:relative}}
.row .t{{position:absolute;left:-96px;width:84px;text-align:right;font:13px Menlo,monospace;color:#374151}}
.row .dot{{width:11px;height:11px;border-radius:50%;margin-left:-7px;align-self:center}}
.row .w{{font-weight:600;grid-column:3}}
.row .x{{grid-column:4}}
.row{{grid-template-columns:14px 92px 1fr}}
.row .w{{grid-column:2}} .row .x{{grid-column:3}}
.gap{{margin-left:96px;border-left:2px dashed #d1d5db;padding:6px 0 6px 16px;color:#9ca3af;font-size:13px;font-style:italic}}
</style></head><body><div class="panel"><h1>{html.escape(a.title)}</h1>
<div class="sub">Times UTC, 2026-10-03. Recorded on kind clusters standing in for production. Every row has a source in the run's evidence.</div>
{''.join(rows)}</div></body></html>"""
if a.out:
    open(a.out, "w").write(doc)
else:
    print(doc)
