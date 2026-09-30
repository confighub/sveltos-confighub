# Sveltos policy-impact demo

This fits into the existing Sveltos fleet story described in
[fleet-chapters.md](fleet-chapters.md): one management cluster running Sveltos and four
workload clusters grouped as pilot, staging and two production.

It is not a second version of
[Kyverno across the fleet](../../../examples/sveltos/kyverno-fleet/README.md). That chapter
delivers policy through reviewed variants behind an approval gate. This one asks a different
question: before a policy or an application moves, what would it do. Delivery is chapter one;
this is impact preview.

Add a pre-promotion **Policy impact** view with two modes:

1. **Application → policies**
   Propose scaling an application to four replicas. Show which targets pass or fail their
   applicable replica policy.

2. **Policy → estate**
   Propose lowering a production replica ceiling. Show which existing configurations would be
   rejected on their next create or update. Clearly state that a VAP does not retroactively
   evict an existing workload.

## What each mode outputs

Given a candidate ValidatingAdmissionPolicy, binding and parameters, evaluate against
target-relative configurations and compare current-policy against candidate-policy outcomes.

Every result is classified as one of four:

- **newly denied** — passes today, would be rejected under the candidate
- **newly allowed** — rejected today, would pass under the candidate
- **unchanged**
- **unknown** — required admission context is unavailable, so no verdict is claimed

Each result shows the exact **target**, **configuration revision**, **policy revision** and
**failed expression**. Without those four the view is decorative rather than checkable.

**Newly allowed has a limit worth stating in the UI, not only in the docs.** It requires a test
corpus: previously rejected changes, policy tests, or proposed configurations. The currently
admitted live estate alone cannot reveal everything a weaker policy would permit.

Advisory first. Blocking a promotion on these results can follow through the existing gating
work.

## AI contribution

The AI contribution should be substantive but bounded:

- explain why targets differ;
- group common failures;
- identify the minimum target-specific correction;
- compare fixing the application, correcting the policy, or requesting an explicit exception;
- prepare a concise approval summary.

The policy verdict itself must come from deterministic evaluation, ideally against a disposable
Kubernetes API server. AI must not invent verdicts or grant authority.

## Evidence labels

Label the demo honestly:

- **Recorded live:** ConfigHub approval, release, Sveltos delivery and observed convergence.
- **Prototype evaluated:** policy results against pinned inputs.
- **AI generated:** explanations and suggested remedies.
- **Mock UI:** screens not yet implemented in ConfigHub.
- **Not yet proven:** native gating, complete admission-context fidelity and retained product
  evidence.

## Blog proposition

The blog's central line is strong and understandable:

> Before promoting an application, ask what every target's policies will do to it. Before
> promoting a policy, ask what it will do to the entire configuration estate. Policy is
> configuration too.

That turns the demo from "AI writes policy YAML" into a much more valuable proposition: AI helps
people understand the consequences of changing either side before the fleet is touched.

Blog brief for the post that comes out of this:
`~/Desktop/STRATEGY/BLOGS-PROJECTS/sveltos-2-policy-impact-BRIEF-2026-09-10.md`
