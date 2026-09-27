#!/usr/bin/env bash
# Chapter seven on kind: NVIDIA's GPU operator on exactly the clusters approved
# for it. Build the fleet first with kind-fleet.mjs, log in with cub, then:
#
#   bash examples/gpu-operator/run.sh
#
# It creates five Spaces prefixed ch7- in your ConfigHub organization and keeps
# them. kind nodes have no GPUs: the operator runs and reconciles, and creates
# no GPU daemonsets, so no driver installs.
set -uo pipefail
R=$(cd "$(dirname "$0")/../.." && pwd)
W=${GPU_CHAPTER_DIR:-${TMPDIR:-/tmp}/sveltos-gpu-chapter}
W=${W%/}
BIN=${SVELTOS:-cub sveltos}
U="$W/user"; rm -rf "$U"; mkdir -p "$U"; cd "$U"
export KUBECONFIG="$W/ch7-mgmt.kubeconfig" MGMT_CONTEXT=kind-ch7-mgmt
OPTS="--stage-label env --stages staging,prod --prefix ch7"
say() { printf '\n##### %s  [%s]\n' "$*" "$(date -u +%H:%M:%S)"; }
fail() { say "FAILED: $*"; exit 1; }
on() { kubectl --kubeconfig "$W/ch7-$1.kubeconfig" "${@:2}"; }
release() { on "$1" -n gpu-operator get deploy gpu-operator -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null | sed 's|.*/||' | grep . || echo none; }
driver() { on "$1" get clusterpolicies.nvidia.com cluster-policy -o jsonpath='{.spec.driver.version}' 2>/dev/null || echo "-"; }
operator() { on "$1" -n gpu-operator get pods -l app=gpu-operator -o jsonpath='{.items[0].metadata.uid}' 2>/dev/null || echo "-"; }
state() { for c in gpu-a gpu-b cpu-c; do printf '  %-6s %-22s driver %-11s operator pod %s\n' "$c" "$(release $c)" "$(driver $c)" "$(operator $c)"; done; }
# Promote each unit's change as one diff (--squash): replaying functions lets
# a root change reach a class's clusters past the class's protection.
# Promoting a large unit can outlast the request; a promotion is idempotent,
# so ask again, and a change order with nothing left to promote has done it.
promote() { local out i; for i in 1 2 3; do out=$(cub variant promote --change-order "$1" --target-stage "$2" --squash --quiet 2>&1 >/dev/null) && return 0; case "$out" in *"nothing left to promote"*) return 0 ;; esac; sleep 15; done; echo "$out" >&2; return 1; }
wait_for() { for i in $(seq 1 60); do eval "$1" && return 0; sleep 5; done; return 1; }

say "0. The fleet today: the GPU operator on every cluster labelled addons.gpu-operator: enabled"
kubectl get sveltosclusters -A --show-labels | cut -c1-170
python3 - "$R/examples/gpu-operator/gpu-fleet.yaml" <<'EOF' | kubectl apply -f -
import sys, yaml
docs = [d for d in yaml.safe_load_all(open(sys.argv[1])) if d and d.get("kind") == "ClusterProfile"]
print(yaml.safe_dump_all(docs, sort_keys=False))
EOF
wait_for '[ "$(operator gpu-a)" != "-" ] && [ -n "$(operator gpu-a)" ]' || fail "the live profile never installed the operator"
wait_for '[ "$(driver gpu-a)" != "-" ]' || fail "no ClusterPolicy on gpu-a"
sleep 20
state; state > "$W/gpu-state-0.txt"
echo "  GPU daemonsets on gpu-a (kind has no GPUs, so none schedule):"
on gpu-a -n gpu-operator get daemonsets -o custom-columns=NAME:.metadata.name,DESIRED:.status.desiredNumberScheduled,NODESELECTOR:.spec.template.spec.nodeSelector --no-headers | sed 's/^/    /'

