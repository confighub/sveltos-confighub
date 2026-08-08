# Brief: the Sveltos fleet example in the Kubara style

Status: proposal, 2026-08-06. This brief exists so the build session starts from decisions, not archaeology.

## Purpose

Give Sveltos the same treatment Kubara received: a working reference implementation we operate, a governed change story with receipts, screenshots from the live system, and a simple DIY path where a reader brings their own clusters. Kubara answers "how do I govern the platform one cluster at a time"; Sveltos answers "how do I govern one change across a fleet." Together they cover the two shapes every platform team has.

## What exists today

- `examples/sveltos/kyverno-fleet`: a reviewed `ClusterProfile` delivered through ConfigHub, with a committed live receipt, a pilot-wave variant, and a source lock. The Space carries an approval gate because it changes cluster-wide admission policy.
- A live two-wave rollout proof (`data/sveltos-oci-delivery-proof`): the reviewed profile selected only clusters labeled `rollout=pilot`, Argo reconciled the portable OCI digest on the management cluster, Sveltos installed Kyverno on the pilot cluster first, and the second wave followed by label change alone.
- Six npm lanes covering example verify, hub record and verify, and the OCI delivery run.

The pilot-wave mechanics are proven live. The fleet reference implementation, the scenario set, and the story are not built.

## Reference implementation

One kind management cluster running Sveltos and Argo CD, plus a labeled workload fleet (pilot, staging, and two production clusters — reusing the retained-cluster discipline from the Kubara work). ConfigHub stores every `ClusterProfile` and chart configuration as governed Units delivered as immutable OCI digests to the management cluster; Sveltos fans them out by label. We operate it, its receipts are committed, and readers verify rather than trust — the same contract as the Kubara reference deployment.

## The scenario set

Each scenario is one chapter with its own machine checkpoint, in this order:

1. **Kyverno across the fleet** (exists; becomes chapter one). Admission policy delivered fleet-wide with an approval gate, because policy is the clearest "you want review before this hits every cluster" story.
2. **Canary by label** (half-proven; formalize the existing two-wave proof). Wave one goes to `rollout=pilot` clusters, the receipt proves convergence, and promotion to the remaining clusters is a governed ConfigHub operation, not a label edit nobody reviewed.
3. **Fleet rollout through environments.** One change in the base, promoted pilot to staging to production groups, with a per-cluster observed matrix in the Kubara matrix style showing exactly which cluster runs which revision.
4. **CVE patching.** The money story: a chart version bump packaged as an exact reviewed revision, promoted through the waves, with receipts proving every cluster converged on the patched digest and none was missed. This is fleet patch day with evidence instead of hope.
5. **Bulk operations.** One governed change fanning to many clusters, and ConfigHub set-aware bulk commands across many Spaces, closed by a zero-drift audit — the "change it once, prove it everywhere" claim.

## DIY and bring-your-own

The reference fleet is kind, but nothing in the path requires it. The DIY chapter mirrors the Kubara run-your-own section: deterministic self-tests against fake surfaces first (to be built in the importer's style), then bring your own clusters — kind, CAPI, or real — label them, install Sveltos on your management cluster, log the cub CLI into your own organization, and copy the example request files. Honest status labels stay until each step earns its live proof.

## Proof ladder and boundaries

1. Self-tests against fake Git, OCI, and ConfigHub surfaces.
2. Config-plane and workload live proofs on the kind fleet: unlike GPU platforms, Kyverno and the fleet scenarios are fully provable on kind — convergence, health, policy admission behavior, and the changed/no-op idempotence pair ported from the Kubara reconciler discipline.
3. Boundaries stated in every receipt: the CVE chapter demonstrates governed patch delivery, not vulnerability scanning — no scanner integration is claimed. Quota discipline applies: fleet proofs run serially against the organization, never in parallel.

## First increment

Stand up the reference fleet and re-record the existing kyverno and two-wave proofs against it with the Kubara-style receipt discipline (source commit binding, idempotence pair, orphan audit). That converts today's strongest asset into chapter one and chapter two of the tutorial with no new mechanics. The matrix, CVE, and bulk chapters follow the playbook from there.
