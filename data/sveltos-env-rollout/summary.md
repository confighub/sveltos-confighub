# ConfigHub promotes one change through a fleet it maps cluster by cluster

This run starts with four workload clusters and a management cluster. ConfigHub
holds one reviewed base record and one variant per cluster, so the answer to
which cluster runs which revision comes from ConfigHub rather than from a
selector on a cluster. Each variant carries its own departures from the base,
and its clusterRefs entry names its own cluster and nothing else.

The ChangeWorkflow `rollout-20260926190447` was created from the reviewed
[change-workflow.yaml](../../examples/sveltos/env-rollout/change-workflow.yaml).
Its stages are pilot, then staging, then prod. Every stage after the
first is entered only once every variant of the stage ahead has released the
change (its `Released` gate), and every
stage's releases need one Approval attestation. The base
and its four variants sit in the run's own component
`sveltos-kyverno-env-rollout-20260926190447`, and the management record in a component of its
own.

Every variant's baseline went through the `baseline-20260926190447` change
order, which carries no change to the base, stage by stage, so every release
that reached a cluster in this run passed the approval gate.

One reviewed change raises `backgroundController.replicas` from 1 to
2 on the base record, and the change order
`bg-replicas-20260926190447` captured it. Before wave one, ConfigHub itself
refused to promote the change into staging while
pilot had not released it:

> Failed: unable to promote to stage 'staging', Variant 'hx-sveltos-env-pilot' has not taken change order 'bg-replicas-20260926190447'

Every wave was one of the stages. `cub variant promote --change-order` moved
exactly the change into the variants the stage selects, and the release was
attempted before anyone approved it. ConfigHub refused it, in wave one in
these words:

> Failed: HTTP 422 for req uAtoUyOVHtDcmurpEufRwQUIyBgdaxjM: unable to publish a release of change order 'bg-replicas-20260926190447' in stage 'pilot': requires approval: 1 Approval attestation(s) from eligible attesters; clusterprofile revision 4 has 0 of 1

One `cub variant approve --change-order … --stage …` then recorded the
approval of the change as it stood in the stage, an attestation on each
variant's exact revision, and each variant published the release its change
order arrived at. Sveltos fetched each release itself from
`oci://oci.hub.confighub.com/space/<space>:latest` on a
1m0s interval. The Healthy gate is not declared: nothing
reports Sveltos's view of a cluster to ConfigHub yet, so the checkpoints below
are the observed-health evidence.

This single-operator demo relaxes separation of duties: its approval requirement sets AllowAuthors: true, so the operator who promoted a change may also approve it. A production workflow sets AllowAuthors: false and has a second approver sign off, because ConfigHub counts whoever promoted a change into a Space as one of its authors there and does not count an author's approval. Measured on
2026-09-26, the strict setting
refused the promoter's own approval:

> unable to publish a release of change order '<change-order>' in stage '<stage>': requires approval: 1 Approval attestation(s) from eligible attesters who did not write the change; <unit> revision <n> has 0 of 1

The management record holds one bootstrap profile per workload Space. It was
applied out of band with kubectl, because it is the record that opens the
gateway path, and its approval is an attestation that nothing server-side
gates. Promotion never touched it. Publishing a new release moved the tag, and
Sveltos followed it.

| Wave | Cluster | Space | Departure kept through the change | Changed release digest | Sveltos |
| --- | --- | --- | --- | --- | --- |
| 1 | hx-sveltos-env-pilot | hx-sveltos-env-pilot-20260926190447 | `spec.stopMatchingBehavior=WithdrawPolicies` | `sha256:1c4e2d25fed05bab963cc3bb7a94b4c9a5a5ef09040eda70989dca32e19541d9` | Provisioned |
| 2 | hx-sveltos-env-staging | hx-sveltos-env-staging-20260926190447 | `spec.stopMatchingBehavior=WithdrawPolicies` | `sha256:b228b240cbc3e1aa3afcd399b32112a4e89cf4eebaadce5e719d2b003da628cf` | Provisioned |
| 3 | hx-sveltos-env-prod-a | hx-sveltos-env-prod-a-20260926190447 | `spec.stopMatchingBehavior=LeavePolicies` | `sha256:b369e8cf46d2bd7d60d61ae619d25f6603764507ad2074d4fee38fa5cd1c1370` | Provisioned |
| 3 | hx-sveltos-env-prod-b | hx-sveltos-env-prod-b-20260926190447 | `spec.stopMatchingBehavior=LeavePolicies` | `sha256:9f89dabe95a5b4ba83ced395d81d11c5443006f098ea3a2af9448c005462e8c4` | Provisioned |

