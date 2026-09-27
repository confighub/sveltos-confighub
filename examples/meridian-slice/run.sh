#!/usr/bin/env bash
# A slice of Meridian delivered by Sveltos. Build the fleet first with
# kind-fleet.mjs, log in with cub, then:
#
#   bash examples/meridian-slice/run.sh
#
# It creates ten Spaces prefixed mer- in your ConfigHub organization and keeps
# them: a root base, three class bases, four deployments, the Targets and the
# management record.
set -uo pipefail
R=$(cd "$(dirname "$0")/../.." && pwd)
W=${MERIDIAN_SLICE_DIR:-${TMPDIR:-/tmp}/sveltos-meridian-slice}
W=${W%/}
BIN=${SVELTOS:-cub sveltos}
U="$W/user"; rm -rf "$U"; mkdir -p "$U"; cd "$U"
export KUBECONFIG="$W/mer-mgmt.kubeconfig" MGMT_CONTEXT=kind-mer-mgmt
OPTS="--class-label class --stage-label class --stages test,uat,prod --prefix mer"
CLUSTERS="test1 uat1 prod1 prod2"
say() { printf '\n##### %s  [%s]\n' "$*" "$(date -u +%H:%M:%S)"; }
fail() { say "FAILED: $*"; exit 1; }
on() { kubectl --kubeconfig "$W/mer-$1.kubeconfig" "${@:2}"; }
chart() { helm --kubeconfig "$W/mer-$1.kubeconfig" list -n kyverno 2>/dev/null | awk 'NR>1 {printf "%s@rev%s ", $9, $3} END {if (NR<2) printf "none"}'; }
replicas() { on "$1" -n kyverno get deploy kyverno-admission-controller -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "-"; }
state() { for c in $CLUSTERS; do printf '  eu-central-%-6s %-22s admission controller replicas %s\n' "$c" "$(chart $c)" "$(replicas $c)"; done; }
wait_for() { for i in $(seq 1 72); do eval "$1" && return 0; sleep 5; done; return 1; }
at_chart() { for c in $1; do chart $c | grep -q "$2" || return 1; done; }
in_stage() { for c in $CLUSTERS; do case $c in "$1"*) printf '%s ' "$c" ;; esac; done; }

say "0. Meridian's eu-central slice today: Kyverno by class, one Sveltos profile per class"
kubectl get sveltosclusters -A --show-labels | cut -c1-160
python3 - "$R/examples/meridian-slice/meridian-slice.yaml" <<'EOF' | kubectl apply -f -
import sys, yaml
docs = [d for d in yaml.safe_load_all(open(sys.argv[1])) if d and d.get("kind") == "ClusterProfile"]
print(yaml.safe_dump_all(docs, sort_keys=False))
EOF
wait_for 'at_chart "$CLUSTERS" kyverno-3.8.1' || fail "Kyverno never reached every cluster"
wait_for '[ "$(replicas prod2)" = 3 ] && [ "$(replicas uat1)" = 2 ]' || fail "the class knobs never applied"
sleep 20
state; state > "$W/state-0.txt"

say "1. Onboard: three profiles become one component with a class base per class"
kubectl get clusterprofiles,sveltosclusters -A -o yaml > my-fleet.yaml
$BIN plan my-fleet.yaml $OPTS || fail "plan"
$BIN apply my-fleet.yaml $OPTS --out onboard > /dev/null || fail "apply"
bash onboard/apply.sh 2>&1 | grep -v "^Upgraded\|^Adding\|^Marked\|^Promoting\|^Created variant" || true
sleep 60
bash onboard/takeover.sh || fail "takeover"
wait_for '[ "$(kubectl get clustersummaries -A -o json | python3 -c "
import json,sys
print(sum(1 for i in json.load(sys.stdin)[\"items\"] if i[\"metadata\"].get(\"labels\",{}).get(\"projectsveltos.io/cluster-profile-name\",\"\").startswith(\"kyverno-eu-central-\") and i.get(\"status\",{}).get(\"featureSummaries\") and all(f.get(\"status\")==\"Provisioned\" for f in i[\"status\"][\"featureSummaries\"])))")" = 4 ]' || fail "the deployments did not take over"
sleep 15
state; state > "$W/state-1.txt"
diff -q "$W/state-0.txt" "$W/state-1.txt" > /dev/null && echo "  every cluster kept its release revision and its class's replicas: nothing reinstalled" || echo "  STATE CHANGED"
echo "  Meridian's queries work on the result:"
cub space list --where "Component.Slug = 'mer-kyverno' AND Labels.Role = 'base'" 2>/dev/null | awk 'NR>1 {print "    base       " $1}'
cub space list --where "Component.Slug = 'mer-kyverno' AND Labels.Role = 'deployment'" 2>/dev/null | awk 'NR>1 {print "    deployment " $1}'

say "2. One change at the root, Kyverno 3.8.1 to 3.8.2, class bases first, then test, uat, prod"
cub unit data --space mer-kyverno-base clusterprofile > base.yaml || fail "read base"
sed -i '' 's/chartVersion: 3.8.1/chartVersion: 3.8.2/' base.yaml
cub unit update --space mer-kyverno-base clusterprofile base.yaml --change-desc "Kyverno 3.8.2" --quiet || fail "base update"
cub changeorder create --space mer-kyverno-base kyverno-3-8-2 --change-workflow mer-kyverno-base/rollout --description "Kyverno 3.8.2 across the classes" --quiet || fail "change order"
cub variant promote --change-order mer-kyverno-base/kyverno-3-8-2 --target-stage bases --quiet > /dev/null || fail "promote bases"
for c in test uat prod; do printf '  class base %-5s %s\n' "$c" "$(cub unit data --space mer-kyverno-class-$c clusterprofile | grep -E 'chartVersion|replicas' | tr -s ' ' | tr '\n' ' ')"; done
echo "  EXPECT REFUSAL, promote into uat before test released:"
cub variant promote --change-order mer-kyverno-base/kyverno-3-8-2 --target-stage uat --quiet 2>&1 | grep -v "^Promoting\|^Upgraded\|^Adding\|^Marked" | tail -1 | sed 's/^/    /'
for stage in test uat prod; do
  cub variant promote --change-order mer-kyverno-base/kyverno-3-8-2 --target-stage $stage --quiet > /dev/null || fail "promote $stage"
  cub variant approve --change-order mer-kyverno-base/kyverno-3-8-2 --stage $stage --quiet || fail "approve $stage"
  for c in $(in_stage $stage); do
    cub release publish mer-kyverno-eu-central-$c --revision ChangeOrder:mer-kyverno-base/kyverno-3-8-2 --quiet || fail "publish $c"
  done
  wait_for "at_chart '$(in_stage $stage)' kyverno-3.8.2" || fail "$stage never upgraded"
  sleep 10
  echo "  after $stage:"; state
done
cub changeorder get --space mer-kyverno-base kyverno-3-8-2 -o jq='.ChangeOrder | {Stage, State}'
say "MERIDIAN-SLICE-DONE"
