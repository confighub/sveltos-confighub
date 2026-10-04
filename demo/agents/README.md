# The agents, and running them with your own AI

The demo's agents are AI coding agents run headless, each with its own
ConfigHub identity. We used Claude Code (`claude -p`), started by
[run-agent.sh](run-agent.sh). Any agent runtime that can run shell commands
can stand in, if it is given the same things and kept to the same limits. This
page is that contract.

## What each run gets

`run-agent.sh <devil|angel|milton> <run-name> <prompt-file>` gives the agent:

| What | Where it comes from |
| --- | --- |
| **The task** | The prompt file, with each `${VARIABLE}` filled from the environment. A missing one stops the run before it starts. The scenarios say what to set |
| **Standing instructions** | `devil.md`, `angel.md` or `milton.md`, with `$AI_CHAOS_DIR` and `$DEMO` filled in, added to the runtime's own system prompt |
| **Its ConfigHub identity** | `CUB_CONTEXT=chaos-<agent>`, the `cub` context `setup/identities.sh` signed in as that agent's worker. Never switch the current context: set it per process |
| **The clusters** | `KUBECONFIG=$AI_CHAOS_DIR/fleet.kubeconfig`, with the contexts `kind-chaos-mgmt`, `kind-chaos-staging`, `kind-chaos-prod-eu`, `kind-chaos-prod-us-1` and `kind-chaos-prod-us-2` |
| **The policy sandbox** | `$AI_CHAOS_DIR/sandbox.kubeconfig`, named in the prompts that need it |
| **Isolation** | It starts in a new empty directory outside any repository. It gets nothing on stdin, no MCP servers or connectors, and no memory of earlier runs |

## What each agent may run

| Agent | May run | Never |
| --- | --- | --- |
| Devil | any `kubectl` and `cub` command, `date`, `openssl rand` | the shared list below |
| Angel | `kubectl get`, `describe` and `logs`; any `cub` command; `date`. It may also read and write files. It works in its empty directory, but nothing confines it there | the shared list below |
| Milton | read-only `cub` commands, `cub variant approve`, `cub sveltos impact` and `status`; `kubectl get`, `describe` and `auth can-i`; any `kubectl` on the sandbox; `proof/token-subject.sh`; `date` | `cub attestation create` or `revoke`, `cub worker`, `cub auth`, `cub context` |

The shared list Devil and Angel may never run:
- `cub variant approve`, and `cub attestation create` or `revoke`;
- `cub space delete`;
- `cub changeworkflow create`, `update`, `edit` or `delete`;
- `cub component update`;
- `cub worker`, `cub auth` and `cub context`;
- `kubectl delete namespace`.

A refused command is refused, and the agent is told so. It cannot ask for
permission. `run-agent.sh` holds the exact lists.

Claude Code matches these lists by command prefix. So the instructions ask each
agent for one plain command at a time, verb first and `--context` last, with no
loops or chained commands. Milton may pipe one command into another. Another runtime may not need that, but the
instructions still ask for it.

These limits are a second line, not the only one. ConfigHub refuses an
approval from anyone the workflow does not name. `setup/gates.sh` and
`setup/onboard.sh` name only you and Milton, and never a change's author. So an
agent runtime that cannot restrict commands still cannot approve as Devil or
Angel. It could still break more than the scenario asks for.

## How long a run takes

An agent cannot `sleep`. It waits for a rollout by re-reading, so one run may
take many turns. Our longest, Angel releasing a fix to three prod clusters one
at a time, took 13 minutes and 307 turns. Give your runtime a timeout and a
turn limit well above that, or it will stop mid-release.

## What each run leaves

- `$CHAOS_RUNS/<run-name>/<agent>-<UTC>.jsonl`: the full event stream;
- a readable transcript beside it (`.md`), made by `render.py`;
- a line in `$CHAOS_RUNS/<run-name>/runs.log` with the time, the agent and the
  prompt as sent.

Three scripts read the event stream:
- `render.py` makes the transcript;
- `last-request.sh` pulls each run's last words, which `approve.sh milton`
  hands to Milton as the request;
- `panel.py` draws the figures.

The three read Claude Code's `stream-json` format, one JSON object per line.
Only these shapes matter. `render.py` also prints `num_turns`, `duration_ms`
and `total_cost_usd` from the `result` event, when they are there:

```json
{"type": "assistant", "message": {"content": [{"type": "text", "text": "what the agent says"}]}}
{"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "t1", "input": {"command": "kubectl get pods -n shop"}}]}}
{"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "content": "the command's output"}]}}
{"type": "result", "result": "the agent's final report"}
```

`approve.sh milton` also relies on `run-agent.sh` exiting non-zero when the
agent fails, and on each run's file being named `<agent>-<UTC time>.jsonl` in
`$CHAOS_RUNS/<run-name>/`. That is how it finds every request in a run.

## Using another agent runtime

1. **Replace the `claude -p` call** at the end of `run-agent.sh` with your
   runtime's headless call. Keep the environment it sets: `CUB_CONTEXT`,
   `KUBECONFIG` and `AI_CHAOS_DIR`. Keep the empty working directory, nothing
   on stdin, the file name, and a non-zero exit when the agent fails.
2. **Pass the standing instructions** (`<agent>.md`) as the system prompt, and
   the filled-in prompt as the task.
3. **Enforce the command lists above** in your runtime, or wrap the shell it
   uses. If you can't, rely on ConfigHub's gates, and watch Devil.
4. **Write the event stream in the shapes above**, or change `render.py` and
   `last-request.sh` to read your runtime's format. The transcript and Milton's
   request depend on them. `panel.py` is only for figures.
5. **Choose the model.** For Claude Code, `MODEL=<model>` before
   `run-agent.sh` passes `--model`. We ran `claude-opus-5-5`. Weaker models may
   need more turns, and may miss what Milton caught.

You can also be any agent yourself. Read the prompt and the agent's `.md`, and
run the commands in a shell with `CUB_CONTEXT=chaos-<agent>` and
`KUBECONFIG=$AI_CHAOS_DIR/fleet.kubeconfig`. Approvals by hand are
`approve.sh me`.

## The files here

| File | What it is |
| --- | --- |
| `devil.md`, `angel.md`, `milton.md` | Each agent's standing instructions |
| `run-agent.sh` | Runs one agent once, as above |
| `render.py` | Event stream to readable transcript: `python3 render.py <run.jsonl> > run.md` |
| `last-request.sh` | Each run's last words: `last-request.sh <run-name> [agent] [--all]` |
| `panel.py` | One run as an HTML panel, for figures: `panel.py <run.jsonl> --out panel.html` (see `--help`) |
| `timeline.py` | A TSV of time, who and what as an HTML timeline: `timeline.py <timeline.tsv> --title "..." --out t.html` |
| `no-policies.yaml` | An empty policy set, the baseline for `cub sveltos impact` when no policy is in force yet |
