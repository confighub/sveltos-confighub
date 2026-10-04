# Outage 3: staging said yes, prod said no

Prod departs from staging in a way nobody declared: `api`'s memory limit is
cut in prod only. Later a change that passes staging is OOMKilled in prod.

- **The fix:** prod realigned with staging.
- **The prevention:** prod's release requires a parity check. Prod may differ
  from staging only where a guard `departure=<why>` declares the difference,
  and the check names any other difference before release.

Devil plays the people whose ordinary changes add up to the outage. Each change
goes through the workflow, and each is in front of you before you approve it.

```bash
source demo/env.sh
R="bash $DEMO/agents/run-agent.sh"; A="bash $DEMO/approve.sh"; P=$DEMO/prompts/03-parity
bash $DEMO/setup/reporter.sh log     # live status still flowing: recent lines, every 15 s
bash $DEMO/setup/sandbox.sh --reset  # an empty sandbox
```

`<the cut>`, `<the cache>` and the other placeholders are change order names
without their Space. Each agent's report names its orders, and so does
`cub changeorder list --space chaos-shop-base`. In our first run they were
`api-memory-limit-40mi-prod`, `api-response-cache`,
`api-memory-limit-restore-128mi-prod` and `api-memory-limit-96mi-prod`.

| Step | Command |
| --- | --- |
| 1. Devil, on call, cuts prod's `api` memory limit to 40Mi | `$R devil 03-parity $P/1-devil-cut.txt` |
| 2. Approve it for prod (read each prod unit's diff first) | `$A me chaos-shop-base/<the cut> prod "<why>"` or `$A milton chaos-shop-base/<the cut> prod 03-parity devil` |
| 2b. Only if the cut is refused and you end the outage here: Devil withdraws it | `CUT_ORDER=<the cut> REASON="<why it was refused>" $R devil 03-parity $P/1b-devil-withdraw-refused.txt` |
| 3. Devil publishes it; then, as a developer, adds a 32 MiB cache to `api` | `CUT_ORDER=<the cut> $R devil 03-parity $P/2-devil-publish-and-cache.txt` |
| 4. Approve the cache for staging | `$A me chaos-shop-base/<the cache> staging "<why>"` or Milton, with `devil` as the requester |
| 5. Devil releases it to staging, measures it, and promotes it to prod | `CACHE_ORDER=<the cache> $R devil 03-parity $P/3-devil-staging.txt` |
| 6. Approve the cache for prod | `$A me chaos-shop-base/<the cache> prod "<why>"` or Milton |
| 7. Devil releases it to prod | `CACHE_ORDER=<the cache> $R devil 03-parity $P/4-devil-prod.txt` |
| Wait two or three minutes: prod's `api` OOMKilled, live status flapping Degraded | `cub sveltos status --context kind-chaos-mgmt` |
| 8. Angel diagnoses, proposes the fix, and proposes the gate | `$R angel 03-parity $P/5-angel-fix.txt` |
| 9. Approve the fix for prod | `$A me chaos-shop-base/<the restore> prod "<why>"` or Milton |
| Check Angel's ParityCheck passed in every prod Space | `cub attestation list --space chaos-shop-prod-eu`, and the same for `chaos-shop-prod-us-1` and `-us-2` |
| 10. Add the parity gate, as yourself (below) | `cub changeworkflow update ...` |
| 11. Angel releases the fix, one prod cluster at a time | `RESTORE_ORDER=<the restore> $R angel 03-parity $P/6-angel-release.txt` |
| 12. Devil tries again: 96Mi in prod only | `$R devil 03-parity $P/7-devil-again.txt` |
| 13. Angel runs the parity check on Devil's order | `DEVIL_ORDER=<Devil's order> $R angel 03-parity $P/8-angel-check.txt` |
| 14. Devil withdraws | `DEVIL_ORDER=<Devil's order> $R devil 03-parity $P/9-devil-withdraw.txt` |

**Step 10, the gate.** Workflow edits take effect at once and are not
versioned, so you make this one, never an agent. Only Angel's ParityCheck
counts, so nobody can record a pass by hand:

```bash
ANGEL_ID=$(cub worker get --space chaos-agents angel -o jq=.BridgeWorker.UserID | tr -d '"')
cub changeworkflow update rollout --space chaos-shop-base \
  --attestation-prerequisite approval --attestation-prerequisite parity \
  --attestation-prerequisite-type parity=ParityCheck --attestation-prerequisite-count parity=1 \
  --attestation-prerequisite-allow-authors parity=true --attestation-prerequisite-from-user-ids "parity=$ANGEL_ID" \
  --stage-release-prerequisites 'prod=approval;parity' --dry-run
```

Drop `--dry-run` once the output keeps the approval rule as it was and puts
`parity` on prod alone.

**If Milton refuses the cut at step 2.** Our verification run's Milton did:
lowering only the limit saves no cost, and staging never ran it. It is meant to
catch that. To stage the outage anyway, approve step 2 by hand. To end the
outage there instead, run step 2b with Milton's reasons as `REASON`, and stop.

What you should see:
- **Step 1:** the change order's own summary may show "no changes". Devil
  edited the class base before opening the order, so the edit rides into prod
  as a prior revision. The prod units' diff shows it.
- **Step 3:** prod's `api` runs at 40Mi, healthy. The cache's order waits for
  approval at staging.
- **Step 5:** staging holds at about 46 MiB under 128Mi: staging said yes.
  The cache's order waits for approval at prod.
- **Step 7:** about a minute later prod's `api` passes 40Mi and is OOMKilled,
  again every minute or so: prod said no.
- **Step 8:** Angel's fix passes `cub sveltos check --parity-with staging`,
  recorded as a ParityCheck in each prod Space.
- **Step 11:** each prod cluster gets new `api` pods at 128Mi, 2 of 2, with no
  restarts for three minutes, and its live status turns Healthy before Angel
  moves to the next. If the gate is already on (step 10), these releases pass
  it with Angel's ParityChecks from step 8.
- **Step 12:** the publish is refused with "requires approval ... requires
  parity".
- **Step 13:** the check fails on each prod Space, naming the field:
  `limits.memory is "96Mi" here and "128Mi" in chaos-shop-staging`.
- **Step 14:** Devil's order is aborted with its reason, and the four units are
  back at 128Mi. The prod units may still be flagged "Unreleased changes" and
  "Stale": ConfigHub counts revisions, not content.
