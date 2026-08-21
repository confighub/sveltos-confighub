# ConfigHub holds one cluster back on purpose

This run continues the recorded chapter-three fleet: the same five clusters,
the same Spaces, the same records. It creates nothing. One reviewed change
advances every cluster from 2 to
3 background replicas. Then one production
cluster, hx-sveltos-env-prod-a, is restored to its exact pre-advance revision
with `cub unit update --space hx-sveltos-env-prod-a-20260821140804 clusterprofile --restore 4`. The approval gate arms on the restored head like
on any other revision, the publish is refused while it is unapproved, and
only the recorded approval lets the older digest ship again. Its twin,
hx-sveltos-env-prod-b, stays on the newer release the whole time.

A second reviewed change then moves the fleet to
4 replicas. The restored cluster's variant
rides the same set upgrade and is then simply not approved. The hold is the
absence of that one approval, nothing more. Sveltos keeps serving the
restored release, the gate stays armed on the pending head, and the cluster
stays where the operator put it.

The closing audit shows the fleet at three different points on purpose,
every one a recorded fact:

| Cluster | Environment | Head revision | Released digest | Background replicas | State |
| --- | --- | --- | --- | --- | --- |
| hx-sveltos-env-pilot | pilot | 6 | `sha256:1093b15c38d4d2c24d24d4e9e59ccbc8fd162e0515f718aebe99f9b097f480cd` | 4 | advanced |
| hx-sveltos-env-staging | staging | 6 | `sha256:e69c1c79e8e7606739dd2dd219899b730f8b218c1a98f6f2f76f48493cc6575d` | 4 | advanced |
| hx-sveltos-env-prod-a | prod | 7 | `sha256:916145d87591cf65fa8a33b0a0227440264681b5a5863820413041705cfdc505` | 2 | held-at-restored-revision |
| hx-sveltos-env-prod-b | prod | 6 | `sha256:211aeb54d8ae4550548f9ee743e36915f2b81b997b7e567bf4100b3b0a0143dd` | 4 | advanced |

Gate evidence on the restore:

- Before approval the restored head carried the armed `platform/require-approval/vet-approvedby` gate with no approval.
- `cub release publish hx-sveltos-env-prod-a-20260821140804` was refused while unapproved.
- After one recorded approval the publish went through, and Sveltos pulled the older digest.

Gate evidence on the hold:

- hx-sveltos-env-prod-a carries pending head revision 7 with the `platform/require-approval/vet-approvedby` gate armed and no approval on it.
- The released tag still names the restored revision's digest `sha256:916145d87591cf65fa8a33b0a0227440264681b5a5863820413041705cfdc505`.
- The cluster was observed holding at 2 replicas after the rest of the fleet moved to 4.

## Limits

- This chapter created no clusters and no Spaces. It continued the chapter-three cohort and left it standing.
- The restore moved one cluster to one exact earlier revision through the same approval gate as every advance. It is not a single action that halts and reverses a rollout across the fleet.
- The hold is the absence of one approval on one variant's pending head revision. No new mechanism was added to hold it.
- The pending head's merged content is recorded as observed, not asserted, because a local change to the same field a base change writes wins the merge silently in the recorded ConfigHub finding.
- The held cluster's released tag was not re-read from the registry; the evidence is the recorded publish, the unapproved gate on the pending head, the live profile still matching the restored revision, and the cluster's observed state.
- The reviewed ClusterProfiles were delivered through ConfigHub and its OCI gateway by the cohort's standing wiring. This chapter installed nothing on any cluster.
- The proof used the cohort's four local kind workload clusters. It does not prove a large production fleet.

- [Committed receipt](../../runs/sveltos-held-cluster-proof/receipt.yaml)
- [Reviewed change candidate](../../examples/sveltos/held-cluster/change-candidate.yaml)
- [Reviewed restore candidate](../../examples/sveltos/held-cluster/restore-candidate.yaml)
- [The cohort this run continues](../../runs/sveltos-env-rollout-proof/receipt.yaml)
