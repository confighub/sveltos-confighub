# Sveltos with ConfigHub: govern one change across a fleet

Change one reviewed record and every selected cluster follows it, with an
approval boundary and a committed receipt at each step. That is the claim
this repository proves, chapter by chapter, and refuses to overstate.

The fleet looks like this. A platform team manages a management cluster
running Sveltos and Argo CD, and workload clusters grouped as pilot,
staging, and production.
[ConfigHub](https://confighub.com) keeps every reviewed record and its
approval history, OCI carries
exact digests, and Sveltos selects clusters by label and reconciles them.
Each chapter of this repository makes one operational claim and backs it with
a machine-checked matrix, a receipt contract, and deterministic self-tests.

This is the fleet companion to
[kubara-confighub](https://github.com/confighub/kubara-confighub), which
governs the platform one cluster at a time. This repository governs one
change across many clusters.

## The five chapters

1. **[Kyverno across the fleet](examples/sveltos/kyverno-fleet/README.md)**
   installs admission policy through a reviewed record with an approval
   gate. Recorded live.
2. **The canary**, in the same example: the reviewed profile selected only
   the pilot cluster, and one approved selector change added the second
   cluster at a new OCI digest. Recorded live in the
   [two-wave proof](data/sveltos-oci-delivery-proof/summary.md).
3. **[Environment rollout](examples/sveltos/env-rollout/README.md)** promotes
   one reviewed values change pilot to staging to production, with a
   [per-cluster matrix](data/sveltos-env-rollout/matrix.md).
4. **[CVE patching](examples/sveltos/cve-patch/README.md)**: one reviewed
   version bump with digest-bound provenance, closed by a coverage audit
   that proves no cluster was missed. No vulnerability scanning is claimed.
   The [matrix](data/sveltos-cve-patch/matrix.md) tracks chart versions.
5. **[Bulk operations](examples/sveltos/bulk-ops/README.md)**: one reviewed
   edit fans out to every record in one pass, closed by a zero-drift audit
   with a set-aware query across the Spaces. The
   [matrix](data/sveltos-bulk-ops/matrix.md) shows all three checkpoints.

The chapters share one fleet design and hand their state forward, and the
verify chain enforces that continuity mechanically.

## What is proven today

Chapters one and two are recorded live. The
[fleet rehearsal](examples/sveltos/fleet-rehearsal/README.md) proves the
delivery machinery end to end on a five-cluster kind fleet with a committed
receipt and phase timings: Kyverno converged everywhere from portable OCI
digests, a demo application delivered with per-environment replica counts, a
values change and a version bump landed on the pilot alone, and injected
drift repaired. Run it yourself with
`npm run sveltos-fleet-rehearsal:run`; it needs the live tools below and no
ConfigHub account.

Chapters three, four, and five are fully drafted and proven
offline; their live recordings wait on one server defect
(confighubai/confighub#4975), each is one command once it closes, and every
observed matrix cell stays honestly empty until then. That defect tracker is
not public, so this repository carries its own answer: the probe below
reports in about two minutes whether the defect still stands. It stood at
the last probe on 2026-08-08.

```bash
# Two minutes answers whether the server fix has landed.
CUB_CONTEXT=my-policy npm run sveltos-gate:probe
```

The governed lanes talk to ConfigHub through the `cub` CLI. Install it with
`curl -fsSL https://hub.confighub.com/cub/install.sh | bash`, then run
`cub auth login`. The recorded runs used the maintainers' catalog
organization, which owns the approval policy space and trigger filter the
runners check for. In another organization, create that wiring first from
[the committed policy](config-catalog/policies/catalog-standard.yaml); each
runner checks its preconditions and stops early with a named reason instead
of failing after the fleet build.

## Run the offline proofs

Every check runs without an account, cluster, or network, and the
repository has zero npm dependencies:

```bash
git clone https://github.com/confighub/sveltos-confighub
cd sveltos-confighub
npm run verify
```

Requirements: node 22 or newer, python3 with pyyaml, and tar. The live lanes
additionally use cub, docker, kind, kubectl, helm, curl, and oras; each
example README documents its own live command and its consent gates.

## Provenance

This work was extracted from
[confighub/helm-expt](https://github.com/confighub/helm-expt) with paths
preserved, so every committed receipt verifies here unchanged. The planning
brief is [docs/planning/sveltos-fleet-brief.md](docs/planning/sveltos-fleet-brief.md)
and the one-page story is
[docs/demo/sveltos/fleet-chapters.md](docs/demo/sveltos/fleet-chapters.md).
