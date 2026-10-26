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
| **Its ConfigHub identity** | A `cub` configuration made for the run in its directory (`CUB_CONFIG`), with one context, `chaos-<agent>`, signed in afresh as that agent's service account with its key, and a copy of the `cub sveltos` plugin. It goes when the run ends. Your own `cub` configuration, and the agents' in `$AI_CHAOS_DIR/cub`, which the scripts use, are not in reach |
| **The clusters** | A kubeconfig made for the run (`KUBECONFIG`), with the contexts `kind-chaos-mgmt`, `kind-chaos-staging`, `kind-chaos-prod-eu`, `kind-chaos-prod-us-1` and `kind-chaos-prod-us-2`, and no current context, so every command names its cluster |
| **The policy sandbox** | `$AI_CHAOS_DIR/sandbox.kubeconfig`, named in the prompts that need it |
| **Isolation** | It starts in a new empty directory outside any repository. It gets nothing on stdin, no MCP servers or connectors, and no memory of earlier runs. Every command it runs is held in Claude Code's sandbox (below) |

## What each agent may run

| Agent | May run | Never |
| --- | --- | --- |
| Devil | any `kubectl` and `cub` command, `date`, `openssl rand` | the shared list below; `kubectl config`, wherever it stands on the line; `kubectl` on Secrets of the management cluster, where the delivery account's token is |
| Angel | `kubectl get`, `describe` and `logs`; any `cub` command; `date`. It may also read and write files, in its own directory only, but not the run's `cub` configuration or kubeconfig | the shared list below; `kubectl` on Secrets, or on objects read from a file (`-f`) |
| Milton | read-only `cub` commands, `cub variant approve`, `cub sveltos impact` and `status`; `kubectl get`, `describe` and `auth can-i`; any `kubectl` on the sandbox; `proof/token-subject.sh`; `date` | `cub attestation create` or `revoke`, `cub worker`, `cub serviceaccount`, `cub auth`, `cub context`; `kubectl` on Secrets, or `get` and `describe` of objects read from a file; a second `--kubeconfig` |

The shared list Devil and Angel may never run:
- `cub variant approve`, and `cub attestation create` or `revoke`;
- `cub space delete`;
- `cub changeworkflow create`, `update`, `edit` or `delete`;
- `cub component update`;
- `cub worker`, `cub serviceaccount`, `cub auth` and `cub context`;
- `kubectl delete namespace`.

And no agent, Milton included, may:
- run a `cub` command that names a context (`--context` anywhere on the
  line), or `--debug`, which prints the bearer token;
- run a command that sets `CUB_CONTEXT` or `CUB_CONFIG`;
- read, with its Read tool or with `cat` and the like, your `cub`
  configuration, `$AI_CHAOS_DIR/keys`, `$AI_CHAOS_DIR/cub` or
  `$AI_CHAOS_DIR/guards`. These rules also refuse Edit and Write there;
- write its own `.claude` settings.

Each run has its own kubeconfig, with no current context, so every `kubectl`
command names its cluster.

A refused command is refused, and the agent is told so. It cannot ask for
permission (`--permission-mode dontAsk`). `run-agent.sh` holds the exact lists.

Claude Code matches these lists against the command's text. So the
instructions ask each agent for one plain command at a time, verb first and
`--context` last, with no loops or chained commands. Milton may pipe one
command into another. The rule came after our first run, whose transcripts
still show loops and chained commands.

Matching text is not a boundary on its own: a program can still open any file
its user can. So there are two more lines:
- **The sandbox.** Every command an agent runs is held in Claude Code's
  sandbox (macOS Seatbelt), set per run in `$AI_CHAOS_DIR/guards/<agent>.json`.
  It reads nothing in your home folder but what the agent's tools need:
  `cub`, the policy sandbox's kubeconfig, Python's packages, and the two files
  of this kit the prompts name, `agents/no-policies.yaml` and
  `proof/token-subject.sh`. So not your `cub` configuration, the keys, the
  other agents' configurations, your notes or other credentials, whichever
  program asks (`kubectl --from-file` included). It writes only its own
  directory, which holds a `cub` configuration made for the run and goes when
  the run ends. It reaches ConfigHub and local ports (the kind clusters), and
  a command cannot leave the sandbox. One opening is needed: `cub`, a Go
  program, checks TLS through macOS's trust service, which the sandbox
  reaches only with `enableWeakerNetworkIsolation`.
- **ConfigHub.** It refuses an approval from anyone the workflow does not
  name. `setup/gates.sh` and the rollouts name only you and Milton, and never
  a change's author. With no other identity in reach, Devil and Angel cannot
  approve.

What is left:
- an agent can read its own sign-in, which lasts a day, and a command can
  print it;
- Devil can read the workload clusters' Secrets, and a pod it starts can
  reach anywhere;
- the rules on Secrets match the command's text (`get secret`,
  `secrets/<name>`, `pods,secrets`, in any case), so a command that reaches
  Secrets another way could still print the delivery account's token. That
  account can only read the Targets' releases. Rotate its token after a run:
  `ROTATE_TOKEN=1` with the onboarding's `apply.sh`.

Before you publish the transcripts,
`bash $DEMO/proof/scan-runs.sh` names every line that looks like a
credential.

## How long a run takes

An agent cannot `sleep`. It waits for a rollout by re-reading, so one run may
take many turns. Our longest, Angel releasing a fix to three prod clusters one
at a time, took 13 minutes and 307 turns. Give your runtime a timeout and a
turn limit well above that, or it will stop mid-release.

## What each run leaves

- `$CHAOS_RUNS/<run-name>/<agent>-<UTC>.jsonl`: the full event stream.
  `$CHAOS_RUNS` is `$AI_CHAOS_DIR/runs` unless you set it;
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
run the commands in a shell with `CUB_CONFIG=$AI_CHAOS_DIR/cub/<agent>`,
`CUB_CONTEXT=chaos-<agent>` and `KUBECONFIG=$AI_CHAOS_DIR/fleet.kubeconfig`.
Approvals by hand are `approve.sh me`.

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
