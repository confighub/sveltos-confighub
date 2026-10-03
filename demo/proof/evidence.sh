#!/usr/bin/env bash
# Prints what ConfigHub recorded for the demo, read from ConfigHub itself:
# the gates on each workflow, every change order and how it ended, every
# approval and check with who recorded it and why, and every release with who
# published it. The same record the recording's evidence*.txt files hold.
#
#   bash $DEMO/proof/evidence.sh [since]      e.g. since=2026-10-03T16:00 (default: everything)
set -euo pipefail
since=${1:-1970-01-01}
python3 - "$since" <<'PY'
import json, subprocess, sys
since = sys.argv[1]
def cub(*args):
    out = subprocess.run(["cub", *args, "-o", "json"], capture_output=True, text=True)
    if out.returncode != 0:
        return []
    data = json.loads(out.stdout or "[]")
    return data if isinstance(data, list) else [data]
def ent(x, key):
    return x.get(key, x) if isinstance(x, dict) else x
users = {}
for u in cub("user", "list"):
    u = ent(u, "User")
    name = u.get("Username") or u.get("DisplayName")
    if str(u.get("ExternalID", "")).startswith("confighub:worker"):
        name = (u.get("DisplayName") or name)
    users[u.get("UserID")] = name
who = lambda i: users.get(i, i or "-")
spaces = sorted(ent(s, "Space")["Slug"] for s in cub("space", "list", "--where", "Slug LIKE 'chaos-%'"))
orders = {}
for base in ("chaos-shop-base", "chaos-platform-base", "chaos-management"):
    for o in cub("changeorder", "list", "--space", base):
        o = ent(o, "ChangeOrder")
        orders[o["ChangeOrderID"]] = f"{base}/{o['Slug']}"

print("## Gates")
for base, wf in (("chaos-shop-base", "rollout"), ("chaos-platform-base", "rollout"), ("chaos-management", "record")):
    w = cub("changeworkflow", "get", wf, "--space", base)
    if not w:
        continue
    w = ent(w[0], "ChangeWorkflow")
    for p in w.get("AttestationPrerequisites") or []:
        print(f"  {base}/{wf}: {p['Name']} = {p.get('Count', 1)} {p['Type']} from {', '.join(who(i) for i in p.get('FromUserIDs') or []) or 'anyone'}; authors counted: {p.get('AllowAuthors', False)}")
    for s in w.get("Stages") or []:
        print(f"  {base}/{wf}: stage {s['Name']} releases need {', '.join(s.get('ReleasePrerequisites') or []) or 'nothing'}")

print("\n## Change orders, and how each ended")
for base in ("chaos-shop-base", "chaos-platform-base", "chaos-management"):
    for o in sorted((ent(o, "ChangeOrder") for o in cub("changeorder", "list", "--space", base)), key=lambda o: o["CreatedAt"]):
        if o["CreatedAt"] < since:
            continue
        print(f"  {o['CreatedAt'][:19]}  {base}/{o['Slug']}  {o['State']}")
        if o.get("AbortedReason"):
            print(f"      aborted: {o['AbortedReason']}")

print("\n## Approvals and checks: who recorded each, and why")
att = []
for s in spaces:
    att += [ent(a, "Attestation") for a in cub("attestation", "list", "--space", s)]
for a in sorted(att, key=lambda a: (a["CreatedAt"], a.get("SpaceSlug", ""))):
    if a["CreatedAt"] < since:
        continue
    print(f"  {a['CreatedAt'][:19]}  {a.get('SpaceSlug', '')}  {a['Type']} {a.get('Result', '')} by {who(a.get('UserID'))} on {orders.get(a.get('ChangeOrderID'), '-')}")
    if a.get("Note"):
        print(f"      note: {a['Note']}")

print("\n## Releases: who published each")
rel = []
for s in spaces:
    rel += [ent(r, "Release") for r in cub("release", "list", "--space", s)]
for r in sorted(rel, key=lambda r: (r["CreatedAt"], r.get("SpaceSlug", ""))):
    if r["CreatedAt"] < since or not r.get("Published"):
        continue
    print(f"  {r['CreatedAt'][:19]}  {r.get('SpaceSlug', '')}  release {r.get('ReleaseNum')} by {who(r.get('UserID'))} for {orders.get(r.get('ChangeOrderID') or '', 'no change order')}")
PY
