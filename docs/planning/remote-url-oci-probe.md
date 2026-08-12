# Live probe: ClusterProfile remoteURL fetching YAML from an OCI registry

Run on 2026-08-10 against Sveltos v1.13.0, whose
`controllers/url_source.go` is byte-identical to commit 4f9a59e that the
maintainer pointed us at. The probe answers one question: which OCI artifact
shapes does `policyRefs[].remoteURL` deploy today, ahead of the ConfigHub
OCI-gateway integration.

## Setup

Two kind clusters (management and one workload registered with
`environment: staging`), Sveltos v1.13.0 from the pinned upstream manifest
with ServiceMonitors filtered out, and a TLS `registry:2` container with a
self-signed certificate. Three artifacts were pushed with oras, one tag
each, all containing the same kind of payload: a Namespace plus a ConfigMap.
Each ClusterProfile used:

```yaml
spec:
  clusterSelector:
    matchLabels:
      environment: staging
  policyRefs:
    - deploymentType: Remote
      remoteURL:
        url: oci://<registry>/probe/<shape>:v1
        interval: 1m0s
        secretRef:
          name: sveltos-oci-ca
          namespace: projectsveltos
```

## Results

| Artifact shape | Result |
| --- | --- |
| Single layer of raw YAML bytes (documents separated by `---`) | Provisioned; resources deployed to the workload cluster |
| Single layer that is an uncompressed ustar tar of `.yaml` files | Provisioned; resources deployed to the workload cluster |
| Single layer that is a gzipped tar of the same files | Failed: the gzip bytes fall through to the raw-YAML branch and decoding stops at `yaml: control characters are not allowed` |
| Uncompressed tar written by default macOS bsdtar | Failed: AppleDouble metadata entries such as `._ns.yaml` end in `.yaml`, match the extension filter, and inject binary content |

## Operational findings

1. The auth Secret must have type `addons.projectsveltos.io/cluster-profile`.
   An Opaque Secret fails with `unsupported secret type`.
2. The `caFile` key works: the addon-controller trusted our self-signed
   registry after reading the CA from the Secret.
3. The ORAS client is HTTPS-only. A plain-HTTP local registry cannot be
   used, which is why this probe runs a TLS registry.
4. Layer media types are ignored entirely; only the content shape matters.

## What this means for the integration

The direct path in the agreed architecture statement works today: publish
raw YAML (or a clean uncompressed tar) as an OCI image, point the reviewed
ClusterProfile's `remoteURL` at it, and Sveltos deploys and re-checks it on
its interval. The two failure shapes are avoidable by the publisher and
fixable in the addon-controller: a gzip sniff before the tar parse, and
skipping `._*` and `PaxHeader` entries in the extension filter. Whichever
side moves, the artifact contract should be written down where both
projects can point at it.

## Re-probe against the fix build, 2026-08-10

The maintainer built `projectsveltos/addon-controller:v1.13.0-ch` with a
gzip sniff before the tar parse and an AppleDouble filter in the layer
reader. The same probe ran again against that image, with the deployment
confirmed to be running it, and every shape now deploys.

| Artifact shape | Result on the fix build |
| --- | --- |
| Single layer of raw YAML bytes | Provisioned |
| Uncompressed ustar tar of `.yaml` files | Provisioned |
| Gzipped tar of the same files | Provisioned, where the released build failed |
| Tar written by macOS bsdtar carrying an AppleDouble `._ns.yaml` entry | Provisioned, where the released build failed |

One caution worth recording. A macOS tar only carries AppleDouble entries
when the source file has extended attributes, and `tar -tf` hides those
entries when listing, so an archive can look clean and not be. The first
attempt at this re-probe pushed an archive with no AppleDouble entry at
all and passed without exercising the fix. The confirmed result above used
an archive whose raw bytes contain `._ns.yaml`.

The catalog keeps publishing single raw-YAML layers, because that shape
works on every build, released or patched.

## The gateway path, proven end to end, 2026-08-12

The architecture statement says config comes from ConfigHub, which publishes
changes as OCI images on its OCI gateway, and Sveltos fetches from that
gateway. That whole sentence now has a measurement behind it.

A Space was wired the way the chapters wire one, with the approval filter and
a release target. One reviewed Unit was created, the approval gate attached
about a second later, the exact revision was approved, and
`cub release publish` published the Space. A single kind cluster running
Sveltos then fetched that release directly:

```yaml
policyRefs:
  - deploymentType: Remote
    remoteURL:
      url: oci://oci.hub.confighub.com/space/<space>:latest
      interval: 1m0s
      secretRef:
        name: confighub-gateway
        namespace: projectsveltos
```

The Secret carries the `cub` bearer token under the `token` key and the
Sveltos cluster-profile type. Thirty seconds later the ClusterSummary read
`Provisioned` and the reviewed `ClusterProfile` was on the cluster. No
temporary registry, no re-push, and no other controller took part.

Two constraints fell out of the run and both matter to anyone repeating it.

The gateway serves each release as one
`application/vnd.oci.image.layer.v1.tar+gzip` layer, so the fetcher has to
gunzip. The same profile against the released build failed with the gzip
bytes decoded as YAML, and succeeded against the build carrying the gzip
fix. Reading a ConfigHub release from the gateway therefore needs an
addon controller with that fix.

OCI repository names are lowercase, so a Space whose name carries uppercase
characters cannot be addressed through the gateway at all. The gateway also
answers `Space has no release target` for a Space that was never given one,
which is a clearer signal than a plain not-found.
