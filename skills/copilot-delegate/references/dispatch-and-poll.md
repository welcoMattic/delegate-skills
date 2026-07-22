# Dispatch and poll

`scripts/relay.mjs` wraps Copilot's non-interactive prompt mode (`copilot -p`), captures its
structured JSONL output, and writes a `result.json`. Run one command, then read one file.

## Before the first run

```bash
command -v copilot
copilot version
copilot login
```

Install the GitHub Copilot CLI with `npm install -g @github/copilot`. For
authentication, `copilot login` uses an OAuth device flow and stores the token in the system
credential store. In CI or headless environments, set the `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or
`GITHUB_TOKEN` environment variable instead.

## Dispatching

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
```

`<skill-dir>` is the installed folder containing this skill's `SKILL.md`.

| Flag | Effect |
| --- | --- |
| `--brief <file>` | Brief path. Omit to read the brief from stdin. |
| `--cd <dir>` | Working root and child process cwd (default: current directory). |
| `--model <name>` | Copilot model for this run (default: Copilot's own configured default). |
| `--read-only` | Constrained mode: deny write and shell tools. **Best-effort** — verify `touchedFiles`. |
| `--allow-all` | Full access: all tools, paths, and URLs (`--allow-all`). Explicit opt-in only. |
| `--autopilot` | Enable autopilot mode for multi-step autonomous completion. |
| `--max-autopilot-continues <n>` | Maximum autopilot continuation steps (default: 20 when `--autopilot` is used). |
| `--agent <name>` | Custom Copilot agent to use (`--agent=<name>`). |
| `--add-dir <dir>` | Add an extra allowed directory. Repeatable. Edits there are not reported in `touchedFiles`. |
| `--resume-last` | Continue the most recent Copilot session (`--continue`); send only the delta brief. |
| `--timeout <dur>` | Relay watchdog (default: `30m`; h/m/s strings). Copilot has no CLI timeout flag. |
| `--out-dir <dir>` | Artifact directory (default: a fresh directory under the system temp dir). |
| `-h`, `--help` | Print the relay's header help. |

## Autonomy modes

Copilot requires explicit permission flags to run without blocking on interactive approval prompts.
The relay always sets them:

| Relay flag | What Copilot gets | Use when |
| --- | --- | --- |
| *(default)* | `--allow-all-tools --no-ask-user` | Normal implementation — all tools approved; paths scoped to cwd |
| `--read-only` | `--allow-all-tools --deny-tool=write --deny-tool=shell --no-ask-user` | Review / diagnosis — deny overrides allow, but see caveat below |
| `--allow-all` | `--allow-all --no-ask-user` | All tools, paths, and URLs; isolated/trusted contexts only |

**`--read-only` is best-effort.** `--deny-tool=write` and `--deny-tool=shell` are model-level
constraints — deny rules take precedence over `--allow-all-tools`, so the model cannot use write or
shell tools. However, this is not a kernel-enforced sandbox. Always confirm `touchedFiles` after a
`--read-only` run. The relay snapshots `git status` before the run and sets
`readOnlyViolation: true` in `result.json` when the tree changed anyway.

## Autopilot mode

`--autopilot` enables Copilot's autonomous multi-step mode: Copilot works through successive turns
without waiting for your input until the task is complete, a problem prevents further progress, or
the `--max-autopilot-continues` limit is reached. Use it for well-defined tasks that benefit from
multi-step completion without intervention. The default limit (20 when not specified) bounds the
run; set `--max-autopilot-continues <n>` to adjust.

Autopilot is separate from the autonomy modes above — combine it with any autonomy flag.

## Artifacts and result fields

Artifacts live outside the repo by default, so they do not appear in `touchedFiles`:

- `brief.txt` — the exact brief as Copilot received it.
- `events.jsonl` — raw Copilot stdout (JSONL events).
- `final.txt` — assistant text joined from captured events; absent if none was emitted.
- `stderr.txt` — complete stderr.
- `result.json` — the stable `delegate-relay.result.v1` contract.

`result.json` fields:

- `schema`, `tool` (`"copilot"`), `status` (`completed` | `failed` | `copilot_unavailable`),
  `exitCode`, and `signal` (`null` unless the child died on a signal).
- `workdir`, `autonomy`, `model` (`null` if omitted), `autopilot`, `resumed`, `copilotVersion`,
  `sessionId`, `startedAt`, and `finishedAt`.
- `briefPath`, `finalPath`, `eventsPath`, and `stderrPath`.
- `finalMessage` — assistant text joined with `"\n\n"` from the JSONL stream; extracted
  defensively across multiple possible event schemas. Tool calls and tool results are excluded.
- `touchedFiles` — `git status --porcelain` lines for the **final working tree under `--cd` only**.
  Anything already dirty before dispatch shows up too; edits inside `--add-dir` workspaces do not.
  Dispatch from a clean tree when you want the list to read as "what Copilot changed". `null` means
  git could not report; `[]` means git ran and the tree is clean.
- `readOnlyViolation` — `true` when `--read-only` was used and the tree changed (best-effort
  tripwire; a porcelain-level snapshot means an edit inside an already-dirty file can evade it).
- `stderrTail` — the last 20 non-empty stderr lines on failure.
- `error` — present for spawn failures or when the relay watchdog fires.

## Waiting for completion

The helper blocks. Use the orchestrator's background-command facility, or background it in a shell
and poll for `result.json`. The run is done only when the process exits and the file contains a
`status` field.

A pre-run usage error exits 2 and writes no result. A missing `copilot` exits 127 and writes
`status: "copilot_unavailable"`.

## When a run misbehaves

- **`status: "copilot_unavailable"` (exit 127):** install `copilot` and run `copilot login`.
- **`status: "failed"`:** read `stderrTail`, `stderrPath`, and the tail of `events.jsonl` for the
  error. Check that the `copilot` binary is authenticated and the model name (if passed) is valid.
- **`status: "failed"` with `signal: "SIGKILL"`:** the host killed the process, commonly via the
  OOM killer or a supervisor timeout. Check host memory and re-dispatch, or split the task.
- **Watchdog failure:** `error` reads
  `copilot did not finish within --timeout <dur>; killed by the relay watchdog`. Increase
  `--timeout` or split the task. The relay sends SIGTERM first, waits 10 seconds, then sends
  SIGKILL.
- **Empty `finalMessage`:** inspect `touchedFiles` and the diff. Add a
  `<structured_output_contract>` to the next brief to require a closing report.
- **`readOnlyViolation: true`:** a `--read-only` run still modified the tree. Review the diff
  before trusting the run; treat the diff, not the flag, as the guarantee.

## What the relay runs

The argv is equivalent to:

```bash
copilot --output-format=json --allow-all-tools --no-ask-user \
  [--model=<name>] [--agent=<name>] [--add-dir=<dir>] [--continue] \
  [--autopilot --max-autopilot-continues=<n>] \
  -p <brief>
```

With `--read-only`, `--deny-tool=write --deny-tool=shell` replaces the default. With `--allow-all`,
`--allow-all` replaces `--allow-all-tools`.

The brief rides as a `-p` argument and is visible in the host process list. The relay rejects
briefs over 120 KB before launch.

## The commit boundary

The relay never commits. Copilot edits the working tree; the orchestrator reviews, re-runs the
gates, and commits. See [review-and-land.md](review-and-land.md).
