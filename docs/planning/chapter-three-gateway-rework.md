# Chapter three on the gateway path

The environment rollout runner still delivers the way the first recordings
did: `cub cluster up` builds a management cluster carrying Argo CD, each
approved revision is re-pushed to a temporary registry as a portable OCI, and
an Argo Application carries it to the management cluster. The
[gateway proof](remote-url-oci-probe.md) removed the need for every one of
those steps. This brief says what the runner becomes.

## What the run looks like after the rework

One authenticated context, the maintained policy organization. No scratch
organization, because no cluster Spaces are created.

1. Build the kind fleet directly, the way the
   [fleet rehearsal](../../examples/sveltos/fleet-rehearsal/README.md) does:
   one management cluster and four workload clusters registered by
   environment label.
2. Install Sveltos from the pinned manifest, and register the management
   cluster with itself so it can receive profiles.
3. Put the ConfigHub token in a Secret on the management cluster, named
   `confighub-gateway`, of type `addons.projectsveltos.io/cluster-profile`,
   with the token under the `token` key.
4. For each environment, wire its policy Space with the approval filter and a
   release target, store the reviewed `ClusterProfile`, watch the gate arm
   with no approval on file, approve the exact head revision, watch the gate
   clear with the approval recorded, and publish the release.
5. Apply one bootstrap `ClusterProfile` per environment to the management
   cluster, selecting it by `role: management`, whose `policyRefs` carry a
   `remoteURL` pointing at that environment's Space on the gateway:
   `oci://oci.hub.confighub.com/space/<space>:latest`.
6. Sveltos fetches the release from the gateway and applies the reviewed
   profile, which selects the workload clusters for that environment and
   converges them.
7. Promotion changes nothing about the bootstrap profile. The reviewed Unit
   is updated, gated, approved, and published again. The tag serves the new
   release, Sveltos notices on its interval, and the environment follows.

## Consequences for the code

Delete `installArgo` if present, `addApplication`, `updateApplication`,
`waitForApplication`, `configureAnonymousOci`, `publishPortableOci`,
`startRegistry`, and the management Space and its OCI target. Delete the
scratch-context requirement and the `HELM_EXPT_ALLOW_SCRATCH_ORG` gate.

Add a gateway reference helper, the management self-registration and token
Secret from the rehearsal, a bootstrap profile builder, and a
`waitForRemoteDeploy` that watches the bootstrap ClusterSummary and confirms
the reviewed profile arrived.

`reviewHeadRevision` keeps the whole approval bracket and its private
release, and returns the gateway reference and the release manifest digest
instead of a portable OCI record.

## Two constraints the gateway imposes

OCI repository names are lowercase, so every Space name that will be
published must be lowercase. The runner's run identifiers currently carry an
ISO timestamp with `T` and `Z`, which must become lowercase before it is
used in a Space name.

The gateway serves each release as a gzipped tar layer, so the addon
controller must be one that gunzips. Released v1.13.0 does not; the build
carrying the gzip fix does. The runner should record which controller image
it ran, and refuse with a clear message if the fetch fails in the way an
un-fixed controller fails.

## What the receipt records

The approval bracket per environment exactly as today, plus the gateway
reference, the release manifest digest per wave, the controller image, and
the per-cluster observations. It must not claim a temporary registry or any
GitOps controller took part, and the verifier should refuse a receipt that
mentions either.
