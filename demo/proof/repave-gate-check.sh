#!/usr/bin/env bash
# Checks outage 3's prevention, the repave gate, without any AI agent, in about
# a minute and for nothing. It works in a Space of its own, chaos-repave-check,
# on a copy of the shop's unit from chaos-shop-staging, so the demo's Spaces are
# not touched, and teardown.sh --confighub removes it. As you:
#   1. the gate, as setup/repave-gate.sh puts it on, with the shop's restore
#      list: its code, held by the release, and its token, made by a Job;
#   2. the shop as stand-up made it, its token made by hand: refused, since
#      nothing in the release makes the token;
#   3. with the Job that makes it (proof/shop-token-maker.yaml): passes;
#   4. web also reading a ConfigMap made by hand: refused, naming it;
#   5. the gate off: the refusal is gone.
# It ends by saying whether each expectation held, and exits non-zero if one
# did not.
#
#   source demo/env.sh && bash $DEMO/proof/repave-gate-check.sh
set -uo pipefail
[ -n "${AI_CHAOS_DIR:-}" ] && [ -n "${CHAOS_RUNS:-}" ] && [ -n "${DEMO:-}" ] || . "$(cd "$(dirname "$0")/.." && pwd)/env.sh"
space=chaos-repave-check
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
failed=0
expect() { # expect <what> <text> <pattern>: report whether the text shows it
  if printf '%s' "$2" | grep -Eq "$3"; then echo "  ok      $1"; else echo "  NOT MET $1"; failed=1; fi
}
# verdict: the unit's validation once ConfigHub has run its triggers on it.
verdict() {
  local out i
  for i in $(seq 1 15); do
    out=$(cub unit get --space "$space" shop -o json | python3 -c '
import json, sys
u = json.load(sys.stdin); u = u.get("Unit", u)
gates = u.get("ApplyGates") or {}
if any("awaiting" in g for g in gates):
    print("awaiting"); sys.exit()
errors = sorted((u.get("ValidationErrors") or {}).keys())
print("errors: " + (", ".join(e.split("/")[1] for e in errors) or "none"))
for results in (u.get("ValidationResults") or {}).values():
    for r in results:
        for d in r.get("Details") or []:
            print("  " + d)')
    [ "$out" = awaiting ] || { echo "$out"; return; }
    sleep 2
  done
  echo "$out"
}
update() { cub unit update --space "$space" shop "$1" --change-desc "$2" --quiet; }

echo "== 1. the gate, on $space"
# The gate goes on first: ConfigHub runs triggers when a unit changes.
cub space create "$space" --label Purpose=ai-chaos --allow-exists --quiet
bash "$DEMO/setup/repave-gate.sh" --space "$space" ConfigMap/shop-code Secret/shop-token | sed 's/^/  /'

echo "== 2. the shop as stand-up made it, its token made by hand"
cub unit data --space chaos-shop-staging shop > "$work/shop.yaml"
if cub unit get --space "$space" shop >/dev/null 2>&1; then
  update "$work/shop.yaml" "repave gate check: the shop as stand-up made it"
else
  cub unit create --space "$space" shop "$work/shop.yaml" --quiet
fi
out=$(verdict); echo "$out"
expect "refused: nothing in the release makes the token" "$out" "errors: .*restores-secret-shop-token"

echo "== 3. with the Job that makes the token"
{ cat "$work/shop.yaml"; echo "---"; grep -v '^#' "$DEMO/proof/shop-token-maker.yaml"; } > "$work/shop-maker.yaml"
update "$work/shop-maker.yaml" "repave gate check: the Job that makes the token"
out=$(verdict); echo "$out"
expect "passes" "$out" "^errors: none"

echo "== 4. web also reads a ConfigMap made by hand"
python3 - "$work/shop-maker.yaml" "$work/shop-flags.yaml" <<'PY'
import sys, yaml
docs = [d for d in yaml.safe_load_all(open(sys.argv[1])) if d]
for d in docs:
    if d.get("kind") == "Deployment" and d["metadata"]["name"] == "web":
        d["spec"]["template"]["spec"]["containers"][0].setdefault("envFrom", []).append({"configMapRef": {"name": "feature-flags"}})
yaml.safe_dump_all(docs, open(sys.argv[2], "w"), sort_keys=False)
PY
update "$work/shop-flags.yaml" "repave gate check: web reads feature-flags"
out=$(verdict); echo "$out"
expect "refused, naming the ConfigMap" "$out" "web uses ConfigMap/feature-flags, which is not on the restore list"

echo "== 5. the gate off"
bash "$DEMO/setup/repave-gate.sh" --space "$space" --off | sed 's/^/  /'
update "$work/shop-maker.yaml" "repave gate check: back to the Job"
out=$(verdict); echo "$out"
expect "nothing refused" "$out" "^errors: none"

echo
if [ "$failed" = 0 ]; then echo "The repave gate works."; else echo "An expectation was not met: read the output above."; exit 1; fi
