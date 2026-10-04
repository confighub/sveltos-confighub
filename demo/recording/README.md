# The recording, 2026-10-03

Our own run of the three outages, kept as it happened, with a person approving
every release. The agents' text is AI generated. The second run, made from the
README with Milton approving, is
[verification-2026-10-03.md](verification-2026-10-03.md).

| Folder | Outage |
| --- | --- |
| `runs/01-rotation/` | A rotation nobody picked up |
| `runs/02-blast-radius/` | Half the fleet at once |
| `runs/03-parity/` | Staging said yes, prod said no |

In each:
- **`<agent>-<UTC time>.jsonl`** is the agent's full event stream, and the
  `.md` beside it is a readable transcript.
- **`runs.log`** holds the prompt each run was given.
- **`evidence*.txt`** is ConfigHub's own record of the outage: approvals with
  who recorded them and their notes, releases with who published them, and
  change orders with how each ended.
- **`timeline.tsv`** is the outage's timeline, which `agents/timeline.py`
  draws. Its sources include our own logs and screenshots, which are not
  shipped.
- **`review*`** (outage 2) is the review before approval, which found the
  wrong exemption.

How this run differed from the demo as it now stands:
- **Approvals:** a person approved every release. The demo adds Milton.
- **The plugin:** the agents ran a development build of `cub sveltos`, invoked
  as `cub-sveltos-chaos`. Its features shipped in v0.13.0. The demo calls
  `cub sveltos`.
- **The sandbox guard:** `impact` and `check` used to take the current kubectl
  context as the sandbox. That is how one preview in outage 2 put its policy
  on the management cluster (see `runs/02-blast-radius/review.md`). Since
  v0.12.1 they refuse.
- **Isolation:** the first runs started inside the repository. Paths have been
  replaced with `$AI_CHAOS_DIR`, `$DEMO` and `$AGENT_HOME`. Each run's opening
  event is cut to the model and the Claude Code version. One run's read of a
  private file is removed.
