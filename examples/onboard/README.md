# Onboarding example

What `cub sveltos` does with a small fleet, committed so you can read it
before running anything against your own:

- [my-fleet.yaml](my-fleet.yaml): the input, in Sveltos's own terms: two
  label-selector ClusterProfiles and the SveltosClusters they select.
- [plan.txt](plan.txt): what `cub sveltos plan my-fleet.yaml
  --stage-label env --stages staging,prod` prints.
- [apply/](apply/): what `apply` writes with the same options:
  [apply.sh](apply/apply.sh), the bases, each profile's workflow, and the
  management cluster's bootstrap profiles.

`go test ./...` checks that these files are what the plugin writes today;
`go test ./internal/onboard -update` regenerates them. The guide is
[Onboard your Sveltos fleet](../../docs/user/onboard-your-sveltos-fleet.md).
