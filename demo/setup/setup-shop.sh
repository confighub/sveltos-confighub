#!/usr/bin/env bash
# Puts the shop and its platform on the chaos fleet the way a Sveltos user
# would, before ConfigHub: one ClusterProfile on the management cluster
# delivers the shop's objects from a ConfigMap to every staging and prod
# cluster, and another installs Stakater Reloader 2.2.18. The shop's token
# Secret is made in each cluster directly, standing in for an external secret
# store, so Sveltos never delivers it and a rotation is not undone.
#
#   source demo/env.sh && bash $DEMO/setup/setup-shop.sh
set -euo pipefail
[ -n "${AI_CHAOS_DIR:-}" ] && [ -n "${CHAOS_RUNS:-}" ] && [ -n "${DEMO:-}" ] || . "$(cd "$(dirname "$0")/.." && pwd)/env.sh"
here=$(cd "$(dirname "$0")" && pwd)
dir=${AI_CHAOS_DIR:-$HOME/ai-chaos}
mgmt="$dir/chaos-mgmt.kubeconfig"
clusters=(staging prod-eu prod-us-1 prod-us-2)

echo "== the token, made in each cluster (not by Sveltos)"
for c in "${clusters[@]}"; do
  k="kubectl --kubeconfig $dir/chaos-$c.kubeconfig"
  $k create namespace shop --dry-run=client -o yaml | $k apply -f - >/dev/null
  if ! $k -n shop get secret shop-token >/dev/null 2>&1; then
    $k -n shop create secret generic shop-token --from-literal=token="$(openssl rand -hex 16)" >/dev/null
  fi
  echo "$c: shop-token present"
done

echo "== the profile on the management cluster"
kubectl --kubeconfig "$mgmt" -n default create configmap shop --from-file=shop.yaml="$here/../app/shop.yaml" --dry-run=client -o yaml | kubectl --kubeconfig "$mgmt" apply -f -
kubectl --kubeconfig "$mgmt" apply -f - <<'YAML'
apiVersion: config.projectsveltos.io/v1beta1
kind: ClusterProfile
metadata:
  name: shop
spec:
  clusterSelector:
    matchExpressions:
    - {key: env, operator: In, values: [staging, prod]}
  syncMode: Continuous
  policyRefs:
  - {kind: ConfigMap, namespace: default, name: shop}
YAML

echo "== waiting for the shop to be ready everywhere"
for c in "${clusters[@]}"; do
  k="kubectl --kubeconfig $dir/chaos-$c.kubeconfig"
  for i in $(seq 1 60); do $k -n shop get deployment web >/dev/null 2>&1 && break; sleep 3; done
  $k -n shop rollout status deployment/api --timeout=180s >/dev/null
  $k -n shop rollout status deployment/web --timeout=180s >/dev/null
  echo "$c: api $($k -n shop get deploy api -o jsonpath='{.status.readyReplicas}')/2, web $($k -n shop get deploy web -o jsonpath='{.status.readyReplicas}')/2 ready"
done

echo "== the platform: Reloader in every cluster"
kubectl --kubeconfig "$mgmt" apply -f "$here/../app/platform-profile.yaml" >/dev/null
for c in "${clusters[@]}"; do
  k="kubectl --kubeconfig $dir/chaos-$c.kubeconfig"
  for i in $(seq 1 100); do [ "$($k -n reloader get deploy -o jsonpath='{.items[0].status.readyReplicas}' 2>/dev/null)" = 1 ] && break; sleep 3; done
  echo "$c: reloader $($k -n reloader get deploy -o jsonpath='{.items[0].status.readyReplicas}' 2>/dev/null || echo 0)/1 ready"
done
