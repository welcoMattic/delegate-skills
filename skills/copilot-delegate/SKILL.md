---
name: copilot-delegate
description: >-
  Delegate a coding task to the GitHub Copilot CLI (`copilot`) as a background implementer, then
  review its diff and land it yourself. Use this whenever the user wants to hand implementation work
  to GitHub Copilot CLI — phrasings like "have Copilot implement X", "delegate this to Copilot",
  "run it through Copilot CLI", "use Copilot CLI to implement/fix/refactor", or "have copilot CLI do
  this" — or to run a queue of coding tasks through Copilot while staying the reviewer. DO NOT USE
  for tasks small enough to do inline, or when the user wants the code written directly without
  delegating.
license: MIT
metadata:
  version: 0.1.0
---

# Copilot Delegate

You are the **orchestrator**. Hand a bounded coding task to a separate **implementer** — the GitHub
Copilot CLI (`copilot`) — then review what it produced and land it yourself. You write the brief and
own the judgment; Copilot does the typing in its own session; you verify and commit.

The loop needs only a shell command and file access, so any comparable orchestrator can drive it.

## When NOT to use this

- The task is small enough to do inline; delegation overhead is not worth it.
- The `copilot` CLI is not installed or authenticated.
- You need strict enforcement of no writes — Copilot CLI's tool denials are best-effort constraints,
  not a hard sandbox. Use `touchedFiles` and the diff after every run, not a flag, as the guarantee.

## Prerequisites (check once)

1. Install the GitHub Copilot CLI:
   - npm: `npm install -g @github/copilot`
   - Or use the official installer from the
     [GitHub Copilot CLI documentation](https://docs.github.com/en/copilot/how-tos/copilot-cli).
2. Authenticate with `copilot login` (OAuth device flow; token stored in system credential store).
   In CI/automation, set `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN`.
3. Confirm `copilot version` succeeds.
4. Work in, or point `--cd` at, the target git repository.

## Choose the model

Copilot uses its own configured default when `--model` is omitted. To use a specific model, pass
`--model <name>` (for example, `--model gpt-5.3-codex`). The `COPILOT_MODEL` environment variable is
an alternative. Do not pin versions; use a model name the human has access to.

## The loop

Run these five steps per task. Steps 1, 4, and 5 require judgment; 2 and 3 are mechanical.

### 1. Write the brief

Copilot sees only the text you send plus what it can inspect in the workspace — no chat history or
shared context. Include the goal, current state, what to change, what to leave untouched, the
project's **actual** gates, and a report contract. Tell Copilot not to commit. Keep one task per
brief. See [references/writing-the-brief.md](references/writing-the-brief.md).

### 2. Dispatch

Use the bundled helper. It wraps Copilot's non-interactive prompt mode, captures the structured
output, and writes `result.json`. (`<skill-dir>` is the installed folder containing this `SKILL.md`.)

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
# constrained mode (deny write + shell tools):  add --read-only
# full access (all tools, paths, URLs; opt-in): add --allow-all
# autopilot mode (multi-step autonomous):       add --autopilot
# choose a model:                               add --model <name>
# continue the most recent session:             add --resume-last  (delta brief only)
# see all options:                              node .../relay.mjs --help
```

The child process's cwd pins the workspace. Use `--add-dir` for extra workspace directories. The
relay writes artifacts under the system temp dir by default and never commits. See
[references/dispatch-and-poll.md](references/dispatch-and-poll.md).

### 3. Wait for completion

The helper blocks until Copilot finishes. Run it with the orchestrator's background-command
facility, or background it in the shell and poll for `result.json`. A pre-run usage error exits 2
and writes no result; a missing `copilot` exits 127 and writes `status: "copilot_unavailable"`.

Completion means the process exited and `result.json` exists with a `status` field.

### 4. Review — do not trust the self-report

Treat Copilot's final message and gate claims as claims:

- Re-run the project's gates yourself.
- Read the diff against the brief, starting with `touchedFiles`.
- Run relevant guard skills if installed.
- Round-trip migrations and grep for dangling references after removals or renames.

See [references/review-and-land.md](references/review-and-land.md).

### 5. Land it

The implementer edits the working tree; **the orchestrator commits.** Commit only after the gates
pass and the diff holds. If rework is needed, send a delta brief with `--resume-last`, then review
again.

## Autonomy and permissions

Copilot CLI requires explicit permission settings to run without blocking on interactive prompts.
The relay sets them for every run:

| Relay flag | What Copilot gets | Use when |
| --- | --- | --- |
| *(default)* | `--allow-all-tools --no-ask-user` | Normal implementation — tools approved, paths scoped to cwd |
| `--read-only` | `--allow-all-tools --deny-tool=write --deny-tool=shell --no-ask-user` | Review / diagnosis — **best-effort, not enforced** (see caveat below) |
| `--allow-all` | `--allow-all --no-ask-user` | Explicit opt-in when the task needs all tools, paths, and URLs |

**`--read-only` is best-effort, not a hard guarantee.** `--deny-tool=write` and `--deny-tool=shell`
tell Copilot's model not to use those tools; deny rules take precedence over allows. However, tool
denial is a model-level constraint, not a kernel-enforced sandbox. Always confirm `touchedFiles`
after a `--read-only` run; treat the diff, not the flag, as the guarantee. The relay snapshots
`git status` before a `--read-only` run and sets `readOnlyViolation: true` in `result.json` when
the tree changed anyway.

`--allow-all` grants all tools, paths, and URLs (`--allow-all` is equivalent to
`--allow-all-tools --allow-all-paths --allow-all-urls`). Use only in isolated or trusted contexts.

## Authorization model

Delegation is something the human opts into. Once they have ("run this queue", "proceed"),
committing verified, gate-passing work is the agreed contract. Two limits remain: **surface, don't
absorb** (report Copilot's design decisions, defensible-but-unasked turns, and non-blocking
nitpicks) and **stop for scope changes** (if correct completion needs going beyond the brief, ask
instead of expanding the mandate). See [references/review-and-land.md](references/review-and-land.md).

## References

- [references/writing-the-brief.md](references/writing-the-brief.md) — structure, report contract,
  real gates, argv delivery limits, and delta briefs.
- [references/dispatch-and-poll.md](references/dispatch-and-poll.md) — flags, artifacts,
  `result.json`, autonomy modes, autopilot, polling, and failure recovery.
- [references/review-and-land.md](references/review-and-land.md) — review checklist, commit
  boundary, and rework through session continuation.
- [references/multi-task-queues.md](references/multi-task-queues.md) — sequential queues,
  constraint carry-forward, progress tracking, and the final coherence pass.
