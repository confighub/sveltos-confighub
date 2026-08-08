# Sveltos environment rollout

This is chapter three of the Sveltos fleet example. Chapters one and two
delivered one reviewed `ClusterProfile` and expanded its selector from a pilot
cluster to a second cluster. This chapter promotes one reviewed change through
environment groups: pilot first, then staging, then two production clusters.

## The design

The reference fleet is one management cluster and four workload clusters. The
[fleet design](fleet.yaml) labels one cluster `environment=pilot`, one
`environment=staging`, and two `environment=prod`.

Each environment keeps its own governed record: a `ClusterProfile` that selects
only its environment label, stored in its own ConfigHub Space with the same
approval policy the earlier chapters used. The three profiles start from one
shared baseline values document, so the only reviewed difference between
environments is the selector.

The [change candidate](change-candidate.yaml) is one values edit: it raises
`backgroundController.replicas` from 1 to 2 in the Kyverno 3.8.1 chart. The
change lands in the pilot record first. After the pilot converges, the same
reviewed content is promoted to the staging record, then to the production
record. Version bumps are deliberately out of scope here; they belong to the
CVE patching chapter.

## The matrix

The per-cluster matrix shows exactly which cluster runs which revision at four
checkpoints: the baseline and the state after each wave. It follows the Kubara
matrix discipline: expected evidence comes from the reviewed files, observed
evidence only ever comes from a live run, and empty cells stay empty until a
run earns them.

- [matrix.csv](../../../data/sveltos-env-rollout/matrix.csv)
- [matrix.md](../../../data/sveltos-env-rollout/matrix.md)
- [matrix.html](../../../data/sveltos-env-rollout/matrix.html)

## Current status

No live run has been recorded. On the current server the approval gate never
appears in a Unit's `ApplyGates` from the Space trigger-filter wiring, so the
approval boundary cannot be observed live. That defect is tracked in
confighubai/confighub#4975. The offline surfaces below are deterministic and
verified in the repository gate; every observed cell in the matrix stays
honestly empty until the live proof runs.

The live runner is drafted in
`scripts/run-sveltos-env-rollout-proof.mjs` and stays behind that blocker on
purpose. Before it builds anything it probes the approval gate on a throwaway
Space and Unit; while the defect stands, the probe refuses in seconds and
names the issue, instead of failing after the seven-minute fleet build. Its
self-test proves the whole governance walk offline: six approval brackets
across the three environments, a distinct OCI digest per revision, and a
receipt bound to the reviewed example files. Once the receipt is recorded,
the matrix generator fills the observed columns from it.

## Chapter four

The [CVE patching example](../cve-patch/README.md) continues from this
chapter's outcome: one reviewed chart version bump with digest-bound
provenance, promoted through the same environment groups, closed by a
coverage audit that proves no cluster was missed.

## Repeat and verify

```bash
# Rebuild the matrix surfaces from the reviewed example files. A few seconds.
node scripts/generate-sveltos-env-rollout.mjs --generate

# Verify the committed surfaces and the example invariants.
npm run sveltos-env-rollout:verify

# Deterministic self-test: fixture compile, tamper refusals, and the
# self-contained HTML contract. No account, cluster, or network access.
npm run sveltos-env-rollout:self-test

# Deterministic self-test of the drafted live runner: the gate preflight,
# all six approval brackets, and the receipt tamper battery, against fake
# ConfigHub and OCI surfaces. A few seconds.
npm run sveltos-env-rollout-proof:self-test
```

The live proof follows the two-wave runner's discipline: a self-contained
kind fleet, one approval bracket per environment revision, portable OCI
digests reconciled by Argo CD, Sveltos convergence per environment group, and
a convergence audit at the end. Fleet proofs run serially against the
organization, never in parallel. To find out whether the server fix has landed, run the two-minute probe. It
wires one throwaway Space, creates one probe Unit, watches for the approval
gate, and cleans up after itself. One passing probe unblocks every drafted
fleet lane.

```bash
CUB_CONTEXT=my-policy npm run sveltos-gate:probe
```

Once confighubai/confighub#4975 is resolved,
the run is one command:

```bash
HELM_EXPT_ALLOW_LIVE_SVELTOS_ENV_ROLLOUT=1 \
HELM_EXPT_ALLOW_SCRATCH_ORG=1 \
CUB_CONTEXT=my-policy \
SVELTOS_CLUSTER_CONTEXT=my-scratch \
npm run sveltos-env-rollout-proof:run

# Then refresh the summary and the observed matrix columns.
npm run sveltos-env-rollout-proof:generate
npm run sveltos-env-rollout:generate
```
