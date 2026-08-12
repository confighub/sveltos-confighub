# Sveltos on ConfigHub

This repository shows how a cluster fleet is governed through
[ConfigHub](https://confighub.com) and delivered by
[Sveltos](https://projectsveltos.io): the reviewed record stays the input,
every approved revision is published as an OCI image, and Sveltos fetches
that image and sends it to the clusters it selects.

[Sveltos](https://projectsveltos.io) is an open-source Kubernetes add-on
controller. It runs on one management cluster, selects workload clusters by
label, and installs and reconciles what those clusters should run. It
deliberately does not solve the GitOps problem, so it pairs with whatever
holds the configuration. Here that is ConfigHub.

The runs in this repository pin **Sveltos v1.13.0**
([manifest](examples/sveltos/env-rollout/source-lock.yaml)). Reading a
release from the ConfigHub gateway additionally needs an addon controller
that decompresses gzipped layers, which is
`projectsveltos/addon-controller:v1.13.0-ch` until that fix ships in a
release. The [gateway probe](docs/planning/remote-url-oci-probe.md) measured
both, and every receipt records the image its run used.

This is the fleet companion to
[kubara-confighub](https://github.com/confighub/kubara-confighub), which
governs a platform one cluster at a time. This repository governs one change
across many clusters.

## What the delivery path is

1. Config comes from ConfigHub, where a reviewed record is stored, checked,
   and held at an approval gate.
2. A named person approves one exact revision, and ConfigHub publishes it as
   an OCI image on its OCI gateway.
3. Sveltos on the management cluster fetches that image and sends the
   reviewed profile to every cluster its selector matches.
4. Sveltos keeps those clusters aligned and repairs drift.

No GitOps controller and no intermediate registry take part. Promotion does
not change the delivery wiring at all: publishing the approved release moves
the tag, and the fleet follows, so approval alone moves the fleet.

## Why we did this

Fleet tools can move configuration to many clusters. The harder question is
what reached them and who agreed to it. Three answers here are unusual
enough to be the point of the repository.

- **The rollout definition is itself reviewed configuration.** A wave is a
  label selector inside the record, not a pipeline object beside it, so
  widening a rollout is a diff that goes through the same approval as any
  other change and lands at a new digest.
- **Approval binds to an exact revision.** It is not a sync button and not a
  paused bundle. Approving yesterday's revision authorises nothing about
  today's, and the bytes that shipped are the bytes that were approved.
- **The matrix keeps four facts apart** that a status page usually collapses
  into one green tick: which revision each cluster should run, which release
  was published, what the controller fetched, and what Kubernetes reports.

## See the result first

Chapter three moved one reviewed values change from pilot to staging to
production. Every wave has its own approval bracket, and the
[per-cluster matrix](data/sveltos-env-rollout/matrix.md) shows which cluster
ran which revision at each of the four checkpoints. The
[receipt](runs/sveltos-env-rollout-proof/receipt.yaml) records six approval
brackets, the release digest per wave, the gateway reference per
environment, and the controller image that read them.

Chapters one and two are recorded in the
[two-wave proof](data/sveltos-oci-delivery-proof/summary.md): ConfigHub held
a pilot profile until its exact revision was approved, and one approved
selector change added the second cluster at a new digest.

The [fleet rehearsal](examples/sveltos/fleet-rehearsal/README.md) proves the
delivery machinery on a five-cluster fleet with no ConfigHub account at all,
and records its phase timings.

## The five chapters

1. **[Kyverno across the fleet](examples/sveltos/kyverno-fleet/README.md)**
   installs admission policy through a reviewed record with an approval
   gate. Recorded live.
2. **The canary**, in the same example: the reviewed profile selected only
   the pilot cluster, and one approved selector change added the second
   cluster at a new OCI digest. Recorded live.
3. **[Environment rollout](examples/sveltos/env-rollout/README.md)** promotes
   one reviewed values change pilot to staging to production. Recorded live.
4. **[CVE patching](examples/sveltos/cve-patch/README.md)**: one reviewed
   version bump with digest-bound provenance, closed by a coverage audit
   that proves no cluster was missed. No vulnerability scanning is claimed.
   Drafted and proven offline.
5. **[Bulk operations](examples/sveltos/bulk-ops/README.md)**: one reviewed
   edit fans out to every record in one pass, closed by a zero-drift audit.
   Drafted and proven offline.

Chapters four and five are not recorded yet. Chapter four's runner now carries
the gateway path chapter three recorded and waits only on a live run. Chapter
five's runner still carries the delivery path chapter three replaced. Every
observed cell in both matrices stays empty until each run happens.

## How to run it

Every check runs with no account, no cluster, and no network, and the
repository has no npm dependencies:

```bash
git clone https://github.com/confighub/sveltos-confighub
cd sveltos-confighub
npm run verify
```

The fleet rehearsal builds its own clusters and needs no ConfigHub account:

```bash
HELM_EXPT_ALLOW_LIVE_SVELTOS_REHEARSAL=1 npm run sveltos-fleet-rehearsal:run
```

The governed chapters need the `cub` CLI and one authenticated context.
Install it with `curl -fsSL https://hub.confighub.com/cub/install.sh | bash`,
then `cub auth login`. Confirm the approval wiring before building a fleet:

```bash
CUB_CONTEXT=my-policy npm run sveltos-gate:probe
```

Then record chapter three:

```bash
HELM_EXPT_ALLOW_LIVE_SVELTOS_ENV_ROLLOUT=1 \
CUB_CONTEXT=my-policy \
SVELTOS_ADDON_CONTROLLER_IMAGE=docker.io/projectsveltos/addon-controller:v1.13.0-ch \
npm run sveltos-env-rollout-proof:run
```

The recorded runs used the maintainers' catalog organization, which owns the
approval policy space and trigger filter the runners check for. In another
organization, create that wiring first from
[the committed policy](config-catalog/policies/catalog-standard.yaml). Each
runner checks its preconditions and stops early with a named reason instead
of failing after the fleet build. Fleet proofs run serially, never in
parallel.

Requirements: node 22 or newer, python3 with pyyaml, and tar. The live lanes
additionally use cub, docker, kind, kubectl, helm, curl, and oras.

## What this does not claim

It does not claim a cumulative failure budget, an automated verification
step between stages, a timeout on a stalled wave, or a single action that
halts and reverses a rollout across the fleet. Rollback here restores one
target to an exact revision, which is a different thing.

## Provenance

This work was extracted from
[confighub/helm-expt](https://github.com/confighub/helm-expt) with paths
preserved, so every committed receipt verifies here unchanged. The planning
brief is [docs/planning/sveltos-fleet-brief.md](docs/planning/sveltos-fleet-brief.md)
and the one-page story is
[docs/demo/sveltos/fleet-chapters.md](docs/demo/sveltos/fleet-chapters.md).
