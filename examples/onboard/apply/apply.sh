#!/usr/bin/env bash
# Onboard ingress-nginx, kyverno, kyverno-policies into ConfigHub: one variant per cluster per profile.
# Written by `cub sveltos apply`. Read it, then run it:
#
#   MGMT_CONTEXT=<kubectl context of your management cluster> bash apply.sh
#
# cub uses its current context; set CUB_CONTEXT to choose another.
# Steps 1 to 4 only create records in ConfigHub. Step 5 is the first release:
# each stage is promoted, approved, released. All of it is safe to re-run,
# which is also how a cluster that joined since gets its variants.
# Step 6 is the one change to your management cluster: a Secret holding the
# gateway credential, and one bootstrap profile per variant.
set -euo pipefail
cd "$(dirname "$0")"
k() { kubectl ${MGMT_CONTEXT:+--context "$MGMT_CONTEXT"} "$@"; }
step() { printf '\n== %s\n' "$*"; }
# Re-running picks up where ConfigHub says each first release stands: a
# finished change order is skipped, and a variant with nothing new is kept.
# A cluster that joined since makes a new change order, which releases it.
rolled_out() { [ "$(cub changeorder get --space "${1%/*}" "${1#*/}" -o jq=.ChangeOrder.Stage)" = Completed ]; }
# A variant takes its departures once, as a fresh clone (an empty revision,
# then the clone), and they touch only their own fields, so the clone keeps
# everything the base holds today. Later revisions are changes made in
# ConfigHub, which a re-run leaves alone.
depart() {
  if [ "$(cub unit get --space "$1" "$2" -o jq=.Unit.HeadRevisionNum)" -le 2 ]; then
    cub function set --space "$1" --unit "$2" --change-desc "$4" --quiet -- set-yq "$3"
  else
    echo "$1/$2 already has its departures"
  fi
}
publish() {
  local out
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
cub worker create --space sveltos-targets server-worker --filename worker.json --allow-exists --quiet
cub target create mgmt '{}' server-worker --space sveltos-targets --provider OCI --toolchain Any --allow-exists --quiet
cub target create prod-eu '{}' server-worker --space sveltos-targets --provider OCI --toolchain Any --allow-exists --quiet
cub target create prod-us '{}' server-worker --space sveltos-targets --provider OCI --toolchain Any --allow-exists --quiet
cub target create staging-eu '{}' server-worker --space sveltos-targets --provider OCI --toolchain Any --allow-exists --quiet

step "2/6 One component, one base and one rollout workflow per profile"
cub component create sveltos-ingress-nginx --allow-exists --quiet
cub space create sveltos-ingress-nginx-base --component sveltos-ingress-nginx --allow-exists --quiet
cub unit create --space sveltos-ingress-nginx-base clusterprofile ingress-nginx/base.yaml --change-desc 'Onboard ingress-nginx from its ClusterProfile: the shared base' --allow-exists --quiet
cub changeworkflow create --space sveltos-ingress-nginx-base rollout --filename ingress-nginx/change-workflow.yaml --allow-exists --quiet
cub component create sveltos-kyverno --allow-exists --quiet
cub space create sveltos-kyverno-base --component sveltos-kyverno --allow-exists --quiet
cub unit create --space sveltos-kyverno-base clusterprofile kyverno/base.yaml --change-desc 'Onboard kyverno from its ClusterProfile: the shared base' --allow-exists --quiet
cub changeworkflow create --space sveltos-kyverno-base rollout --filename kyverno/change-workflow.yaml --allow-exists --quiet
cub component create sveltos-kyverno-policies --allow-exists --quiet
cub space create sveltos-kyverno-policies-base --component sveltos-kyverno-policies --allow-exists --quiet
cub unit create --space sveltos-kyverno-policies-base clusterprofile kyverno-policies/base.yaml --change-desc 'Onboard kyverno-policies from its ClusterProfile: the shared base' --allow-exists --quiet
cub unit create --space sveltos-kyverno-policies-base configmap-default-kyverno-policies kyverno-policies/configmap-default-kyverno-policies.yaml --change-desc 'Onboard the policies kyverno-policies reads from ConfigMap default/kyverno-policies' --allow-exists --quiet
cub changeworkflow create --space sveltos-kyverno-policies-base rollout --filename kyverno-policies/change-workflow.yaml --allow-exists --quiet

step "3/6 One variant per cluster, addressed to that cluster alone"
cub variant create prod-eu sveltos-ingress-nginx-base --stage prod --space-pattern template:sveltos-ingress-nginx-prod-eu --target sveltos-targets/prod-eu --allow-exists --quiet
depart sveltos-ingress-nginx-prod-eu clusterprofile '.metadata.name = "ingress-nginx-prod-eu" | .spec.clusterRefs = [{"apiVersion":"lib.projectsveltos.io/v1beta1","kind":"SveltosCluster","namespace":"projectsveltos","name":"prod-eu"}]' 'Depart from the base for prod-eu: metadata.name, spec.clusterRefs'
cub variant create prod-us sveltos-ingress-nginx-base --stage prod --space-pattern template:sveltos-ingress-nginx-prod-us --target sveltos-targets/prod-us --allow-exists --quiet
depart sveltos-ingress-nginx-prod-us clusterprofile '.metadata.name = "ingress-nginx-prod-us" | .spec.clusterRefs = [{"apiVersion":"lib.projectsveltos.io/v1beta1","kind":"SveltosCluster","namespace":"projectsveltos","name":"prod-us"}]' 'Depart from the base for prod-us: metadata.name, spec.clusterRefs'
cub variant create staging-eu sveltos-kyverno-base --stage staging --space-pattern template:sveltos-kyverno-staging-eu --target sveltos-targets/staging-eu --allow-exists --quiet
depart sveltos-kyverno-staging-eu clusterprofile '.metadata.name = "kyverno-staging-eu" | .spec.clusterRefs = [{"apiVersion":"lib.projectsveltos.io/v1beta1","kind":"SveltosCluster","namespace":"projectsveltos","name":"staging-eu"}]' 'Depart from the base for staging-eu: metadata.name, spec.clusterRefs'
cub variant create prod-eu sveltos-kyverno-base --stage prod --space-pattern template:sveltos-kyverno-prod-eu --target sveltos-targets/prod-eu --allow-exists --quiet
depart sveltos-kyverno-prod-eu clusterprofile '.metadata.name = "kyverno-prod-eu" | .spec.clusterRefs = [{"apiVersion":"lib.projectsveltos.io/v1beta1","kind":"SveltosCluster","namespace":"projectsveltos","name":"prod-eu"}]' 'Depart from the base for prod-eu: metadata.name, spec.clusterRefs'
cub variant create prod-us sveltos-kyverno-base --stage prod --space-pattern template:sveltos-kyverno-prod-us --target sveltos-targets/prod-us --allow-exists --quiet
depart sveltos-kyverno-prod-us clusterprofile '.metadata.name = "kyverno-prod-us" | .spec.clusterRefs = [{"apiVersion":"lib.projectsveltos.io/v1beta1","kind":"SveltosCluster","namespace":"projectsveltos","name":"prod-us"}]' 'Depart from the base for prod-us: metadata.name, spec.clusterRefs'
cub variant create staging-eu sveltos-kyverno-policies-base --stage staging --space-pattern template:sveltos-kyverno-policies-staging-eu --target sveltos-targets/staging-eu --allow-exists --quiet
depart sveltos-kyverno-policies-staging-eu clusterprofile '.metadata.name = "kyverno-policies-staging-eu" | .spec.clusterRefs = [{"apiVersion":"lib.projectsveltos.io/v1beta1","kind":"SveltosCluster","namespace":"projectsveltos","name":"staging-eu"}] | .spec.dependsOn = ["kyverno-staging-eu"] | (.spec.policyRefs[] | select(.kind == "ConfigMap" and .namespace == "default" and .name == "kyverno-policies") | .name) = "kyverno-policies-staging-eu"' 'Depart from the base for staging-eu: metadata.name, spec.clusterRefs, spec.dependsOn, spec.policyRefs'
depart sveltos-kyverno-policies-staging-eu configmap-default-kyverno-policies '.metadata.name = "kyverno-policies-staging-eu"' 'staging-eu'\''s own copy of the policies: kyverno-policies-staging-eu'
cub variant create prod-eu sveltos-kyverno-policies-base --stage prod --space-pattern template:sveltos-kyverno-policies-prod-eu --target sveltos-targets/prod-eu --allow-exists --quiet
depart sveltos-kyverno-policies-prod-eu clusterprofile '.metadata.name = "kyverno-policies-prod-eu" | .spec.clusterRefs = [{"apiVersion":"lib.projectsveltos.io/v1beta1","kind":"SveltosCluster","namespace":"projectsveltos","name":"prod-eu"}] | .spec.dependsOn = ["kyverno-prod-eu"] | (.spec.policyRefs[] | select(.kind == "ConfigMap" and .namespace == "default" and .name == "kyverno-policies") | .name) = "kyverno-policies-prod-eu"' 'Depart from the base for prod-eu: metadata.name, spec.clusterRefs, spec.dependsOn, spec.policyRefs'
depart sveltos-kyverno-policies-prod-eu configmap-default-kyverno-policies '.metadata.name = "kyverno-policies-prod-eu"' 'prod-eu'\''s own copy of the policies: kyverno-policies-prod-eu'
cub variant create prod-us sveltos-kyverno-policies-base --stage prod --space-pattern template:sveltos-kyverno-policies-prod-us --target sveltos-targets/prod-us --allow-exists --quiet
depart sveltos-kyverno-policies-prod-us clusterprofile '.metadata.name = "kyverno-policies-prod-us" | .spec.clusterRefs = [{"apiVersion":"lib.projectsveltos.io/v1beta1","kind":"SveltosCluster","namespace":"projectsveltos","name":"prod-us"}] | .spec.dependsOn = ["kyverno-prod-us"] | (.spec.policyRefs[] | select(.kind == "ConfigMap" and .namespace == "default" and .name == "kyverno-policies") | .name) = "kyverno-policies-prod-us"' 'Depart from the base for prod-us: metadata.name, spec.clusterRefs, spec.dependsOn, spec.policyRefs'
depart sveltos-kyverno-policies-prod-us configmap-default-kyverno-policies '.metadata.name = "kyverno-policies-prod-us"' 'prod-us'\''s own copy of the policies: kyverno-policies-prod-us'

step "4/6 The management cluster's record: its bootstrap profiles"
cub component create sveltos-management --allow-exists --quiet
cub space create sveltos-management --component sveltos-management --allow-exists --quiet
cub unit create --space sveltos-management bootstrap-ingress-nginx management/ingress-nginx.yaml --target sveltos-targets/mgmt --change-desc 'The bootstrap profiles that point Sveltos at each ingress-nginx variant'\''s releases' --allow-exists --quiet
cub unit update --space sveltos-management bootstrap-ingress-nginx management/ingress-nginx.yaml --change-desc 'The bootstrap profiles for every ingress-nginx variant this plan holds' --quiet
cub unit create --space sveltos-management bootstrap-kyverno management/kyverno.yaml --target sveltos-targets/mgmt --change-desc 'The bootstrap profiles that point Sveltos at each kyverno variant'\''s releases' --allow-exists --quiet
cub unit update --space sveltos-management bootstrap-kyverno management/kyverno.yaml --change-desc 'The bootstrap profiles for every kyverno variant this plan holds' --quiet
cub unit create --space sveltos-management bootstrap-kyverno-policies management/kyverno-policies.yaml --target sveltos-targets/mgmt --change-desc 'The bootstrap profiles that point Sveltos at each kyverno-policies variant'\''s releases' --allow-exists --quiet
cub unit update --space sveltos-management bootstrap-kyverno-policies management/kyverno-policies.yaml --change-desc 'The bootstrap profiles for every kyverno-policies variant this plan holds' --quiet

step "5/6 Release each variant, stage by stage: promote, approve, publish"
cub changeorder create --space sveltos-ingress-nginx-base onboard-c3558924 --change-workflow sveltos-ingress-nginx-base/rollout --description 'First release of sveltos-ingress-nginx-prod-eu, sveltos-ingress-nginx-prod-us' --allow-exists --quiet
if rolled_out sveltos-ingress-nginx-base/onboard-c3558924; then
  echo 'ingress-nginx: every variant in this plan is released'
else
  cub variant promote --change-order sveltos-ingress-nginx-base/onboard-c3558924 --target-stage prod --quiet
  cub variant approve --change-order sveltos-ingress-nginx-base/onboard-c3558924 --stage prod --quiet
  publish sveltos-ingress-nginx-prod-eu sveltos-ingress-nginx-base/onboard-c3558924
  publish sveltos-ingress-nginx-prod-us sveltos-ingress-nginx-base/onboard-c3558924
fi
cub changeorder create --space sveltos-kyverno-base onboard-25e1c3f8 --change-workflow sveltos-kyverno-base/rollout --description 'First release of sveltos-kyverno-staging-eu, sveltos-kyverno-prod-eu, sveltos-kyverno-prod-us' --allow-exists --quiet
if rolled_out sveltos-kyverno-base/onboard-25e1c3f8; then
  echo 'kyverno: every variant in this plan is released'
else
  cub variant promote --change-order sveltos-kyverno-base/onboard-25e1c3f8 --target-stage staging --quiet
  cub variant approve --change-order sveltos-kyverno-base/onboard-25e1c3f8 --stage staging --quiet
  publish sveltos-kyverno-staging-eu sveltos-kyverno-base/onboard-25e1c3f8
  cub variant promote --change-order sveltos-kyverno-base/onboard-25e1c3f8 --target-stage prod --quiet
  cub variant approve --change-order sveltos-kyverno-base/onboard-25e1c3f8 --stage prod --quiet
  publish sveltos-kyverno-prod-eu sveltos-kyverno-base/onboard-25e1c3f8
  publish sveltos-kyverno-prod-us sveltos-kyverno-base/onboard-25e1c3f8
fi
cub changeorder create --space sveltos-kyverno-policies-base onboard-1b86298b --change-workflow sveltos-kyverno-policies-base/rollout --description 'First release of sveltos-kyverno-policies-staging-eu, sveltos-kyverno-policies-prod-eu, sveltos-kyverno-policies-prod-us' --allow-exists --quiet
if rolled_out sveltos-kyverno-policies-base/onboard-1b86298b; then
  echo 'kyverno-policies: every variant in this plan is released'
else
  cub variant promote --change-order sveltos-kyverno-policies-base/onboard-1b86298b --target-stage staging --quiet
  cub variant approve --change-order sveltos-kyverno-policies-base/onboard-1b86298b --stage staging --quiet
  publish sveltos-kyverno-policies-staging-eu sveltos-kyverno-policies-base/onboard-1b86298b
  cub variant promote --change-order sveltos-kyverno-policies-base/onboard-1b86298b --target-stage prod --quiet
  cub variant approve --change-order sveltos-kyverno-policies-base/onboard-1b86298b --stage prod --quiet
  publish sveltos-kyverno-policies-prod-eu sveltos-kyverno-policies-base/onboard-1b86298b
  publish sveltos-kyverno-policies-prod-us sveltos-kyverno-policies-base/onboard-1b86298b
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
k apply -f management/

echo
echo "Done. Sveltos fetches each variant's release within a minute. Watch it with:"
echo "  kubectl get clustersummaries -A"
