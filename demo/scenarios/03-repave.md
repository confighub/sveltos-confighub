# Outage 3: the nightly repave

[The demo](../README.md) · [Outage 2](02-blast-radius.md) · Outage 3

Security teams ask for [the three Rs](https://blogs.vmware.com/tanzu/the-three-r-s-of-enterprise-security-rotate-repave-and-repair/):
- **rotate** credentials often;
- **repave** every server from a known good state, every few hours or every night;
- **repair** what is vulnerable within hours of a patch.

Outage 1 was a rotation. This one is a repave. The platform rebuilds the prod
clusters from nothing overnight, as [Wells Fargo described doing with its
Cloud Foundry platform](https://thenewstack.io/why-wells-fargo-repaves-its-entire-platform-every-day/),
on a pre-approved change: nobody is asked, and nobody is told. Each
cluster should get back from ConfigHub, through Sveltos, everything it runs.

It does not:
- **Sveltos delivers nothing.** It still holds its record that every profile
  was delivered to the cluster before. So ConfigHub's live status, which reads
  that record, keeps saying Synced and Healthy while prod is empty.
- **Once Sveltos delivers again, the shop does not start.** Its token was made
  by hand in each cluster at stand-up, standing in for an external secret
  store. No release holds it, so no repave brings it back, and `web` and `api`
  wait for a Secret that is not there.

Angel repairs it, and proposes what stops it happening again:

- **The fix:** Sveltos delivers to each rebuilt cluster again, and the shop's
  release holds a Job that makes the token on a fresh cluster. The release
  holds what makes the Secret, never its value.
- **The prevention:** the repave gate, kept by ConfigHub itself. Every Secret and
  ConfigMap a workload uses must be on the shop's restore list, and the release
  must hold it or what makes it. ConfigHub checks every change against that, and
  refuses to release one that would leave a repaved cluster without something.
  And the repave job asks Sveltos to deliver as soon as a cluster is rebuilt.

It needs the fleet onboarded (scenario 00), and stands alone: it does not
depend on outages 1 and 2. Rebuilding three clusters takes about two minutes;
the outage, about an hour with the agents and the approvals. The way Sveltos
treats a rebuilt cluster is with the Sveltos maintainers, as a question: if
their answer changes it, this page will say so.

```bash
source demo/env.sh
R="bash $DEMO/agents/run-agent.sh"; A="bash $DEMO/approve.sh"; P=$DEMO/prompts/03-repave
bash $DEMO/setup/reporter.sh log     # live status still flowing: recent lines, every 15 s
```

`<order>` placeholders are change orders, written `<space>/<order>`. Angel's
report names each order and the stage it waits in, and so do
`cub changeorder list --space chaos-shop-base` and
`cub changeorder list --space chaos-management`.

| Step | Command |
| --- | --- |
| 1. Tonight's repave of the three prod clusters, standing in for the platform's job | `bash $DEMO/setup/repave.sh prod` |
| Check: the prod clusters are empty, and ConfigHub still says Synced and Healthy | `kubectl get ns --context kind-chaos-prod-eu` and `cub sveltos status --kube-context kind-chaos-mgmt --dry-run` (`--dry-run` reads and writes nothing; the reporter keeps writing) |
| 2. Customers report the shop down; Angel finds why and proposes the fixes | `$R angel 03-repave $P/1-angel-find.txt` |
| 3. Approve what Angel asks for: each order it names, in the stage it waits in | `$A me <order> <stage> "<why>"` or `$A milton <order> <stage> 03-repave` |
| 4. Angel releases what you approved, and watches prod come back | `APPROVED="<each order and stage you approved>" $R angel 03-repave $P/2-angel-release.txt` |
| Repeat 3 and 4 while an order waits for approval (the shop's goes staging, then prod) | as in steps 3 and 4 |
| 5. Angel proposes the repave gate and the repave job's last step | `$R angel 03-repave $P/3-angel-prevent.txt` |
| 6. Turn the repave gate on, as yourself, with Angel's restore list | `bash $DEMO/setup/repave-gate.sh ConfigMap/shop-code Secret/shop-token` |
| 7. Devil, as a developer, adds feature flags by hand, and makes `web` read them | `$R devil 03-repave $P/4-devil-feature-flags.txt` |
| 8. Devil withdraws | `$R devil 03-repave $P/5-devil-withdraw.txt` |
| 9. The next night's repave, with the step Angel proposed | `bash $DEMO/setup/repave.sh --redeliver prod` |
| Check: the shop comes back on every prod cluster by itself, Synced and Healthy | `cub sveltos status --kube-context kind-chaos-mgmt --dry-run` |

**Step 6, the gate.** Like a workflow, it is yours: the agents may not make,
change or remove a trigger. Use the list Angel proposes. The command above is
the list we expect: the shop's code, held by the release, and its token, made
by Angel's Job. `bash $DEMO/setup/repave-gate.sh --off` takes the gate off.

What you should see:
- **After step 1:** each prod cluster has its system namespaces and nothing
  else. `cub sveltos status` still says Synced and Healthy for every prod Space:
  Sveltos's record says it delivered, and has not changed.
- **After step 2:** Angel names both causes, Sveltos's stale record and the
  token no release holds, and proposes two orders. The first changes the
  redeploy annotation on the prod delivery profiles in `chaos-management`. The
  second adds the token Job to `chaos-shop-base`. A new release of the shop also
  makes Sveltos deliver it, so Angel may need the first only for the platform.
- **After step 4:** each prod cluster gets its namespaces back, then the shop.
  The Job logs "shop-token made", and `web` and `api` start. Live status goes
  through OutOfSync and Degraded to Synced and Healthy. On staging, which was
  not repaved, the Job finds the token and makes nothing.
- **After step 6:** the gate's triggers are in `chaos-shop-base`, and every
  chaos-shop Space runs them: `cub trigger list --space chaos-shop-base`. The
  shop's units pass.
- **After step 7:** ConfigHub takes the edit and marks the unit with a
  ValidationError: "Deployment web uses ConfigMap/feature-flags, which is not on
  the restore list: a repave would not bring it back". No release of it can go
  out.
- **After step 8:** the units are back, and their validation is clean.
- **After step 9:** the shop is back on every prod cluster within a few
  minutes, with a new token from the Job, and nobody did anything.

**Without the agents.** `bash $DEMO/proof/repave-gate-check.sh` checks the
gate in about a minute and for nothing, in a Space of its own: see
[PROOF.md](../PROOF.md).

That was the last outage. To check what ConfigHub recorded, see [PROOF.md](../PROOF.md); to take everything down, [Tear it down](../README.md#tear-it-down).