say "1. Onboard: export, plan, apply, hand over"
kubectl get clusterprofiles,sveltosclusters -A -o yaml > my-fleet.yaml
$BIN plan my-fleet.yaml $OPTS || fail "plan"
$BIN apply my-fleet.yaml $OPTS --out onboard > /dev/null || fail "apply"
bash onboard/apply.sh 2>&1 | grep -v "^Upgraded\|^Adding\|^Marked\|^Promoting\|^Created variant\|^Awaiting\|^$\|Bulk create\|Success:" || true
sleep 60
bash onboard/handover.sh || fail "handover"
wait_for 'kubectl get clustersummaries -A -o json | python3 -c "
import json,sys
sys.exit(0 if any(i[\"metadata\"].get(\"labels\",{}).get(\"projectsveltos.io/cluster-profile-name\")==\"gpu-operator-gpu-a\" and i.get(\"status\",{}).get(\"featureSummaries\") and all(f.get(\"status\")==\"Provisioned\" for f in i[\"status\"][\"featureSummaries\"]) for i in json.load(sys.stdin)[\"items\"]) else 1)"' || fail "gpu-a's variant did not hand over"
sleep 15
state; state > "$W/gpu-state-1.txt"
[ "$(head -1 "$W/gpu-state-0.txt")" = "$(head -1 "$W/gpu-state-1.txt")" ] && echo "  gpu-a: the same operator and driver, and the same operator pod: nothing reinstalled" || echo "  GPU-A CHANGED"
echo "  removing Helm's record of the release, as handover.sh says, leaving its objects:"
on gpu-a -n gpu-operator delete secret -l owner=helm,name=gpu-operator -o name | sed 's/^/    /'

say "2. gpu-b is labelled for the operator"
kubectl label sveltoscluster -n projectsveltos gpu-b addons.gpu-operator=enabled --overwrite
sleep 60
echo "  a minute later, the label alone has shipped nothing:"; state | grep gpu-b
kubectl get sveltosclusters -A -o yaml > clusters.yaml
$BIN plan onboard/profiles.yaml clusters.yaml $OPTS | sed -n '/^gpu-operator/,/^$/p'
$BIN apply onboard/profiles.yaml clusters.yaml $OPTS --out onboard > /dev/null || fail "join apply"
bash onboard/apply.sh 2>&1 | grep -v "^Upgraded\|^Adding\|^Marked\|^Promoting\|^Created variant\|^Awaiting\|^$\|Bulk create\|Success:" | sed -n '/2\/6/,/4\/6/p;/5\/6/,/6\/6/p' || true
wait_for '[ "$(driver gpu-b)" != "-" ]' || fail "gpu-b never got the operator"
sleep 15
cub changeworkflow get --space ch7-gpu-operator-base rollout -o 'jq=[.ChangeWorkflow.Stages[].Name] | join(",")' | sed 's/^/  workflow stages: /'
state; state > "$W/gpu-state-2.txt"

say "3. cpu-c is labelled by mistake"
kubectl label sveltoscluster -n projectsveltos cpu-c addons.gpu-operator=enabled --overwrite
sleep 60
echo "  a minute later, nothing has shipped to cpu-c:"; state | grep cpu-c
kubectl get sveltosclusters -A -o yaml > clusters.yaml
echo "  the plan shows the proposal a reviewer would refuse:"
$BIN plan onboard/profiles.yaml clusters.yaml $OPTS | grep "cpu-c " | sed 's/^/  /'
kubectl label sveltoscluster -n projectsveltos cpu-c addons.gpu-operator- > /dev/null
echo "  label removed; nothing was applied"

say "4. Upgrade: operator v26.3.1 to v26.7.0, driver 580.126.20 to 580.173.02, staging first"
echo "  rendered the way apply.sh says gpu-operator was rendered, at v26.7.0, with the driver moved to 580.173.02:"
grep '^# gpu-operator is rendered with' onboard/apply.sh | sed 's/^/    /'
sed 's/580.126.20/580.173.02/' onboard/gpu-operator/gpu-operator.values.yaml > values-26.7.yaml
cub helm template gpu-operator gpu-operator --repo https://helm.ngc.nvidia.com/nvidia --version v26.7.0 --namespace gpu-operator --create-namespace -f values-26.7.yaml > gpu-operator-26.7.yaml 2>/dev/null || fail "render v26.7.0"
cub unit update --space ch7-gpu-operator-base gpu-operator gpu-operator-26.7.yaml --change-desc "Upgrade to AICR h100-any as published: gpu-operator v26.7.0, driver 580.173.02" --quiet || fail "base update"
head=$(cub unit get --space ch7-gpu-operator-base gpu-operator -o jq=.Unit.HeadRevisionNum)
cub unit diff --space ch7-gpu-operator-base gpu-operator --from $((head - 1)) --to "$head" -o mutations 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' > upgrade.mutations
LABELS='(helm~1sh/chart|app~1kubernetes~1io/version|controller-gen~1kubebuilder~1io/version)$'
echo "  what the base changed, object by object, as ConfigHub's diff lists it, leaving out the chart's version labels:"
awk -v labels="$LABELS" '/^Resource:/ { k = $2; sub(/.*\//, "", k); r = k " " substr($3, $3 ~ /^\// ? 2 : 1); order[++n] = r; next } $2 == "[Add]" && NF == 2 { added[r] = 1; next } NF >= 3 && $3 !~ labels { paths[r]++ } END { for (i = 1; i <= n; i++) { r = order[i]; if (added[r]) printf "    %-62s added\n", r; else if (paths[r]) printf "    %-62s %d %s\n", r, paths[r], (paths[r] == 1 ? "path" : "paths") } }' upgrade.mutations
echo "  the ClusterPolicy's and the operator's, in full:"
awk -v labels="$LABELS" '/^Resource:/ { on = ($2 ~ /\/(ClusterPolicy|Deployment)$/); if (on) { k = $2; sub(/.*\//, "", k); print "    " k " " substr($3, $3 ~ /^\// ? 2 : 1) }; next } on && NF >= 3 && $3 !~ labels { print "      " $1 " " $3 }' upgrade.mutations
cub changeorder create --space ch7-gpu-operator-base upgrade-26-7 --change-workflow ch7-gpu-operator-base/rollout --description "gpu-operator v26.7.0, driver 580.173.02" --quiet || fail "change order"
promote ch7-gpu-operator-base/upgrade-26-7 staging || fail "promote staging"
echo "  EXPECT REFUSAL, promote into prod before staging released:"
cub variant promote --change-order ch7-gpu-operator-base/upgrade-26-7 --target-stage prod --squash --quiet 2>&1 | tail -1 | sed 's/^/    /'
cub variant approve --change-order ch7-gpu-operator-base/upgrade-26-7 --stage staging --quiet || fail "approve staging"
cub release publish ch7-gpu-operator-gpu-a --revision ChangeOrder:ch7-gpu-operator-base/upgrade-26-7 --quiet || fail "publish staging"
wait_for '[ "$(driver gpu-a)" = 580.173.02 ]' || fail "gpu-a never upgraded"
sleep 20
state; state > "$W/gpu-state-4a.txt"
promote ch7-gpu-operator-base/upgrade-26-7 prod || fail "promote prod"
cub variant approve --change-order ch7-gpu-operator-base/upgrade-26-7 --stage prod --quiet || fail "approve prod"
cub release publish ch7-gpu-operator-gpu-b --revision ChangeOrder:ch7-gpu-operator-base/upgrade-26-7 --quiet || fail "publish prod"
wait_for '[ "$(driver gpu-b)" = 580.173.02 ]' || fail "gpu-b never upgraded"
sleep 20
state; state > "$W/gpu-state-4b.txt"
cub changeorder get --space ch7-gpu-operator-base upgrade-26-7 -o jq='.ChangeOrder | {Stage, State}'
say "5. What runs on a node with no GPU"
for c in gpu-a gpu-b; do
  wait_for "[ \"\$(on $c get clusterpolicies.nvidia.com cluster-policy -o jsonpath='{.status.state}')\" = ready ]" || echo "  $c ClusterPolicy did not report ready"
  echo "== $c"; on $c -n gpu-operator get pods,daemonsets --no-headers 2>&1 | sed 's/^/  /'
  printf '  ClusterPolicy status %s, nodes labelled nvidia.com/gpu.present: %s\n' "$(on $c get clusterpolicies.nvidia.com cluster-policy -o jsonpath='{.status.state}')" "$(on $c get nodes -l nvidia.com/gpu.present --no-headers 2>/dev/null | wc -l | tr -d ' ')"
done
say "GPU-CHAPTER-DONE"
