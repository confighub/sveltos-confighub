# Outage 2: half the fleet at once

[The demo](../README.md) · [Outage 1](01-rotation.md) · Outage 2 · next: [Outage 3](03-parity.md)

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
bash $DEMO/setup/reporter.sh log     # live status still flowing: recent lines, every 15 s
bash $DEMO/setup/sandbox.sh --reset  # an empty sandbox
```

`<order>` and the `..._ORDER` values are change order names without their
Space, as Angel's report gives them, or `cub changeorder list --space
chaos-management`. In our verification run they were `withdraw-shop-lockdown`,
`guardrails-profiles-deliver-confighub-releases` and `remove-shop-lockdown`.

| Step | Command |
| --- | --- |
| 1. Devil applies the lockdown by hand | `$R devil 02-blast-radius $P/1-devil-lockdown.txt` |
| Wait about a minute: prod-us-1 and prod-us-2 Degraded, staging and prod-eu Healthy | `cub sveltos status --context kind-chaos-mgmt` |
| 2. Angel proposes the fix, the policy and the clean-up as change orders on `chaos-management/record` | `$R angel 02-blast-radius $P/2-angel-fix-and-prevent.txt` |
| 3. Review, then approve each order | `$A me chaos-management/<order> record "<why>"`, or `$A milton chaos-management/<order> record 02-blast-radius` |
| 3b. Only if the review finds a problem: Angel aborts the orders sent back and proposes them again; then step 3 for the new ones | `SENT_BACK="<the orders>" FINDING="<what you found>" $R angel 02-blast-radius $P/2b-angel-revise.txt` |
| 4. Angel releases them in order | `FIX_ORDER=... POLICY_ORDER=... CLEANUP_ORDER=... $R angel 02-blast-radius $P/3-angel-release.txt` |
| 4a. Only if step 4 stops with HTTP 500 "no Revision found ... TagID": Angel publishes the policy's order, which carries both (below), and stops at the clean-up's approval; then step 4b | `FIX_ORDER=... POLICY_ORDER=... $R angel 02-blast-radius $P/3c-angel-publish-together.txt` |
| 4b. Only if Angel opened the clean-up after the fix: approve it as in step 3, then Angel publishes it | `CLEANUP_ORDER=<order> $R angel 02-blast-radius $P/3b-angel-release-cleanup.txt` |
| 5. Devil tries again | `$R devil 02-blast-radius $P/4-devil-again.txt` |

**Review before approving.** Angel writes the policy, and it takes one of two
forms. Check it the way its form needs.

**If it judges a profile by its shape**, as in our verification run (one
`clusterRef`, a name of the form `<component>-<cluster>`, only the release
delivered), it exempts nobody. The preview gives a verdict for every known case.
Check in the sandbox that it admits every profile the record delivers today,
and refuses the hand-applied one:

```bash
S="kubectl --kubeconfig $AI_CHAOS_DIR/sandbox.kubeconfig"
cub unit data --space chaos-management <the policy's unit> | $S apply -f -
cub unit data --space chaos-management delivery-shop | $S apply --dry-run=server -f -       # admitted
cub unit data --space chaos-management delivery-platform | $S apply --dry-run=server -f -   # admitted
$S apply --dry-run=server -f $DEMO/proof/shop-lockdown.yaml                                 # refused
```

**If it judges by who sends the request**, as in our first run (only Sveltos,
writing for the record, may write profiles), the preview can only answer
"unknown", because a configuration does not say who will send it. Check two
things:

1. **Who Sveltos writes to the management cluster as.** This prints only the
   subject of the token Sveltos holds, never the token:

   ```bash
   bash $DEMO/proof/token-subject.sh kind-chaos-mgmt mgmt mgmt-sveltos-kubeconfig re-kubeconfig
   ```

   With Sveltos v1.15.0 it prints `system:serviceaccount:projectsveltos:projectsveltos`.
   The policy must exempt that identity, not `register-mgmt-cluster`, which is the
   job that registered the cluster. The first run's Angel exempted the wrong
   one, and the review caught it.
2. **The policy's logic, in the sandbox, by impersonation.**
   - Apply the policy and bind it.
   - Give Sveltos's identity cluster-admin, in the sandbox only.
   - Try the hand-applied profile as yourself (refused), and as Sveltos's
     identity (allowed). Then delete it as Sveltos (allowed).

   ```bash
   S="kubectl --kubeconfig $AI_CHAOS_DIR/sandbox.kubeconfig"
   cub unit data --space chaos-management <the policy's unit> | $S apply -f -
   $S create clusterrolebinding test-projectsveltos --clusterrole=cluster-admin --serviceaccount=projectsveltos:projectsveltos
   $S apply -f $DEMO/proof/shop-lockdown.yaml                                                          # refused
   $S apply -f $DEMO/proof/shop-lockdown.yaml --as=system:serviceaccount:projectsveltos:projectsveltos # allowed
   $S delete clusterprofile shop-lockdown --as=system:serviceaccount:projectsveltos:projectsveltos     # allowed
   ```

Either way, empty the sandbox afterwards: `bash $DEMO/setup/sandbox.sh --reset`.
Milton is told to check the same things. If a check fails, do not approve:
send the order back with step 3b.

**If the fix will not publish on its own.** A release pinned to a change
order bundles every unit at the order's end tag. A unit created after that tag
has no revision there, and the publish fails with HTTP 500 ("no Revision found
for Unit ... with the specified TagID"), although `cub release publish --help`
says such a unit falls back to its head revision. In our verification run,
the policy's unit came after the fix's tag. Angel then published the policy's
order instead, which carries both units, and both were already approved: that
is step 4a. Angel aborts the fix's order with the reason.

Angel may propose the clean-up as a third order to open once the fix is applied.
Step 4 allows for that: set `CLEANUP_ORDER` to the words "the clean-up order
you will open after the fix". Angel then opens it and stops at its approval,
and step 4b releases it.

What you should see:
- **After step 2:** two or three change orders wait at `record`: the fix, the
  policy, and maybe the clean-up. Angel may propose the clean-up for after the
  fix instead.
- **After step 4 (or 4b):**
  - prod-us-1 and prod-us-2 are Healthy again;
  - the policy and its binding are on the management cluster;
  - the stray profile and its ConfigMap are gone, deleted by the record under
    the policy.
- **After step 5:** both of Devil's profile writes are refused at admission,
  with the message of the policy Angel wrote. In our first run it read
  "profiles on the management cluster come only from the record". In the
  verification run it read "ClusterProfile shop-prod-eu must name its one
  cluster". The policy covers profiles, not ConfigMaps, so Devil deletes the
  ConfigMap it created.

Next: [Outage 3, staging said yes, prod said no](03-parity.md). To check what ConfigHub recorded, see [PROOF.md](../PROOF.md).
