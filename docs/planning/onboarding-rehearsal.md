# Onboarding rehearsal, 2026-09-26

What [Onboard your Sveltos fleet](../user/onboard-your-sveltos-fleet.md)
claims was measured by running it, as a user already running Sveltos would,
on kind clusters: a management cluster and four workload clusters, stock
Sveltos v1.15.0 (`projectsveltos/addon-controller:v1.15.0`, no override),
Kubernetes v1.35.0, cub v0.6.2, and one ConfigHub organization. The full
output of the final run is in
[onboarding-rehearsal-2026-09-26.log](onboarding-rehearsal-2026-09-26.log);
it carries no credential.

The tool ran then as `npm run onboard`; it has since become the `cub sveltos`
plugin, which writes the same steps.

## The journey, and what each step showed

| Step | What the user ran | Measured |
| --- | --- | --- |
| Before | Two label-selector ClusterProfiles live: kyverno on `env In [staging, prod]`, ingress-nginx on `env=prod` | Five Helm releases on three clusters, 20 pods recorded |
| Plan | `kubectl get clusterprofiles,sveltosclusters -A -o yaml`, then `npm run onboard -- plan` | Two bases, five variants, stages staging then prod; both profiles flagged live |
| Apply | `npm run onboard -- apply`, then `bash onboard/apply.sh` | All six steps ran; each per-cluster profile arrived and waited: `cannot manage chart ... ClusterSummary ... managing it`; the live profiles kept managing |
| Takeover | `bash onboard/takeover.sh` | Every per-cluster profile `Provisioned`; every Helm release at the revision it had; all 20 pods the same (by UID): nothing reinstalled |
| A change | The guide's day-two commands, kyverno admission controller 3 to 4 replicas | staging-eu ran 4 while both prod clusters held 3; prod promoted only after staging released; then all ran 4 |
| A cluster joins | Registered `staging-us` (env=staging); re-plan with `onboard/profiles.yaml` and a fresh cluster list; re-run `apply.sh` | Sveltos put nothing on it by itself; the script left every existing variant as it was, cloned the new one from the base as it stood, and released it through both stages; staging-us ran 4 replicas, the change it joined after |

Delivery ran on the credential the guide recommends: the Targets' server
worker as `username` and `password` in the gateway Secret. Sveltos's ORAS
client exchanges them at the gateway's token endpoint, and the gateway lets
a Target's own worker pull that Target's releases.

## What the rehearsals changed in the tool

Earlier runs the same evening found six things, each fixed before the final
run above:

1. **Two profiles, two change orders called `baseline`.** A release named
   `ChangeOrder:baseline` was refused as ambiguous across Spaces. Releases
   now name the change order with its base Space.
2. **A finished change order cannot be promoted again.** Re-running the
   first release failed with `has completed ChangeWorkflow ... nothing left
   to promote`. The script now asks ConfigHub where each release stands and
   skips a finished one.
3. **A second onboarding locked the first out.** Both used one gateway
   Secret, the second overwrote it with its own worker, and every fetch of
   the first fleet failed with `403 Forbidden`. Each Targets Space now has
   its own Secret.
4. **A re-run wrote over a later change.** Re-storing each variant from the
   onboarding files put the original values back as a new head revision.
   Departures are now stored only on a fresh clone (head revision 2).
5. **A joining cluster would have missed earlier changes.** Its departures
   were written as a whole document from the original profile. They are now
   applied with `cub function set ... set-yq`, touching only their own
   fields, so the clone keeps what the base holds today; a probe confirmed
   the variant keeps its lineage and inherits later base changes.
6. **The organization's Space quota.** Rehearsals hit it (100 Spaces). The
   plan now states the Spaces it needs as well as the Links.

## ConfigHub behaviour measured on the way

- Promoting a stage again, or approving it again, succeeds and changes
  nothing. Publishing a release that is already published is refused with
  `no changes were made since :latest bundle`.
- A variant with nothing new under a change order counts as released for it,
  even though its publish is refused that way, and the next stage opens. This
  is what lets a joining cluster be released without touching the others.
- A per-cluster profile that reported `FailedNonRetriable` while another
  profile managed its release took the release over by itself within a
  minute of that profile being deleted with `LeavePolicies`.
- `cub unit get -o json` answers `HeadRevisionNum`; a fresh clone is at 2.

## The takeover with plain resources

A second run the same night, on a management cluster and one workload
cluster ([log](onboarding-rehearsal-policyrefs-2026-09-26.log)), repeated the
takeover for a live profile that deploys a Namespace and a ConfigMap through
`policyRefs`. While both profiles existed, the per-cluster one reported `A
conflict was detected while deploying resource Namespace:/demo-policyrefs`
and nothing changed. After `takeover.sh` it reported `Provisioned`, and both
objects kept their UIDs: nothing was deleted or recreated. The ConfigMap the
profile names stays on the management cluster; ConfigHub governs the profile.

## The plugin

On 2026-09-27 the same path ran through the installed `cub sveltos` plugin,
built from this repository and installed with `cub plugin install`, whose
hook wrote its manifest ([log](onboarding-rehearsal-plugin-2026-09-27.log)):
a live `podinfo` profile, `cub sveltos plan`, `cub sveltos apply`,
`apply.sh`, then `takeover.sh`. The release stayed at revision 1 with the
same pod.

## Kyverno policies

Also on 2026-09-27 ([log](onboarding-rehearsal-kyverno-2026-09-27.log)), on a
management cluster and a staging and a prod cluster: a live `kyverno-policies`
profile deploying a `disallow-latest-tag` ClusterPolicy from a ConfigMap was
onboarded together with its ConfigMap (#53). Each variant received its own
copy of the ConfigMap from ConfigHub, and the handover left both
ClusterPolicy objects unchanged. The policy was then changed from Audit to
Enforce on the base: after staging's release a `:latest` pod was refused on
staging and admitted on prod; after prod's own approval and release, prod
refused it too.

## Not measured

The takeover with Kustomize profiles; Cluster API clusters as input;
namespaced `Profile` objects; EventTrigger-made profiles. The guide says so
where each would matter.
