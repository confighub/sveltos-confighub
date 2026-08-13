# Sveltos bulk operations

One reviewed edit raises the Kyverno background controller across the whole
fleet in a single operation, and every per-cluster record still clears its
own approval gate before any cluster sees the change. This is chapter five,
the change-it-once claim, and it closes with an audit that looks for drift
everywhere and finds none.

[Sveltos](https://projectsveltos.io) selects the clusters and installs the
add-on; ConfigHub holds the reviewed record, gates it, and publishes the
approved revision as an OCI image that Sveltos fetches. The runner pins
Sveltos v1.13.0 and expects the addon controller build that decompresses
gzipped layers, which the ConfigHub gateway serves.

## Why this chapter exists

Changing one setting everywhere is where fleets quietly diverge. A cluster is
missed, a record is edited by hand afterwards, or one environment is left
behind a gate nobody looked at. The claim here is not that the change reached
every cluster. It is that the same reviewed bytes are in every record, that
no record slipped through unapproved, and that a cluster which drifts is
pulled back.

## See the result

The [matrix](../../../data/sveltos-bulk-ops/matrix.md) shows every cluster at
three checkpoints: the baseline, the state after the fan-out, and the
zero-drift audit with its repair results. The receipt will live at
`runs/sveltos-bulk-ops-proof/receipt.yaml`.

Neither is recorded yet. The runner delivers through the ConfigHub OCI
gateway, the way chapter three was recorded, and no live run of this chapter
has been recorded on that path. Every observed cell in the matrix stays
honestly empty until one is.

## How it works

ConfigHub holds the fleet the way the earlier chapters hold it: one reviewed
[base record](clusterprofile-base.yaml) carrying what every cluster shares,
and one [variant per cluster](variants.yaml), each a clone linked to the base
that departs only on its own name, its own single-cluster selector, and its
own drift-handling behavior. Each record lives in its own ConfigHub Space
with an approval gate.

The [bulk change candidate](bulk-change.yaml) raises
`backgroundController.replicas` from 2 to 3. The edit is made once, on the
base record, and approved there. One set operation
(`cub unit update --patch --space "*" --where <query> --upgrade`) then
inherits it into every variant at once, with each variant keeping its own
departures. Nothing is promoted in waves: the whole fleet is one wave.

Each record then clears its own bracket: the gate arms with no approval on
file, one set approval binds each record to its own exact head revision, the
gate clears with that approval recorded, and each Space publishes a release.
One bootstrap `ClusterProfile` per workload Space points Sveltos at that
Space on the gateway
(`oci://oci.hub.confighub.com/space/<space>:latest`), and Sveltos fetches
each release itself and sends the reviewed profile to the one cluster that
variant addresses.

The fan-out is one reviewed edit and one set upgrade across the Spaces. It is
also four recorded approvals and four publishes, because every approval binds
one cluster's variant to its own revision and each Space publishes its own
release. The receipt records those counts rather than rounding them in either
direction.

The bootstrap profiles never change. Publishing a release moves the tag, and
Sveltos follows it on its interval.

## The zero-drift audit

The chapter closes with the prove-it-everywhere audit, in four parts.

1. A set-aware query across the Spaces
   (`cub unit list --space "*" --where "Labels.Proof = 'sveltos-bulk-ops' AND LEN(ApplyGates) > 0"`)
   must find no record still blocked behind an armed gate.
2. Every record is re-read: its revision and content hash must be exactly
   what was approved, so nothing changed out of band.
3. The inherited values must be byte-identical across the four variant
   records.
4. Drift is injected on every cluster, by scaling the background controller
   down by hand, and Sveltos must repair all four.

## The design

The chapter reuses the reference fleet from chapters three and four: one
management cluster and four workload clusters grouped as pilot, staging, and
two production clusters, defined in the
[shared fleet design](../env-rollout/fleet.yaml).

The baseline continues chapter four's outcome. The base record sits at
Kyverno chart 3.8.2 carrying the values the earlier chapters promoted, and the
repository gate enforces that continuity.

## The matrix

The matrix follows the same discipline as the earlier chapters: expected
evidence comes from the reviewed files, observed evidence only ever comes from
a live run, and empty cells stay empty until a run earns them.

- [matrix.csv](../../../data/sveltos-bulk-ops/matrix.csv)
- [matrix.md](../../../data/sveltos-bulk-ops/matrix.md)
- [matrix.html](../../../data/sveltos-bulk-ops/matrix.html)

## Repeat and verify

```bash
# Deterministic self-test of the matrix generator: fixture compile,
# continuity and fan-out refusals, and the receipt-fill path.
npm run sveltos-bulk-ops:self-test

# Deterministic self-test of the live runner: the Sveltos pin, the addon
# controller image override, the lowercase Space and Secret type refusals the
# gateway imposes, the gate preflight, one base record and four variants
# approved as one baseline set, one fan-out set operation that inherits the
# edit into every variant, the set-aware gate query with a rogue armed gate
# detected, and the tamper battery.
npm run sveltos-bulk-ops-proof:self-test
```

Confirm the approval wiring first. The probe wires one throwaway Space,
creates one probe Unit, watches for the approval gate, and cleans up after
itself:

```bash
CUB_CONTEXT=my-policy npm run sveltos-gate:probe
```

Then record the run. One authenticated context is enough, because no cluster
Spaces are created:

```bash
HELM_EXPT_ALLOW_LIVE_SVELTOS_BULK_OPS=1 \
CUB_CONTEXT=my-policy \
SVELTOS_ADDON_CONTROLLER_IMAGE=docker.io/projectsveltos/addon-controller:v1.13.0-ch \
npm run sveltos-bulk-ops-proof:run

# Then refresh the summary and the observed matrix columns.
npm run sveltos-bulk-ops-proof:generate
npm run sveltos-bulk-ops:generate
```

The run builds its own kind fleet, installs the pinned Sveltos, and removes
every cluster and Space it created. Fleet proofs run serially against the
organization, never in parallel.