| Wave | Stage | Entry gate ConfigHub checked | Releases before and after the approval |
| --- | --- | --- | --- |
| 1 | pilot | none; the first stage's gates are never evaluated | 1 refused, then 1 released |
| 2 | staging | Released over the pilot stage | 1 refused, then 1 released |
| 3 | prod | Released over the staging stage | 2 refused, then 2 released |

No wave's approval was requested on a schedule. Each one was unlocked by the
preceding checkpoint showing every cluster it depends on reporting healthy,
and each wave records that evidence:

| Wave | Unlocked by checkpoint | Clusters observed healthy there |
| --- | --- | --- |
| 1 | `baseline` (baseline) | hx-sveltos-env-pilot, hx-sveltos-env-staging, hx-sveltos-env-prod-a, hx-sveltos-env-prod-b |
| 2 | `after-wave-1` (pilot) | hx-sveltos-env-pilot |
| 3 | `after-wave-2` (staging) | hx-sveltos-env-staging |

| Check | Result |
| --- | --- |
| Checkpoints observed | 4/4 |
| Clusters at their own changed revision after wave 3 | 4/4 |
| Convergence audit | pass |
| Addon controller image | `docker.io/projectsveltos/addon-controller:v1.15.0` |
| Cleanup | Artifacts kept deliberately |
| Release targets | one Target per cluster, named for it |

The per-cluster matrix in [matrix.md](matrix.md) and
[matrix.html](matrix.html) shows which cluster ran which revision at each
checkpoint.

## Limits

- The pinned Sveltos controllers were installed directly as a prerequisite on the throwaway management cluster.
- The reviewed ClusterProfiles, not the Sveltos controller installation, were delivered through ConfigHub and its OCI gateway.
- The management record was applied out of band with kubectl, because it is the record that opens the gateway path.
- The gateway serves each release as a gzipped tar layer, and the pinned release's own addon controller gunzips it, so the run installed the manifest's images as released. The image it ran is recorded above.
- The management cluster read the gateway with the operator's own ConfigHub token, taken once at the start of the run and removed with the clusters.
- The proof used four local kind workload clusters. It does not prove a large production fleet or a failure-and-pause rollout.
- The proof covers one reviewed values change to this Kyverno base, not a chart version bump.
- The ChangeWorkflow declares Released and not Healthy, because nothing reports Sveltos's view of a cluster to ConfigHub yet. The observed-health evidence is the runner's own checkpoints.
- This single-operator demo relaxes separation of duties: its approval requirement sets AllowAuthors: true, so the operator who promoted a change may also approve it. A production workflow sets AllowAuthors: false and has a second approver sign off, because ConfigHub counts whoever promoted a change into a Space as one of its authors there and does not count an author's approval.
- Declared on the run's component to state that its promotions and releases go through this workflow. Measured on 2026-09-26, ConfigHub does not yet refuse a plain publish of one of its Spaces outside a change order, so every release in this run goes through a change order because the runner sends it there, not because the server would refuse the other path.
- The management record is applied out of band with kubectl, because it is what opens the gateway path, and no release of it is published, so no release gate reads its approval. It is recorded as an attestation all the same, and nothing server-side gates it.

- [Committed receipt](../../runs/sveltos-env-rollout-proof/receipt.yaml)
- [Reviewed base profile](../../examples/sveltos/env-rollout/clusterprofile-base.yaml)
- [Reviewed variants](../../examples/sveltos/env-rollout/variants.yaml)
- [Reviewed change candidate](../../examples/sveltos/env-rollout/change-candidate.yaml)
- [Reviewed change workflow](../../examples/sveltos/env-rollout/change-workflow.yaml)
