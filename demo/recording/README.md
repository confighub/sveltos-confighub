# The recordings

What our runs left behind, as evidence. The [diaries](../diary/README.md) tell
the same runs as a story.

| What | When | What it holds |
| --- | --- | --- |
| `runs/` | 3 October | The first run, with a person approving every release: each agent's transcript and ConfigHub's record of each outage |
| [verification-2026-10-03.md](verification-2026-10-03.md) | 3 October, evening | The verification run, made from the README with Milton approving: what it found, and ConfigHub's record of it |
| [check-2026-10-04.md](check-2026-10-04.md) | 4 October | The setup and the parity gate rechecked on the server ConfigHub moved to that day |

The rest of this page is about `runs/`, the first run. The agents' text is AI
generated.

| Folder | Outage |
| --- | --- |
| `runs/01-rotation/` | A rotation nobody picked up |
| `runs/02-blast-radius/` | Half the fleet at once |
| `runs/03-parity/` | Staging said yes, prod said no |

In each:
- **`<agent>-<UTC time>.jsonl`** is the agent's full event stream, and the
  `.md` beside it is a readable transcript. The transcript keeps the first 40
  lines of each command's output; the `.jsonl` keeps all of it. Lines such as
  "Contains simple_expansion" or "This command requires approval" are Claude
  Code's command filter refusing a command, not ConfigHub.
- **`runs.log`** holds the prompt each run was given.
- **`evidence*.txt`** is ConfigHub's own record of the outage, printed by an
  earlier form of `proof/evidence.sh` and headed by hand: approvals with
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
  replaced with `$AI_CHAOS_DIR`, `$DEMO` and `$AGENT_HOME`, the agent's own
  empty working directory. Each run's opening
  event is cut to the model and the Claude Code version. One run's read of a
  private file is removed.
