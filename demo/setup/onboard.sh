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
  log=$AI_CHAOS_DIR/onboard.log run=$out/last-run.log
  # propose: run apply.sh, proposing only. Its whole output goes to the log;
  # the terminal shows its steps, and what waits or failed, as they come.
  propose() {
    : > "$run"
    if ! CUB_CONTEXT=chaos-angel PROPOSE_ONLY=1 bash apply.sh 2>&1 | tee -a "$log" "$run" |
      { grep --line-buffered -v "confighub#5794" | grep --line-buffered -E "^== |waits|approve|released|Released|Failed|error|could not" || true; }; then
      tail -n 5 "$run" >&2; echo "apply.sh stopped; its whole output is in $log" >&2; exit 1
    fi
  }
  # The variants apply.sh says ConfigHub refused a first release.
  refused() { sed -n 's|^  cub release publish \([^ ]*\) --annotation sveltos.confighub.com/first-release=baseline$|\1|p' "$run"; }
  propose
  # Until ConfigHub fixes confighub#5794, it refuses each variant's first release
  # through the onboarding change order. That first release is then published at
  # head, as the onboarding baseline: what the cluster runs today, from the
  # profiles you applied. The annotation records it. Every release after it
  # goes through a change order and an approval.
  baselines=$(refused)
  if [ -n "$baselines" ]; then
    { echo "== baselines (confighub#5794)"
      for s in $baselines; do
        CUB_CONTEXT=chaos-angel cub release publish "$s" --annotation sveltos.confighub.com/first-release=baseline --quiet ||
          { echo "$s: its baseline was not published; run onboard.sh again (the log is $log)"; exit 1; }
        echo "$s: first release published at head, as the onboarding baseline"
      done; } 2>&1 | tee -a "$log"
    propose
    left=$(refused)
    [ -z "$left" ] || { echo "Still without a release: $(echo $left). Run onboard.sh again; the whole output is in $log" >&2; exit 1; }
  fi
fi
