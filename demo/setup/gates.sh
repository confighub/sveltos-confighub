#!/usr/bin/env bash
# The gates the agents work under, set after onboarding, as yourself:
#   - chaos-shop and chaos-platform accept changes only through their rollout;
#   - the management record (chaos-management) gets its own workflow, record,
#     and accepts changes only through it, so nobody publishes it directly;
#   - every release needs an approval from you or Milton, never from the
#     change's author.
#
#   source demo/env.sh && bash $DEMO/setup/gates.sh
#
# For manual approvals only, run it with APPROVERS=$YOU_ID; for Milton only,
# APPROVERS=$MILTON_ID. The default counts either.
set -euo pipefail
approvers=${APPROVERS:-"${YOU_ID:?source demo/env.sh after setup/identities.sh} ${MILTON_ID:?}"}
for c in shop platform; do
  cub component update --patch "chaos-$c" --change-workflow-required --allowed-change-workflow "chaos-$c-base/rollout" --quiet
  echo "chaos-$c: changes only through chaos-$c-base/rollout"
done
workflow=$(mktemp)
{
  echo "# The management cluster's record: a change to the delivery profiles, or to"
  echo "# the policies on the management cluster, is released only with an approval"
  echo "# from a named approver, and never from the change's author."
  echo "AttestationPrerequisites:"
  echo "  - Name: approval"
  echo "    Type: Approval"
  echo "    Count: 1"
  echo "    AllowAuthors: false"
  echo "    FromUserIDs:"
  for a in $approvers; do echo "      - $a"; done
  echo "Stages:"
  echo "  - Name: record"
  echo "    WhereSpace: \"Slug = 'chaos-management'\""
  echo "    ReleasePrerequisites:"
  echo "      - approval"
} > "$workflow"
cub changeworkflow create --space chaos-management record --filename "$workflow" --allow-exists --quiet
rm -f "$workflow"
cub component update --patch chaos-management --change-workflow-required --allowed-change-workflow chaos-management/record --quiet
echo "chaos-management: changes only through chaos-management/record, approved by: $approvers"
