#!/usr/bin/env bash
# One approval, by you or by Milton.
#
#   bash $DEMO/approve.sh me     <base space>/<order> <stage> "<your words>"
#   bash $DEMO/approve.sh milton <base space>/<order> <stage> <run-name> [agent]
#
# "me" records your approval with your words as its note. "milton" has Milton
# review the change order against the last request in that run (Angel's by
# default, or the agent named; or REQUEST, when set) and approve it, or say
# why not.
set -euo pipefail
[ -n "${AI_CHAOS_DIR:-}" ] || . "$(cd "$(dirname "$0")" && pwd)/env.sh"
here=$(cd "$(dirname "$0")" && pwd)
who=$1 order=$2 stage=$3
case $who in
  me)
    note=${4:?say why you approve, in your own words}
    cub variant approve --change-order "$order" --stage "$stage" --note "$note" ;;
  milton)
    run=${4:?name the run whose request Milton reviews}
    REQUEST=${REQUEST:-$(bash "$here/agents/last-request.sh" "$run" "${5:-angel}")} ORDER=$order STAGE=$stage \
      bash "$here/agents/run-agent.sh" milton "$run" "$here/prompts/milton-review.txt" || exit 1
    bash "$here/agents/last-request.sh" "$run" milton ;;
  *) echo "who approves: me or milton" >&2; exit 2 ;;
esac
