#!/usr/bin/env bash
# Onboards the fleet into ConfigHub with cub sveltos, Angel doing the work:
# one variant per cluster for the shop and the platform, the management
# cluster's record delivered from ConfigHub, and continuous health checks.
# Each variant's first release is the onboarding baseline, what the clusters
# run today (confighub#5794); every release after it waits for an approval
# from you or Milton.
#
#   source demo/env.sh && bash $DEMO/setup/onboard.sh             onboard, and release the baselines
#   source demo/env.sh && bash $DEMO/setup/onboard.sh --handover  hand delivery over to ConfigHub
#
# Running it again is safe. Then --handover: scenarios/00-onboard.md.
set -euo pipefail
[ -n "${AI_CHAOS_DIR:-}" ] && [ -n "${CHAOS_RUNS:-}" ] && [ -n "${DEMO:-}" ] || . "$(cd "$(dirname "$0")/.." && pwd)/env.sh"
: "${AI_CHAOS_DIR:?source demo/env.sh first}" "${YOU_ID:?run setup/identities.sh, then source demo/env.sh again}" "${MILTON_ID:?}"
out=$AI_CHAOS_DIR/onboard
mkdir -p "$out" "$AI_CHAOS_DIR/by-name"
for c in staging prod-eu prod-us-1 prod-us-2; do ln -sf "$AI_CHAOS_DIR/chaos-$c.kubeconfig" "$AI_CHAOS_DIR/by-name/$c.kubeconfig"; done
mgmt="kubectl --kubeconfig $AI_CHAOS_DIR/chaos-mgmt.kubeconfig"
if [ ! -f "$out/fleet.yaml" ]; then
  { $mgmt get clusterprofiles,sveltosclusters -A -o yaml; echo "---"; $mgmt -n default get configmap shop -o yaml; } > "$out/fleet.yaml"
fi
approvers=()
for a in ${APPROVERS:-$YOU_ID $MILTON_ID}; do approvers+=(--approver "$a"); done
(cd "$out" && cub sveltos apply fleet.yaml --prefix chaos --class-label env --stage-label env --stages staging,prod \
  --management-release "${approvers[@]}" --out onboard >/dev/null)
cd "$out/onboard"
export KUBECONFIG=$AI_CHAOS_DIR/chaos-mgmt.kubeconfig MGMT_CONTEXT=kind-chaos-mgmt CLUSTER_KUBECONFIGS=$AI_CHAOS_DIR/by-name
if [ "${1:-}" = --handover ]; then
  CUB_CONTEXT=chaos-angel bash handover.sh
else
  propose() {
    CUB_CONTEXT=chaos-angel PROPOSE_ONLY=1 bash apply.sh 2>&1 | tee -a "$AI_CHAOS_DIR/onboard.log" > "$out/last-run.log" || true
    grep -v "confighub#5794" "$out/last-run.log" | grep -E "^== |waits|approve|released|Released|Failed|error" || true
  }
  propose
  # Until ConfigHub fixes confighub#5794, it refuses each variant's first release
  # through the onboarding change order. That first release is then published at
  # head, as the onboarding baseline: what the clusters run today, which the
  # handover checks before it changes anything. The annotation records it.
  # Every release after it goes through a change order and an approval.
  baselines=$(sed -n 's|^  cub release publish \([^ ]*\) --annotation sveltos.confighub.com/first-release=baseline$|\1|p' "$out/last-run.log")
  if [ -n "$baselines" ]; then
    echo "== baselines (confighub#5794)"
    for s in $baselines; do
      CUB_CONTEXT=chaos-angel cub release publish "$s" --annotation sveltos.confighub.com/first-release=baseline --quiet
      echo "$s: first release published at head, as the onboarding baseline"
    done
    propose
  fi
fi
