#!/usr/bin/env bash
# The whole "already running Sveltos" journey on kind, with cub sveltos: live
# label-selector profiles -> plan -> apply -> handover (nothing reinstalled) ->
# a chart upgrade and a field change, released together through the stages ->
# a new cluster joins. Build the fleet
# first with kind-fleet.mjs, log in with cub, then:
#
#   bash examples/onboard/run.sh
#
# It creates fifteen Spaces prefixed ob- in your ConfigHub organization and
# keeps them, so the result can be opened in ConfigHub.
set -uo pipefail
R=$(cd "$(dirname "$0")/../.." && pwd)
W=${ONBOARD_DIR:-${TMPDIR:-/tmp}/sveltos-onboard}
W=${W%/}
BIN=${SVELTOS:-cub sveltos}
U="$W/user"; rm -rf "$U"; mkdir -p "$U"; cd "$U"
export KUBECONFIG="$W/ob-mgmt.kubeconfig" MGMT_CONTEXT=kind-ob-mgmt
# Sveltos reaches the kind clusters at addresses only the management cluster
# resolves, so handover.sh compares with what Helm installed through
# kubeconfigs that reach them from here.
export CLUSTER_KUBECONFIGS="$W/reachable"; mkdir -p "$CLUSTER_KUBECONFIGS"
for c in staging-eu prod-eu prod-us staging-us; do ln -sf "$W/ob-$c.kubeconfig" "$CLUSTER_KUBECONFIGS/$c.kubeconfig"; done
OPTS="--stage-label env --stages staging,prod --include-hooks ingress-nginx --prefix ob"
CLUSTERS="staging-eu prod-eu prod-us"
say() { printf '\n##### %s  [%s]\n' "$*" "$(date -u +%H:%M:%S)"; }
fail() { say "FAILED: $*"; exit 1; }
on() { kubectl --kubeconfig "$W/ob-$1.kubeconfig" "${@:2}"; }
helm_on() { helm --kubeconfig "$W/ob-$1.kubeconfig" "${@:2}"; }
releases() { for c in $CLUSTERS; do printf '  %-11s helm list: %s\n' "$c" "$(helm_on $c list -A -o json | python3 -c "import json,sys; print(' '.join(sorted(r['name']+'@rev'+str(r['revision']) for r in json.load(sys.stdin))) or 'nothing')")"; done; }
# The long-running pods (those a Deployment, DaemonSet or StatefulSet runs;
# a Job's pods come and go) and the policy, by UID.
pods() { for c in $CLUSTERS; do for ns in kyverno ingress-nginx; do on $c get pods -n $ns -o json 2>/dev/null | python3 -c "
import json,sys
for p in json.load(sys.stdin)['items']:
  if (p['metadata'].get('ownerReferences') or [{}])[0].get('kind') in ('ReplicaSet','DaemonSet','StatefulSet'): print(p['metadata']['uid'], p['metadata']['name'])"; done; on $c get clusterpolicy disallow-latest-tag -o jsonpath='{.metadata.uid}{" ClusterPolicy\n"}' 2>/dev/null; done | sort; }
image() { on $1 -n kyverno get deploy kyverno-admission-controller -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || echo "-"; }
state() { for c in $CLUSTERS; do printf '  %-11s kyverno %-44s replicas %s  ingress-nginx %s\n' "$c" "$(image $c)" "$(on $c -n kyverno get deploy kyverno-admission-controller -o jsonpath='{.spec.replicas}' 2>/dev/null)" "$(on $c -n ingress-nginx get deploy ingress-nginx-controller -o jsonpath='{.status.readyReplicas}/{.spec.replicas}' 2>/dev/null || echo -)"; done; }
summaries() { kubectl get clustersummaries -A -o json | python3 -c "
import json,sys
for it in json.load(sys.stdin)['items']:
  p=it['metadata'].get('labels',{}).get('projectsveltos.io/cluster-profile-name','')
  for f in it.get('status',{}).get('featureSummaries',[]) or []:
    print('  %-28s %-11s %-9s %-20s %s' % (p, it['spec']['clusterName'], f.get('featureID'), f.get('status'), (f.get('failureMessage') or '').strip()[:80]))" | sort; }
provisioned() { kubectl get clustersummaries -A -o json | python3 -c "
import json,sys
want=set(sys.argv[1:]); ok=set()
for it in json.load(sys.stdin)['items']:
  p=it['metadata'].get('labels',{}).get('projectsveltos.io/cluster-profile-name','')
  fs=it.get('status',{}).get('featureSummaries',[])
  if p in want and fs and all(f.get('status')=='Provisioned' for f in fs): ok.add(p)
print(len(ok))" "$@"; }
# Promote each unit's change as one diff (--squash): replaying functions lets
# a root change reach a class's clusters past the class's protection.
# Promoting a large unit can outlast the request; a promotion is idempotent,
# so ask again, and a change order with nothing left to promote has done it.
promote() { local out i; for i in 1 2 3; do out=$(cub variant promote --change-order "$1" --target-stage "$2" --squash --quiet 2>&1 >/dev/null) && return 0; case "$out" in *"nothing left to promote"*) return 0 ;; esac; sleep 15; done; echo "$out" >&2; return 1; }
wait_for() { for i in $(seq 1 72); do eval "$1" && return 0; sleep 5; done; return 1; }
wait_provisioned() { local n=$1; shift; wait_for "[ \"\$(provisioned $*)\" = $n ]"; }
in_stage() { for c in $CLUSTERS; do case $c in "$1"*) printf '%s ' "$c" ;; esac; done; }

say "0. The fleet today: Kyverno, its policies and ingress-nginx, live, by label"
kubectl get sveltosclusters -A --show-labels | cut -c1-120
python3 - "$R/examples/onboard/my-fleet.yaml" <<'EOF' | kubectl apply -f -
import sys, yaml
docs = [d for d in yaml.safe_load_all(open(sys.argv[1])) if d and d.get("kind") in ("ClusterProfile", "ConfigMap")]
print(yaml.safe_dump_all(docs, sort_keys=False))
EOF
wait_provisioned 3 kyverno ingress-nginx kyverno-policies || fail "the live profiles never provisioned"
wait_for '[ "$(on prod-us -n ingress-nginx get deploy ingress-nginx-controller -o jsonpath={.status.readyReplicas} 2>/dev/null)" = 1 ]' || fail "ingress-nginx never came up"
sleep 20
state; releases
pods > "$W/pods-before.txt"; echo "  $(wc -l < "$W/pods-before.txt" | tr -d ' ') pods and policies recorded by UID"

say "1. Export what Sveltos knows, and the ConfigMap a profile names"
kubectl get clusterprofiles,sveltosclusters -A -o yaml > my-fleet.yaml
kubectl get configmap -n default kyverno-policies -o yaml > kyverno-policies.yaml

say "2. See the plan"
$BIN plan my-fleet.yaml kyverno-policies.yaml $OPTS || fail "plan"

say "3. Write the steps"
$BIN apply my-fleet.yaml kyverno-policies.yaml $OPTS --out onboard > /dev/null || fail "apply"
ls onboard onboard/kyverno
printf '  onboard/kyverno/kyverno.yaml holds %s objects\n' "$(grep -c '^kind:' onboard/kyverno/kyverno.yaml)"

say "4. Run them"
bash onboard/apply.sh 2>&1 | grep -v "^Upgraded\|^Adding\|^Marked\|^Promoting\|^Created variant\|^Awaiting\|^$\|Bulk create\|Success:" || true
[ "${PIPESTATUS[0]}" = 0 ] || fail "apply.sh"
sleep 30
say "   the live profiles still manage everything; the delivery profiles wait for handover.sh"
summaries

say "5. Hand the live profiles over"
bash onboard/handover.sh || fail "handover.sh"
wait_provisioned 8 kyverno-staging-eu kyverno-prod-eu kyverno-prod-us ingress-nginx-prod-eu ingress-nginx-prod-us kyverno-policies-staging-eu kyverno-policies-prod-eu kyverno-policies-prod-us || fail "the delivery profiles did not hand over"
sleep 20
summaries
pods > "$W/pods-after.txt"
if diff -q "$W/pods-before.txt" "$W/pods-after.txt" >/dev/null; then echo "  every pod and policy is the one that ran before onboarding: nothing was reinstalled"; else echo "  PODS CHANGED"; diff "$W/pods-before.txt" "$W/pods-after.txt"; fi
echo "  Helm's record, still at the revision it had:"
releases
echo "  removing Helm's record of the releases, as handover.sh says:"
for c in $CLUSTERS; do on $c -n kyverno delete secret -l owner=helm,name=kyverno -o name; on $c -n ingress-nginx delete secret -l owner=helm,name=ingress-nginx -o name 2>/dev/null; done | sed 's/^/    /'
releases
state

say "6. Two changes, one release, through the stages: a chart upgrade and a field"
SEL='select(.kind == "Deployment" and .metadata.name == "kyverno-admission-controller")'
echo "  Kyverno 3.8.2, rendered the way apply.sh says kyverno was rendered, onto the base:"
grep '^# kyverno is rendered with' onboard/apply.sh | sed 's/^/    /'
cub helm template kyverno kyverno --repo https://kyverno.github.io/kyverno --version 3.8.2 --namespace kyverno --create-namespace -f onboard/kyverno/kyverno.values.yaml 2>/dev/null | grep -vxF '$comment$head$: ""' > kyverno-3.8.2.yaml || fail "render 3.8.2"
cub unit update --space ob-kyverno-base kyverno kyverno-3.8.2.yaml --change-desc "Kyverno 3.8.2" --quiet || fail "base update"
echo "  and the admission controller at 4 replicas, a field changed in ConfigHub:"
cub function set --space ob-kyverno-base --unit kyverno --change-desc "Admission controller at 4 replicas" --quiet -- set-yq "($SEL | .spec.replicas) = 4" > /dev/null || fail "base edit"
echo "  what the base changed, field by field, leaving out the chart's version labels:"
cub unit diff --space ob-kyverno-base kyverno --from 2 --to "$(cub unit get --space ob-kyverno-base kyverno -o jq=.Unit.HeadRevisionNum)" 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' | grep -E '^ *[0-9]+: [-+]' | sed 's/^ *[0-9]*: //' | grep -v 'helm.sh/chart\|app.kubernetes.io/version' | sed 's/^/    /' | head -16
cub changeorder create --space ob-kyverno-base kyverno-3-8-2 --change-workflow ob-kyverno-base/rollout --description "Kyverno 3.8.2, admission controller at 4 replicas" --quiet || fail "change order"
promote ob-kyverno-base/kyverno-3-8-2 staging || fail "promote staging"
echo "  EXPECT REFUSAL, promote into prod before staging released:"
cub variant promote --change-order ob-kyverno-base/kyverno-3-8-2 --target-stage prod --squash --quiet 2>&1 | grep -v "^Promoting\|^Upgraded\|^Adding\|^Marked" | tail -1 | sed 's/^/    /'
for stage in staging prod; do
  [ $stage = prod ] && { promote ob-kyverno-base/kyverno-3-8-2 prod || fail "promote prod"; }
  cub variant approve --change-order ob-kyverno-base/kyverno-3-8-2 --stage $stage --quiet || fail "approve $stage"
  for c in $(in_stage $stage); do cub release publish ob-kyverno-$c --revision ChangeOrder:ob-kyverno-base/kyverno-3-8-2 --quiet || fail "publish $c"; done
  for c in $(in_stage $stage); do wait_for "[ \"\$(image $c)\" = reg.kyverno.io/kyverno/kyverno:v1.18.2 ]" || fail "$c never upgraded"; done
  sleep 10; echo "  after $stage:"; state
done
cub changeorder get --space ob-kyverno-base kyverno-3-8-2 -o jq='.ChangeOrder | {Stage, State}'

say "7. A new cluster registers with Sveltos"
node "$R/examples/onboard/kind-fleet.mjs" --join | tail -1
CLUSTERS="$CLUSTERS staging-us"
sleep 30
echo "  what Sveltos put on staging-us by itself: $(on staging-us get ns kyverno -o name 2>/dev/null || echo nothing)"
kubectl get sveltosclusters -A -o yaml > clusters.yaml
$BIN plan onboard/profiles.yaml clusters.yaml $OPTS | sed -n '/^kyverno  /,/^$/p'
$BIN apply onboard/profiles.yaml clusters.yaml $OPTS --out onboard > /dev/null || fail "join apply"
bash onboard/apply.sh 2>&1 | grep -v "^Upgraded\|^Adding\|^Marked\|^Promoting\|^Created variant\|^Awaiting\|^$\|Bulk create\|Success:" || true
wait_provisioned 2 kyverno-staging-us kyverno-policies-staging-us || fail "staging-us did not get its variants"
wait_for '[ "$(image staging-us)" = reg.kyverno.io/kyverno/kyverno:v1.18.2 ]' || fail "staging-us is not at 3.8.2"
state
echo "  staging-us joined after the change and has it, and the policy: $(on staging-us get clusterpolicy -o name)"

say "8. What ConfigHub holds"
cub space list --where "Slug LIKE 'ob-%'" 2>&1 | awk '{print "  " $1}'
say "ONBOARD-REHEARSAL-DONE"
