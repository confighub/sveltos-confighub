# Sveltos fleet rehearsal

The governed fleet chapters should not meet their cluster machinery for the
first time on patch day. This rehearsal runs the delivery path they share,
today, with no ConfigHub account, so the day confighubai/confighub#4975
closes the only untested piece is the approval boundary itself.

## What it runs

One command builds a five-cluster kind fleet (one management cluster, four
workload clusters registered by environment label), installs Argo CD from
the [pinned upstream manifest](source-lock.yaml) and Sveltos v1.12.0 from
the chapter-one source lock, and then drives the shared machinery:

1. Kyverno converges on all four clusters from portable OCI digests
   reconciled by Argo CD.
2. A demo application (podinfo, pinned in the source lock) rides the same
   rails to all four clusters with a different replica count per
   environment, so the per-environment fan-out is visible in the app
   itself.
3. A values change lands on the pilot cluster alone; the other three hold
   their state.
4. A chart version bump lands on the pilot alone with the values intact.
5. Drift injected on the pilot is repaired by Sveltos.

The receipt records phase timings, so it also measures what this machine can
carry before a real recording day.

## The boundary

No review, approval, or promotion is claimed and no ConfigHub organization
is touched. Argo CD comes from the pinned upstream manifest instead of
`cub cluster up`, and Applications are applied with kubectl instead of being
delivered as ConfigHub Units. The receipt states these differences, its
verifier refuses a receipt that claims governance, and no chapter matrix
cell is ever filled by a rehearsal.

## The recorded run

The [committed receipt](../../../runs/sveltos-fleet-rehearsal/receipt.yaml)
and the [summary with phase timings](../../../data/sveltos-fleet-rehearsal/summary.md)
record the first rehearsal on the reference machine.

## Run it

```bash
# Deterministic self-test first: the revision ladder, the portable OCI
# round trip, the Argo pin refusal, and the receipt contract. Seconds.
npm run sveltos-fleet-rehearsal:self-test

# The live rehearsal. It creates its own clusters and registry, records
# the receipt with timings, and cleans up. Expect twenty to forty minutes.
HELM_EXPT_ALLOW_LIVE_SVELTOS_REHEARSAL=1 npm run sveltos-fleet-rehearsal:run

# Verify the recorded receipt offline.
npm run sveltos-fleet-rehearsal:verify
```
