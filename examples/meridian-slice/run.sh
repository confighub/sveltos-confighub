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
image() { on "$1" -n kyverno get deploy kyverno-admission-controller -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || echo "-"; }
pdb() { on "$1" -n kyverno get pdb kyverno-admission-controller -o name 2>/dev/null | sed 's|.*/||' || true; }
state() { for c in $CLUSTERS; do printf '  eu-central-%-6s %-40s replicas %s  PodDisruptionBudget %s\n' "$c" "$(image $c)" "$(replicas $c)" "$( [ -n "$(pdb $c)" ] && echo yes || echo no)"; done; }
pods() { for c in $CLUSTERS; do on $c -n kyverno get pods -o jsonpath='{range .items[*]}{.metadata.uid}{"\n"}{end}'; done | sort; }
# Promote each unit's change as one diff (--squash): replaying functions lets
# a root change reach a class's clusters past the class's protection.
# Promoting a large unit can outlast the request; a promotion is idempotent,
# so ask again, and a change order with nothing left to promote has done it.
promote() { local out i; for i in 1 2 3; do out=$(cub variant promote --change-order "$1" --target-stage "$2" --squash --quiet 2>&1 >/dev/null) && return 0; case "$out" in *"nothing left to promote"*) return 0 ;; esac; sleep 15; done; echo "$out" >&2; return 1; }
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
state; pods > "$W/pods-0.txt"

say "1. Onboard: three profiles become one component, with a class base per class"
kubectl get clusterprofiles,sveltosclusters -A -o yaml > my-fleet.yaml
$BIN plan my-fleet.yaml $OPTS || fail "plan"
$BIN apply my-fleet.yaml $OPTS --out onboard > /dev/null || fail "apply"
bash onboard/apply.sh 2>&1 | grep -v "^Upgraded\|^Adding\|^Marked\|^Promoting\|^Created variant\|^Awaiting\|^$\|Bulk create\|Success:" || true
sleep 60
bash onboard/handover.sh || fail "handover"
wait_for '[ "$(kubectl get clustersummaries -A -o json | python3 -c "
import json,sys
print(sum(1 for i in json.load(sys.stdin)[\"items\"] if i[\"metadata\"].get(\"labels\",{}).get(\"projectsveltos.io/cluster-profile-name\",\"\").startswith(\"kyverno-eu-central-\") and i.get(\"status\",{}).get(\"featureSummaries\") and all(f.get(\"status\")==\"Provisioned\" for f in i[\"status\"][\"featureSummaries\"])))")" = 4 ]' || fail "the delivery profiles did not hand over"
sleep 15
state; pods > "$W/pods-1.txt"
diff -q "$W/pods-0.txt" "$W/pods-1.txt" > /dev/null && echo "  every pod is the one that ran before onboarding: nothing was reinstalled" || { echo "  PODS CHANGED"; diff "$W/pods-0.txt" "$W/pods-1.txt"; }
echo "  removing Helm's record of the release, as handover.sh says, leaving its objects:"
for c in $CLUSTERS; do on $c -n kyverno delete secret -l owner=helm,name=kyverno -o name | sed "s|^|    eu-central-$c |"; done
echo "  Meridian's queries work on the result:"
cub space list --where "Component.Slug = 'mer-kyverno' AND Labels.Role = 'base'" 2>/dev/null | awk 'NR>1 {print "    base       " $1}'
cub space list --where "Component.Slug = 'mer-kyverno' AND Labels.Role = 'deployment'" 2>/dev/null | awk 'NR>1 {print "    deployment " $1}'

say "2. One change for every class, at the root: Kyverno 3.8.2, and 4 replicas"
SEL='select(.kind == "Deployment" and .metadata.name == "kyverno-admission-controller")'
grep '^# kyverno is rendered with' onboard/apply.sh | sed 's/^/  the root was /'
cub helm template kyverno kyverno --repo https://kyverno.github.io/kyverno --version 3.8.2 --namespace kyverno --create-namespace -f onboard/kyverno/kyverno.values.yaml > kyverno-3.8.2.yaml 2>/dev/null || fail "render 3.8.2"
cub unit update --space mer-kyverno-base kyverno kyverno-3.8.2.yaml --change-desc "Kyverno 3.8.2" --quiet || fail "root update"
cub function set --space mer-kyverno-base --unit kyverno --change-desc "Admission controller at 4 replicas" --quiet -- set-yq "($SEL | .spec.replicas) = 4" > /dev/null || fail "root edit"
cub changeorder create --space mer-kyverno-base kyverno-3-8-2 --change-workflow mer-kyverno-base/rollout --description "Kyverno 3.8.2, 4 replicas at the root" --quiet || fail "change order"
promote mer-kyverno-base/kyverno-3-8-2 bases || fail "promote bases"
for c in test uat prod; do printf '  class base %-5s %s\n' "$c" "$(cub unit data --space mer-kyverno-class-$c kyverno | yq -N "$SEL | .spec.template.spec.containers[0].image + \"  replicas \" + (.spec.replicas | tostring)")"; done
echo "  EXPECT REFUSAL, promote into uat before test released:"
cub variant promote --change-order mer-kyverno-base/kyverno-3-8-2 --target-stage uat --squash --quiet 2>&1 | grep -v "^Promoting\|^Upgraded\|^Adding\|^Marked" | tail -1 | sed 's/^/    /'
for stage in test uat prod; do
  promote mer-kyverno-base/kyverno-3-8-2 $stage || fail "promote $stage"
  cub variant approve --change-order mer-kyverno-base/kyverno-3-8-2 --stage $stage --quiet || fail "approve $stage"
  for c in $(in_stage $stage); do
    cub release publish mer-kyverno-eu-central-$c --revision ChangeOrder:mer-kyverno-base/kyverno-3-8-2 --quiet || fail "publish $c"
  done
  for c in $(in_stage $stage); do wait_for "[ \"\$(image $c)\" = reg.kyverno.io/kyverno/kyverno:v1.18.2 ]" || fail "$c never upgraded"; done
  sleep 10
  echo "  after $stage:"; state
done
[ "$(replicas test1) $(replicas uat1) $(replicas prod1) $(replicas prod2)" = "4 2 3 3" ] || fail "a class lost its replicas"
echo "  test took the root's 4 replicas; uat and prod kept their classes' 2 and 3"
cub changeorder get --space mer-kyverno-base kyverno-3-8-2 -o jq='.ChangeOrder | {Stage, State}'
say "MERIDIAN-SLICE-DONE"
