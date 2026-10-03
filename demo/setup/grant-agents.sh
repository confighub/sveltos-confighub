#!/usr/bin/env bash
# Spaces Angel creates are Angel's to manage. This grants the other identities
# what they need on every chaos-* Space:
#   reporter  View, ViewChildren, Edit                  (writes live status)
#   devil     View, ViewChildren, Edit, EditChildren    (changes things, as real life does)
#   milton    View, ViewChildren, ApproveChildren, UseChildren
#             (reviews; approves when you let it: approving a change order
#             needs Use on it, and the approval needs ApproveChildren)
# Devil, Angel and the reporter never get ApproveChildren. Run it as yourself after
# onboarding, and again whenever Angel creates a Space (chaos-policies, for one).
#
#   bash $DEMO/setup/grant-agents.sh
set -euo pipefail
[ -n "${AI_CHAOS_DIR:-}" ] || . "$(cd "$(dirname "$0")/.." && pwd)/env.sh"
bot() { cub worker get --space chaos-agents "$1" -o jq=.BridgeWorker.UserID | tr -d '"\n'; }
reporter=$(bot reporter)
devil=$(bot devil)
milton=$(bot milton)
for s in $(cub space list --where "Slug LIKE 'chaos-%' AND Slug != 'chaos-agents'" -o 'jq=.[].Space.Slug' | tr -d '"'); do
  cub space update "$s" --quiet \
    --permission "View:$reporter" --permission "ViewChildren:$reporter" --permission "Edit:$reporter" \
    --permission "View:$devil" --permission "ViewChildren:$devil" --permission "Edit:$devil" --permission "EditChildren:$devil" \
    --permission "View:$milton" --permission "ViewChildren:$milton" --permission "ApproveChildren:$milton" --permission "UseChildren:$milton"
  echo "$s: reporter, devil and milton granted"
done
