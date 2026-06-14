# delegate-skills

[![skills.sh](https://skills.sh/b/amElnagdy/delegate-skills)](https://skills.sh/amElnagdy/delegate-skills)

Skills for **delegating coding work to a separate CLI agent and landing it yourself**. Your agent (the
orchestrator) writes a self-contained brief, hands it to an implementer CLI, then reviews the diff and
commits — staying the reviewer the whole way.

The first skill, **`codex-delegate`**, drives the OpenAI Codex CLI. A `gemini-delegate` and other
implementers can live alongside it later — the repo name is the verb, the target agent lives in the
skill name (mirroring how [`guard-skills`](https://github.com/amElnagdy/guard-skills) holds
`clean-code-guard`, `test-guard`, …).

## Install

Browse first:

```bash
npx skills add amElnagdy/delegate-skills --list
```

Install the package, or just one skill:

```bash
npx skills add amElnagdy/delegate-skills
npx skills add amElnagdy/delegate-skills --skill codex-delegate
```

Install for a specific agent, or globally:

```bash
npx skills add amElnagdy/delegate-skills --skill codex-delegate --agent claude-code
npx skills add amElnagdy/delegate-skills --global
```

Works with any orchestrating agent the [Skills CLI](https://github.com/vercel-labs/skills) supports.

## What it does

The loop, for `codex-delegate`:

1. **Write a brief** — a self-contained task spec; Codex sees only what you send.
2. **Dispatch** it with the bundled `relay.mjs` (a thin `codex exec` wrapper).
3. **Wait** for completion — the helper writes a structured `result.json`.
4. **Review** the diff — re-run the project's gates yourself; pair with guard skills.
5. **Land** it — *you* commit, because the implementer's sandbox can't reliably write `.git`.

```text
Use $codex-delegate to have Codex implement the refactor in services/billing/, then review and commit it.
Use $codex-delegate to run this queue of migration tasks through Codex while I review each one.
```

## How this differs from the OpenAI Codex plugin

The official [openai-codex Claude Code plugin](https://github.com/openai/codex) is excellent and
**complementary** — this skill builds on the same `codex` CLI, it doesn't replace the plugin. They
point in different directions:

- The plugin's `codex:codex-rescue` agent is a **forwarder**: it hands one task to Codex and returns
  the output. It deliberately does not poll, review, or commit.
- The plugin's review command and stop-gate run the **inverse** direction: **Codex reviews your work**.
- `codex-delegate` is the **orchestration loop in the other direction**: *you* drive Codex to
  implement across one task or a queue, and *you* review and land each result. That loop — brief →
  dispatch → poll → review → commit, with the orchestrator owning the commit — is what the plugin
  leaves to you, and what this skill encodes.

If you have the plugin installed, its companion CLI is an optional alternative dispatch backend; the
bundled `relay.mjs` is the default because it needs nothing but the `codex` binary.

## The skills

### codex-delegate

Drive the OpenAI Codex CLI as a background implementer: write the brief, dispatch via `relay.mjs`,
review the diff, commit it yourself. Ships four references (writing the brief, dispatch/poll, review/
land, multi-task queues) loaded only when needed, and one small helper script.

**You'll feel it when:** a bounded task — a migration, a mechanical refactor, a removal sweep — gets
handed to Codex, comes back as a clean diff with a structured report, and you commit it after re-running
the gates yourself instead of typing it all by hand.

### gemini-delegate

*Planned.* A relay for the Gemini CLI, if and when it gains a comparable non-interactive mode. Reserved
so the umbrella can grow without a rename.

## Requirements

- The [`codex` CLI](https://github.com/openai/codex) installed and authenticated (`codex login`).
- Node 18+ and `git`.
- An orchestrating agent that can run shell commands and read files.

## Trust and validation

This package is intentionally inspectable:

- All skill content is Markdown, plus exactly **one** executable: `skills/codex-delegate/scripts/relay.mjs`.
- `relay.mjs` itself makes no network calls, reads or writes no credentials, sends no telemetry, and
  has no dependencies (Node built-ins only). It shells out only to `codex` and `git`. The `codex`
  process it launches authenticates exactly as you do at the terminal. Read the script before you run it.
- It never commits — committing is always the orchestrator's job, after review.

**Verification status:** the loop is verified on Claude Code. Other shell-capable orchestrators
(OpenCode, Cursor, …) are designed-for but not yet verified — the skill is written orchestrator-neutral
so they should work, and that line gets upgraded to "verified" with evidence, not assumption.

## Repository shape

```text
skills/
└── codex-delegate/
    ├── SKILL.md
    ├── scripts/relay.mjs
    └── references/
        ├── writing-the-brief.md
        ├── dispatch-and-poll.md
        ├── review-and-land.md
        └── multi-task-queues.md
```

The `SKILL.md` stays small so it loads cheaply; the references load only when the task needs them.

## License

MIT — see [LICENSE](LICENSE).
