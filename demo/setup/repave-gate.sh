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
# The class bases and variants run chaos-shop-base's triggers because ConfigHub
# set their WhereTrigger to that Space when it cloned them. A unit that fails
# one gets a ValidationError, and ConfigHub publishes no release of it until
# the change, or the list, is fixed. Like a workflow, the
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
      ConfigMap/*/*|Secret/*/*) echo "$item: a name has no /" >&2; exit 2 ;;
      ConfigMap/?*|Secret/?*) ;;
      *) echo "$item: name each item as ConfigMap/<name> or Secret/<name>" >&2; exit 2 ;;
    esac
  done
  set -- $(printf '%s\n' "$@" | awk '!seen[$0]++')    # each item once
fi
# slug <Kind/name>: the trigger that checks one item, restores-<kind>-<name>,
# with a dot in the name written -dot-, so a.b and a-b do not collide.
slug() { printf 'restores-%s-%s' "$(printf '%s' "${1%%/*}" | tr 'A-Z' 'a-z')" "$(printf '%s' "${1#*/}" | sed 's/\./-dot-/g')"; }
gate=$(cub trigger list --space "$space" -o 'jq=[.[] | (.Trigger // .).Slug | select(. == "restores" or startswith("restores-"))] | join(" ")' | tr -d '"')
if [ "$1" = --off ]; then
  for t in $gate; do cub trigger delete --space "$space" "$t" --quiet; done
  echo "$space: the repave gate is off"; exit 0
fi
# Each trigger is made again in turn, the new one right after the old one goes;
# those no longer on the list go last. A failure stops the script, saying so:
# run it again.
make() { # make <slug> <function> <args...>
  local t=$1; shift
  case " $gate " in *" $t "*) cub trigger delete --space "$space" "$t" --quiet ||
    { echo "$space: could not remove the old trigger $t; run this again" >&2; exit 1; } ;; esac
  cub trigger create --space "$space" --quiet -- "$t" Mutation Kubernetes/YAML "$@" ||
    { echo "$space: could not make the trigger $t; run this again" >&2; exit 1; }
}
list=$(IFS=,; echo "$*")
make restores vet-starlark "$(cat "$DEMO/setup/restores.star")" "--param=restores=$list"
keep=" restores "
for item in "$@"; do
  kind=${item%%/*} name=${item#*/} t=$(slug "$item")
  keep="$keep$t "
  if [ "$kind" = ConfigMap ]; then
    make "$t" where-filter v1/ConfigMap "metadata.name = '$name'"
    echo "$space: $item is restored by the release, which must hold it"
  else
    make "$t" where-filter batch/v1/Job "metadata.labels.repave-makes = 'secret.$name'"
    echo "$space: $item is restored by a Job in the release, labelled repave-makes: secret.$name"
  fi
done
for t in $gate; do
  case $keep in *" $t "*) ;; *)
    cub trigger delete --space "$space" "$t" --quiet ||
      { echo "$space: could not remove $t, which is no longer on the list; run this again" >&2; exit 1; }
    echo "$space: $t removed, no longer on the list" ;; esac
done
echo "$space: the repave gate is on, for it and every Space that runs its triggers"
