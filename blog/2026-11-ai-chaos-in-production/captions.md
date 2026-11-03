# Screenshots

Three images, in this order. All are real captures from the first recorded run, 3 October 2026.
They are copied into [`images/`](images/) so this pack is self-contained: the folder can be
handed to anyone and nothing it needs sits outside it. The originals stay in
[`demo/diary/images/`](../../demo/diary/images/), where the run that produced them keeps them.

## 1. Half the fleet, and the fleet knows which half

![Half the fleet degraded](images/01-half-the-fleet-degraded.jpg)

`images/01-half-the-fleet-degraded.jpg`, from `demo/diary/images/r1-21-outage2-half-degraded.jpg`

ConfigHub's component graph during outage 2. `prod-eu` and `staging` are Live. `prod-us-1` and
`prod-us-2` are Degraded. All four are Synced.

What to notice: every cluster has exactly the configuration that was asked for, and two of them
are down. The two that broke are the two labelled `region=us`, which is what the hand-applied
profile selected.

## 2. The fix, waiting

![The fix waiting at the gate](images/02-fix-waiting-at-the-gate.jpg)

`images/02-fix-waiting-at-the-gate.jpg`, from `demo/diary/images/r1-12-outage1-fix-waiting.jpg`

The change order `web-reload-on-token-rotation`, opened by the Angel Agent. The promotion path
reads source, bases, staging, prod, with prod gated. The whole change is two annotations.

What to notice: an agent's repair is a named change with two fields in it, moving through the
same stages as any other change, and stopped at a gate. The header still reads Degraded, because
nothing has shipped yet.

## 3. Refused, in the Devil Agent's own words

![Refused, in the Devil Agent's own words](images/03-refused-in-devils-own-words.png)

`images/03-refused-in-devils-own-words.png`, from `demo/diary/images/r1-o1-again.png`

The Devil Agent's transcript, labelled "AI generated, as it ran". It rotates the token a second
time and the shop survives. It then copies the old manifest into a new Deployment, and the
cluster refuses it: `ValidatingAdmissionPolicy 'secret-env-needs-reload' ... denied request`.

What to notice: the prevention is reported by the thing that tried to get past it.

## Notes

- The images from the retired outage 3, the prod-only memory cut, are not used. That outage was
  replaced by the nightly repave on 26 October 2026.
- No screenshot of the policy preview is used. The preview runs on the command line; its view
  inside ConfigHub is still a mock.
- Run 1 was on ConfigHub v0.8.1. These images show what they claim, and a reader opening their
  own ConfigHub today will not see an identical screen.
- Outage 3 has no screenshot, because the agents have not run it yet.
