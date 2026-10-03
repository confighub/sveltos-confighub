# Outage 1: a rotation nobody picked up

The shop's token Secret is rotated outside ConfigHub, the way a secret store or
a security team would do it. `api` reads the token from a mounted file and
picks up the new value. `web` read it once, from its environment, at start, so
it keeps the old one and its readiness check fails on every cluster.

- **The fix:** `web` restarts whenever the Secret changes, through a Reloader
  annotation.
- **The prevention:** an admission policy on every cluster. A Deployment that
  takes a Secret through its environment must say how it picks up a rotation.

Each step is one command. `R` runs an agent; `A` approves, by you or Milton.
Change order names are the ones the agents choose: each agent's report names
them, and so does `cub changeorder list --space <base space>`.

```bash
source demo/env.sh
R="bash $DEMO/agents/run-agent.sh"; A="bash $DEMO/approve.sh"; P=$DEMO/prompts/01-rotation
```

| Step | Command |
| --- | --- |
| 1. Devil rotates the token on all four clusters | `$R devil 01-rotation $P/1-devil-rotate.txt` |
| Wait about a minute, until the shop is Degraded everywhere | `cub sveltos status --context kind-chaos-mgmt` |
| 2. Angel diagnoses and proposes the fix | `$R angel 01-rotation $P/2-angel-fix.txt` |
| 3. Angel writes the policy and previews it | `FIX_ORDER=<the fix> $R angel 01-rotation $P/3-angel-prevent.txt` |
| Let Milton see the new Space chaos-policies | `bash $DEMO/setup/grant-agents.sh` |
| 4. Approve the fix for staging | `$A me chaos-shop-base/<the fix> staging "<why>"` or `$A milton chaos-shop-base/<the fix> staging 01-rotation` |
| 5. Angel releases it to staging | `FIX_ORDER=<the fix> $R angel 01-rotation $P/4-angel-release-staging.txt` |
| 6. Approve the policy for staging | `$A me chaos-platform-base/<the policy> staging "<why>"` or `$A milton ...` |
| 7. Angel releases the policy to staging, and promotes both to prod | `GUARD_ORDER=<the policy> $R angel 01-rotation $P/5-angel-release-guardrails-staging.txt` |
| 8. Devil tries again, on staging | `$R devil 01-rotation $P/6-devil-again.txt` |
| 9. Approve both for prod | `$A me chaos-shop-base/<the fix> prod "<why>"` and `$A me chaos-platform-base/<the policy> prod "<why>"`, or Milton |
| 10. Angel releases both to prod, fix first | `FIX_ORDER=<the fix> GUARD_ORDER=<the policy> $R angel 01-rotation $P/7-angel-release-prod.txt` |

What you should see:
- **After step 1:** each cluster's live status is Degraded, naming `shop/web`.
- **After step 3:** Angel's preview shows that the policy would refuse `web` as
  it runs today, on all four clusters, and nothing once the fix is in. So the
  fix must be released before the policy.
- **After step 8:**
  - the rotation is picked up by Reloader, and `web` stays 2/2;
  - Devil's `web-copy`, which takes the token from its environment without an
    annotation, is refused at admission by the policy;
  - `cub sveltos status` stays Healthy.
- **After step 10:** all four clusters are Healthy.
- **Proof:** `bash $DEMO/proof/evidence.sh` lists each approval, with who
  recorded it and the note, and each release with who published it.
