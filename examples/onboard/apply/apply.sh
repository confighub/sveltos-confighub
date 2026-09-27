#!/usr/bin/env bash
# Onboard ingress-nginx, kyverno, kyverno-policies into ConfigHub: one variant per cluster per profile.
# Written by `cub sveltos apply`. Read it, then run it:
#
#   MGMT_CONTEXT=<kubectl context of your management cluster> bash apply.sh
#
# cub uses its current context; set CUB_CONTEXT to choose another.
# Steps 1 to 4 only create records in ConfigHub: each base holds the objects
# its charts and policies rendered to, in the files beside this script. Step 5
# is the first release: each stage is promoted, approved, released. All of it
# is safe to re-run, which is also how a cluster that joined since gets its
# variants. Step 6 is the one change to your management cluster: a Secret
# holding the gateway credential, and one delivery profile per variant.
set -euo pipefail
cd "$(dirname "$0")"
k() { kubectl ${MGMT_CONTEXT:+--context "$MGMT_CONTEXT"} "$@"; }
step() { printf '\n== %s\n' "$*"; }
# Re-running picks up where ConfigHub says each first release stands: a
# finished change order is skipped, and a variant with nothing new is kept.
# A cluster that joined since makes a new change order, which releases it.
rolled_out() { [ "$(cub changeorder get --space "${1%/*}" "${1#*/}" -o jq=.ChangeOrder.Stage)" = Completed ]; }
# A class base takes its departures once, as a fresh clone (an empty
# revision, then the clone), and they touch only their own fields and
# objects. Later revisions are changes made in ConfigHub, which a re-run
# leaves alone.
fresh() { [ "$(cub unit get --space "$1" "$2" -o jq=.Unit.HeadRevisionNum)" -le 2 ] || { echo "$1/$2 already has its departures"; return 1; }; }
# A variant must hold every unit of its base before it is released: Sveltos
# removes from a cluster whatever a release no longer holds.
holds() {
  local n; n=$(cub unit list --space "$1" -o jq=length)
  [ "$n" -ge "$2" ] || { echo "$1 holds $n of its $2 units; run this script again" >&2; return 1; }
}
# A cluster that joins in a stage the workflow does not have yet adds that
# stage. Only the stages are patched, so approval settings made since stay.
stages_are() { [ "$(cub changeworkflow get --space "$1" "$2" -o 'jq=[.ChangeWorkflow.Stages[].Name] | join(",")')" = "$3" ]; }
# A promotion takes each unit's change as one diff (--squash). Walked
# revision by revision, it replays the functions a change was made with,
# and a function run at the root then reaches a class's clusters although
# the class base protected the field (measured on kind). Promoting a large
# unit, a chart with its CRDs, can also outlast the request: cub reports no
# response while the server finishes. A promotion is idempotent, so it is
# asked again, and a change order with nothing left to promote has done it.
promote() {
  local out i
  for i in 1 2 3; do
    out=$(cub variant promote --change-order "$1" --target-stage "$2" --squash --quiet 2>&1 >/dev/null) && return 0
    case "$out" in *"nothing left to promote"*) return 0 ;; esac
    sleep 15
  done
  echo "$out" >&2; return 1
}
publish() {
  local out
  holds "$1" "$3" || return 1
  out=$(cub release publish "$1" --revision "ChangeOrder:$2" --quiet 2>&1) && return 0
  case "$out" in *"no changes were made since :latest bundle"*) echo "$1 already released" ;; *) echo "$out" >&2; return 1 ;; esac
}

