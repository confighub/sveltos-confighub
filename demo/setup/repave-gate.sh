#!/usr/bin/env bash
# The repave gate, as yourself: what a repave brings back of the shop, kept by
# ConfigHub. It is a set of triggers in chaos-shop-base, which the shop's class
# bases and variants run too, and ConfigHub checks every change against them:
#   restores                   every Secret and ConfigMap a workload uses is
#                              on the restore list (setup/restores.star);
#   restores-configmap-<name>  the unit holds that ConfigMap;
#   restores-secret-<name>     the unit holds the Job that makes that Secret,
#                              labelled repave-makes: secret.<name>. A Secret's
#                              value is never in ConfigHub: a fresh cluster
#                              makes its own.
# A unit that fails one gets a ValidationError, and ConfigHub publishes no
# release of it until the change, or the list, is fixed. Like a workflow, the
# gate is yours: the agents may not touch triggers.
#
#   source demo/env.sh && bash $DEMO/setup/repave-gate.sh ConfigMap/shop-code Secret/shop-token
#   source demo/env.sh && bash $DEMO/setup/repave-gate.sh --off
#
# Running it again replaces the list. --space <space> puts the gate on another
# Space instead, as proof/repave-gate-check.sh does.
set -euo pipefail
[ -n "${AI_CHAOS_DIR:-}" ] && [ -n "${CHAOS_RUNS:-}" ] && [ -n "${DEMO:-}" ] || . "$(cd "$(dirname "$0")/.." && pwd)/env.sh"
space=chaos-shop-base
if [ "${1:-}" = --space ]; then space=${2:?--space needs a Space}; shift 2; fi
[ $# -gt 0 ] || { echo "usage: bash repave-gate.sh ConfigMap/<name>|Secret/<name>... | --off" >&2; exit 2; }
if [ "$1" != --off ]; then
  for item in "$@"; do
    case $item in
      ConfigMap/?*|Secret/?*) ;;
      *) echo "$item: name each item as ConfigMap/<name> or Secret/<name>" >&2; exit 2 ;;
    esac
  done
fi
for t in $(cub trigger list --space "$space" -o 'jq=[.[] | (.Trigger // .).Slug | select(. == "restores" or startswith("restores-"))] | join(" ")' | tr -d '"'); do
  cub trigger delete --space "$space" "$t" --quiet
done
if [ "$1" = --off ]; then echo "$space: the repave gate is off"; exit 0; fi
list=$(IFS=,; echo "$*")
cub trigger create --space "$space" --quiet -- restores Mutation Kubernetes/YAML vet-starlark \
  "$(cat "$DEMO/setup/restores.star")" "--param=restores=$list"
for item in "$@"; do
  kind=${item%%/*} name=${item#*/}
  slug="restores-$(printf '%s-%s' "$kind" "$name" | tr 'A-Z.' 'a-z-')"
  if [ "$kind" = ConfigMap ]; then
    cub trigger create --space "$space" --quiet -- "$slug" Mutation Kubernetes/YAML where-filter v1/ConfigMap "metadata.name = '$name'"
    echo "$space: $item is restored by the release, which must hold it"
  else
    cub trigger create --space "$space" --quiet -- "$slug" Mutation Kubernetes/YAML where-filter batch/v1/Job "metadata.labels.repave-makes = 'secret.$name'"
    echo "$space: $item is restored by a Job in the release, labelled repave-makes: secret.$name"
  fi
done
echo "$space: the repave gate is on, for it and every Space that runs its triggers"
