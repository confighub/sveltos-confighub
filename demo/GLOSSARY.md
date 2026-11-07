# The words used here

The vocabulary the demo and its pages use. [Back to the demo](README.md).

| Word | What it means here |
| --- | --- |
| **Space** | A ConfigHub folder of configuration, one per base, class base or cluster. The demo's are named `chaos-*` |
| **Unit** | One piece of configuration in a Space, with every revision kept: here the shop's manifests (`shop`), Reloader's (`reloader`), or a policy (`guardrails`) |
| **Base, class base, variant** | The shop's configuration in `chaos-shop-base`, cloned into a class base for staging and one for prod, then into one variant per cluster (`chaos-shop-staging`, `chaos-shop-prod-eu`, ...). The web UI shows each variant as a deployment |
| **Change order** | One named change, followed through a workflow. Written `<base Space>/<name>`, for example `chaos-shop-base/web-reload-on-token-rotation` |
| **Workflow, stage** | The path a change order takes: `bases`, then `staging`, then `prod`. Each stage may need approvals before its release |
| **Release** | What ConfigHub publishes for a variant, and what Sveltos fetches and applies to that cluster |
| **Attestation** | A recorded verdict on a change: an Approval by you or Milton |
| **Trigger** | A function ConfigHub runs on every change to a unit. A validating one that fails blocks the unit's release |
| **The record** | The management cluster's Space, `chaos-management`. Its releases deliver every Sveltos delivery profile, so profiles come from ConfigHub, not by hand |
| **Live status** | What each cluster reports, written into ConfigHub every 15 seconds: Synced or not, Healthy or Degraded. The web UI shows Healthy as Live |
| **The shop** | The demo's app: `api` and `web` in namespace `shop`, Python on `python:3.12-alpine`. Its code is the ConfigMap `shop-code`, and its API token the Secret `shop-token`, made by hand in each cluster |
| **Reloader** | Stakater Reloader, which restarts the pods that use a Secret when it changes. The demo's platform component, `chaos-platform` |
| **Sveltos** | The add-on manager that delivers configuration from the management cluster to the workload clusters |
| **Management cluster** | `chaos-mgmt`, where Sveltos runs. The workload clusters are `chaos-staging`, `chaos-prod-eu`, `chaos-prod-us-1` and `chaos-prod-us-2` |
| **SveltosCluster** | Sveltos's registration of a workload cluster, with its labels: `env` (staging or prod) and `region` (eu or us) |
| **Delivery profile** | A Sveltos ClusterProfile that fetches one variant's release and applies it to its one cluster |
| **ClusterSummary** | Sveltos's record of what one profile delivered to one cluster |
| **Promote** | Move a change order into its next stage. The stage's variants take the change; nothing is released yet |
| **Baseline** | A variant's first release, published during onboarding: what its cluster already ran |
| **Handover** | The onboarding step that moves delivery from the profiles you applied by hand to ConfigHub's releases |
| **Service account** | A ConfigHub identity for something that is not a person. Each agent is one |
| **Policy sandbox** | A kind cluster that holds admission policies and nothing else, where a policy is previewed before it ships |
| **Command sandbox** | Claude Code's macOS sandbox, which holds every command an agent runs |
| **Restore list** | Outage 3's list of what a repave brings back of the shop, which ConfigHub checks on every change |