step "0/6 Check before changing anything"
cub space list --quiet >/dev/null || { echo "cub is not logged in: run cub auth login"; exit 1; }
image=$(k get deployment addon-controller -n projectsveltos -o jsonpath='{.spec.template.spec.containers[0].image}')
version=${image##*:}
if [ "$(printf '%s\n' v1.14.0 "$version" | sort -V | head -1)" != v1.14.0 ]; then
  echo "the management cluster runs addon-controller $version; ConfigHub's gateway serves gzipped layers, which Sveltos reads from v1.14.0"; exit 1
fi

step "1/6 One named Target per cluster, in sveltos-targets"
cub space create sveltos-targets --allow-exists --quiet
# A server-hosted worker has no process behind it and no role in the
# organization; it holds the Targets and is the credential Sveltos reads with.
cub worker create --space sveltos-targets server-worker --is-server-worker --org-role none --allow-exists --quiet
cub target create mgmt '{}' server-worker --space sveltos-targets --provider OCI --toolchain Any --allow-exists --quiet
cub target create prod-eu '{}' server-worker --space sveltos-targets --provider OCI --toolchain Any --allow-exists --quiet
cub target create prod-us '{}' server-worker --space sveltos-targets --provider OCI --toolchain Any --allow-exists --quiet
cub target create staging-eu '{}' server-worker --space sveltos-targets --provider OCI --toolchain Any --allow-exists --quiet

step "2/6 One component per profile: a base holding what its charts and policies render to, and a rollout workflow"
cub component create sveltos-ingress-nginx --allow-exists --quiet
cub space create sveltos-ingress-nginx-base --component sveltos-ingress-nginx --label Component=sveltos-ingress-nginx --label Role=base --allow-exists --quiet
# ingress-nginx is rendered with: cub helm template ingress-nginx ingress-nginx --repo https://kubernetes.github.io/ingress-nginx --version 4.15.1 --namespace ingress-nginx --create-namespace --include-hooks
cub unit create --space sveltos-ingress-nginx-base ingress-nginx ingress-nginx/ingress-nginx.yaml --change-desc 'Onboard ingress-nginx: chart ingress-nginx 4.15.1 from https://kubernetes.github.io/ingress-nginx' --allow-exists --quiet
cub changeworkflow create --space sveltos-ingress-nginx-base rollout --filename ingress-nginx/change-workflow.yaml --allow-exists --quiet
stages_are sveltos-ingress-nginx-base rollout prod || echo '{"Stages":[{"Name":"prod","WhereSpace":"Labels.Stage = '\''prod'\''","ReleasePrerequisites":["approval"]}]}' | cub changeworkflow update --patch --space sveltos-ingress-nginx-base rollout --from-stdin --quiet
cub component create sveltos-kyverno --allow-exists --quiet
cub space create sveltos-kyverno-base --component sveltos-kyverno --label Component=sveltos-kyverno --label Role=base --allow-exists --quiet
# kyverno is rendered with: cub helm template kyverno kyverno --repo https://kyverno.github.io/kyverno --version 3.8.1 --namespace kyverno --create-namespace -f kyverno/kyverno.values.yaml
cub unit create --space sveltos-kyverno-base kyverno kyverno/kyverno.yaml --change-desc 'Onboard kyverno: chart kyverno 3.8.1 from https://kyverno.github.io/kyverno' --allow-exists --quiet
cub changeworkflow create --space sveltos-kyverno-base rollout --filename kyverno/change-workflow.yaml --allow-exists --quiet
stages_are sveltos-kyverno-base rollout staging,prod || echo '{"Stages":[{"Name":"staging","WhereSpace":"Labels.Stage = '\''staging'\''","ReleasePrerequisites":["approval"]},{"Name":"prod","WhereSpace":"Labels.Stage = '\''prod'\''","Prerequisites":["Released"],"ReleasePrerequisites":["approval"]}]}' | cub changeworkflow update --patch --space sveltos-kyverno-base rollout --from-stdin --quiet
cub component create sveltos-kyverno-policies --allow-exists --quiet
cub space create sveltos-kyverno-policies-base --component sveltos-kyverno-policies --label Component=sveltos-kyverno-policies --label Role=base --allow-exists --quiet
cub unit create --space sveltos-kyverno-policies-base kyverno-policies kyverno-policies/kyverno-policies.yaml --change-desc 'Onboard kyverno-policies: ConfigMap default/kyverno-policies' --allow-exists --quiet
cub changeworkflow create --space sveltos-kyverno-policies-base rollout --filename kyverno-policies/change-workflow.yaml --allow-exists --quiet
stages_are sveltos-kyverno-policies-base rollout staging,prod || echo '{"Stages":[{"Name":"staging","WhereSpace":"Labels.Stage = '\''staging'\''","ReleasePrerequisites":["approval"]},{"Name":"prod","WhereSpace":"Labels.Stage = '\''prod'\''","Prerequisites":["Released"],"ReleasePrerequisites":["approval"]}]}' | cub changeworkflow update --patch --space sveltos-kyverno-policies-base rollout --from-stdin --quiet

step "3/6 One variant per cluster, each holding what its base holds"
cub variant create prod-eu sveltos-ingress-nginx-base --stage prod --space-pattern template:sveltos-ingress-nginx-prod-eu --target sveltos-targets/prod-eu --space-label Role=deployment --space-label Cluster=prod-eu --allow-exists --quiet
holds sveltos-ingress-nginx-prod-eu 1
cub variant create prod-us sveltos-ingress-nginx-base --stage prod --space-pattern template:sveltos-ingress-nginx-prod-us --target sveltos-targets/prod-us --space-label Role=deployment --space-label Cluster=prod-us --allow-exists --quiet
holds sveltos-ingress-nginx-prod-us 1
cub variant create staging-eu sveltos-kyverno-base --stage staging --space-pattern template:sveltos-kyverno-staging-eu --target sveltos-targets/staging-eu --space-label Role=deployment --space-label Cluster=staging-eu --allow-exists --quiet
holds sveltos-kyverno-staging-eu 1
cub variant create prod-eu sveltos-kyverno-base --stage prod --space-pattern template:sveltos-kyverno-prod-eu --target sveltos-targets/prod-eu --space-label Role=deployment --space-label Cluster=prod-eu --allow-exists --quiet
holds sveltos-kyverno-prod-eu 1
cub variant create prod-us sveltos-kyverno-base --stage prod --space-pattern template:sveltos-kyverno-prod-us --target sveltos-targets/prod-us --space-label Role=deployment --space-label Cluster=prod-us --allow-exists --quiet
holds sveltos-kyverno-prod-us 1
cub variant create staging-eu sveltos-kyverno-policies-base --stage staging --space-pattern template:sveltos-kyverno-policies-staging-eu --target sveltos-targets/staging-eu --space-label Role=deployment --space-label Cluster=staging-eu --allow-exists --quiet
holds sveltos-kyverno-policies-staging-eu 1
cub variant create prod-eu sveltos-kyverno-policies-base --stage prod --space-pattern template:sveltos-kyverno-policies-prod-eu --target sveltos-targets/prod-eu --space-label Role=deployment --space-label Cluster=prod-eu --allow-exists --quiet
holds sveltos-kyverno-policies-prod-eu 1
cub variant create prod-us sveltos-kyverno-policies-base --stage prod --space-pattern template:sveltos-kyverno-policies-prod-us --target sveltos-targets/prod-us --space-label Role=deployment --space-label Cluster=prod-us --allow-exists --quiet
holds sveltos-kyverno-policies-prod-us 1

step "4/6 The management cluster's record: one delivery profile per variant"
cub component create sveltos-management --allow-exists --quiet
cub space create sveltos-management --component sveltos-management --allow-exists --quiet
cub unit create --space sveltos-management delivery-ingress-nginx management/ingress-nginx.yaml --target sveltos-targets/mgmt --change-desc 'The profiles that deliver each ingress-nginx variant'\''s releases to its cluster' --allow-exists --quiet
cub unit update --space sveltos-management delivery-ingress-nginx management/ingress-nginx.yaml --change-desc 'The delivery profiles for every ingress-nginx variant this plan holds' --quiet
cub unit create --space sveltos-management delivery-kyverno management/kyverno.yaml --target sveltos-targets/mgmt --change-desc 'The profiles that deliver each kyverno variant'\''s releases to its cluster' --allow-exists --quiet
cub unit update --space sveltos-management delivery-kyverno management/kyverno.yaml --change-desc 'The delivery profiles for every kyverno variant this plan holds' --quiet
cub unit create --space sveltos-management delivery-kyverno-policies management/kyverno-policies.yaml --target sveltos-targets/mgmt --change-desc 'The profiles that deliver each kyverno-policies variant'\''s releases to its cluster' --allow-exists --quiet
cub unit update --space sveltos-management delivery-kyverno-policies management/kyverno-policies.yaml --change-desc 'The delivery profiles for every kyverno-policies variant this plan holds' --quiet

step "5/6 Release each variant, stage by stage: promote, approve, publish"
cub changeorder create --space sveltos-ingress-nginx-base onboard-c3558924 --change-workflow sveltos-ingress-nginx-base/rollout --description 'First release of sveltos-ingress-nginx-prod-eu, sveltos-ingress-nginx-prod-us' --allow-exists --quiet
if rolled_out sveltos-ingress-nginx-base/onboard-c3558924; then
  echo 'ingress-nginx: every variant in this plan is released'
else
  promote sveltos-ingress-nginx-base/onboard-c3558924 prod
  cub variant approve --change-order sveltos-ingress-nginx-base/onboard-c3558924 --stage prod --quiet
  publish sveltos-ingress-nginx-prod-eu sveltos-ingress-nginx-base/onboard-c3558924 1
  publish sveltos-ingress-nginx-prod-us sveltos-ingress-nginx-base/onboard-c3558924 1
fi
cub changeorder create --space sveltos-kyverno-base onboard-25e1c3f8 --change-workflow sveltos-kyverno-base/rollout --description 'First release of sveltos-kyverno-staging-eu, sveltos-kyverno-prod-eu, sveltos-kyverno-prod-us' --allow-exists --quiet
if rolled_out sveltos-kyverno-base/onboard-25e1c3f8; then
  echo 'kyverno: every variant in this plan is released'
else
  promote sveltos-kyverno-base/onboard-25e1c3f8 staging
  cub variant approve --change-order sveltos-kyverno-base/onboard-25e1c3f8 --stage staging --quiet
  publish sveltos-kyverno-staging-eu sveltos-kyverno-base/onboard-25e1c3f8 1
  promote sveltos-kyverno-base/onboard-25e1c3f8 prod
  cub variant approve --change-order sveltos-kyverno-base/onboard-25e1c3f8 --stage prod --quiet
  publish sveltos-kyverno-prod-eu sveltos-kyverno-base/onboard-25e1c3f8 1
  publish sveltos-kyverno-prod-us sveltos-kyverno-base/onboard-25e1c3f8 1
fi
cub changeorder create --space sveltos-kyverno-policies-base onboard-1b86298b --change-workflow sveltos-kyverno-policies-base/rollout --description 'First release of sveltos-kyverno-policies-staging-eu, sveltos-kyverno-policies-prod-eu, sveltos-kyverno-policies-prod-us' --allow-exists --quiet
if rolled_out sveltos-kyverno-policies-base/onboard-1b86298b; then
  echo 'kyverno-policies: every variant in this plan is released'
else
  promote sveltos-kyverno-policies-base/onboard-1b86298b staging
  cub variant approve --change-order sveltos-kyverno-policies-base/onboard-1b86298b --stage staging --quiet
  publish sveltos-kyverno-policies-staging-eu sveltos-kyverno-policies-base/onboard-1b86298b 1
  promote sveltos-kyverno-policies-base/onboard-1b86298b prod
  cub variant approve --change-order sveltos-kyverno-policies-base/onboard-1b86298b --stage prod --quiet
  publish sveltos-kyverno-policies-prod-eu sveltos-kyverno-policies-base/onboard-1b86298b 1
  publish sveltos-kyverno-policies-prod-us sveltos-kyverno-policies-base/onboard-1b86298b 1
fi

step "6/6 Point Sveltos at ConfigHub (your management cluster)"
# Sveltos reads the gateway as the Targets' server worker: a credential that
# does not expire and can pull only the releases of those Targets. The ID and
# secret go from cub into the Secret through file descriptors, never to disk,
# the command line, or the terminal.
k create secret generic confighub-sveltos-targets --namespace projectsveltos --type addons.projectsveltos.io/cluster-profile \
  --from-file=username=<(cub worker get --space sveltos-targets server-worker -o jq=.BridgeWorker.BridgeWorkerID | tr -d '\n') \
  --from-file=password=<(cub worker get --space sveltos-targets server-worker --include-secret -o jq=.BridgeWorker.Secret | tr -d '\n') \
  --dry-run=client -o yaml | k apply -f -
k apply -f management/ingress-nginx.yaml
k apply -f management/kyverno.yaml
k apply -f management/kyverno-policies.yaml

echo
echo "Done. Sveltos delivers each variant's release to its cluster within a minute. Watch it with:"
echo "  kubectl get clustersummaries -A"
