# Outage 2: half the fleet at once

Someone applies a ClusterProfile by hand on the management cluster, outside
ConfigHub. It selects `region=us`, which is two of the four clusters, and
blocks all traffic into the shop there. kind's default network enforces
NetworkPolicy.

- **The fix:** the management record takes the stray profile over, makes it
  match no cluster, and then removes it.
- **The prevention:** an admission policy on the management cluster,
  delivered through the record. A ClusterProfile or Profile may be written
  only by the record's release.

```bash
source demo/env.sh
R="bash $DEMO/agents/run-agent.sh"; A="bash $DEMO/approve.sh"; P=$DEMO/prompts/02-blast-radius
```

| Step | Command |
| --- | --- |
| 1. Devil applies the lockdown by hand | `$R devil 02-blast-radius $P/1-devil-lockdown.txt` |
| Wait about a minute: prod-us-1 and prod-us-2 Degraded, staging and prod-eu Healthy | `cub sveltos status --context kind-chaos-mgmt` |
| 2. Angel proposes the fix, the policy and the clean-up as change orders on `chaos-management/record` | `$R angel 02-blast-radius $P/2-angel-fix-and-prevent.txt` |
| 3. Review, then approve each order | `$A me chaos-management/<order> record "<why>"`, or `$A milton chaos-management/<order> record 02-blast-radius` |
| 4. Angel releases them in order | `FIX_ORDER=... POLICY_ORDER=... CLEANUP_ORDER=... $R angel 02-blast-radius $P/3-angel-release.txt` |
| 5. Devil tries again | `$R devil 02-blast-radius $P/4-devil-again.txt` |

**Review before approving.** The policy decides on who sends the request.
Angel's preview can only answer "unknown" for each known case, because a
configuration does not say who will send it. Check two things yourself:

1. **Who Sveltos writes to the management cluster as.** This prints only the
   subject of the token Sveltos holds, never the token:

   ```bash
   bash $DEMO/proof/token-subject.sh kind-chaos-mgmt mgmt mgmt-sveltos-kubeconfig re-kubeconfig
   ```

   With Sveltos v1.15.0 it prints `system:serviceaccount:projectsveltos:projectsveltos`.
   The policy must exempt that identity, not `register-mgmt-cluster`, which is the
   job that registered the cluster. Our recording's Angel exempted the wrong
   one, and the review caught it.
2. **The policy's logic, in the sandbox, by impersonation.**
   - Apply the policy and bind it.
   - Give the identities cluster-admin in the sandbox only.
   - Try the hand-applied profile as yourself (refused), and as Sveltos's identity (allowed).

   ```bash
   S="kubectl --kubeconfig $AI_CHAOS_DIR/sandbox.kubeconfig"
   cub unit data --space chaos-management <the policy's unit> | $S apply -f -
   $S create clusterrolebinding test-projectsveltos --clusterrole=cluster-admin --serviceaccount=projectsveltos:projectsveltos
   $S apply -f $DEMO/proof/shop-lockdown.yaml                                                          # refused
   $S apply -f $DEMO/proof/shop-lockdown.yaml --as=system:serviceaccount:projectsveltos:projectsveltos # allowed
   $S delete clusterprofile shop-lockdown --as=system:serviceaccount:projectsveltos:projectsveltos     # allowed
   ```

Milton is told to do the same: its instructions cover the token-subject helper
and testing by impersonation in the sandbox. If a check fails, do not approve.
Tell Angel what you found, and have it abort the order with the reason and
propose it again.

**If the fix will not publish on its own.** A release pinned to a change
order bundles every unit at the order's end tag. A unit created after that tag
has no revision there, and the publish fails with HTTP 500 ("no Revision found
for Unit ... with the specified TagID"), although `cub release publish --help`
says such a unit falls back to its head revision. In our verification run,
the policy's unit came after the fix's tag. Angel then published the policy's
order instead, which carries both units, and both were already approved. Have
Angel abort the fix's order with the reason.

Angel may propose the clean-up as a third order to open once the fix is applied.
The release prompt allows for that: set `CLEANUP_ORDER` to the words "the
clean-up order you will open after the fix".

What you should see:
- **After step 4:**
  - prod-us-1 and prod-us-2 are Healthy again;
  - the policy and its binding are on the management cluster;
  - the stray profile and its ConfigMap are gone, deleted by the record under
    the policy.
- **After step 5:** both of Devil's writes are refused at admission, with
  "profiles on the management cluster come only from the record".
