# Working on delegate-skills

This repo is a [Skills CLI](https://github.com/vercel-labs/skills) package of **agent-relay skills** —
skills that let an orchestrating agent drive a separate CLI coding agent as an implementer, then review
and land the result. The first skill is `codex-delegate` (OpenAI Codex); siblings like `gemini-delegate`
can be added later without renaming the repo.

## Conventions

- **One skill per directory** under `skills/<name>/`, each with a `SKILL.md` plus optional
  `references/` and `scripts/`. The verb is the repo (`delegate`); the target agent is the skill name
  (`codex-delegate`), mirroring `guard-skills` → `clean-code-guard`.
- **`SKILL.md` frontmatter:** `name` (must equal the directory), `description`, and optionally
  `license`, `compatibility`, `metadata.version`, `allowed-tools`. The **`description` is the only
  triggering signal** — keep it to what the skill does and when to use it, phrased to trigger reliably.
  Provenance, status caveats, and how-it-works detail go in the body or here, never in the description.
- **Progressive disclosure:** keep `SKILL.md` lean; push depth into `references/*.md` that load only
  when needed.
- **Executables:** keep them minimal and inspectable. The only one today is
  `skills/codex-delegate/scripts/relay.mjs` — Node built-ins only, no dependencies, no network calls of
  its own, no credentials, no telemetry. New scripts must hold the same line, and the README's trust
  section must stay accurate.

## Before publishing a change

- Validate the package locally: `npx skills add . --list`.
- Smoke-test any changed script directly (e.g. `node skills/codex-delegate/scripts/relay.mjs --help`,
  and a `--read-only` run against a throwaway repo) before relying on it.
- Keep the README's "Verification status" honest — claim only what's been run.

## Local Claude Code config

Claude Code reads `CLAUDE.md`, not `AGENTS.md`. If you want this file active while working here in
Claude Code, symlink it (it's gitignored): `ln -s AGENTS.md CLAUDE.md`.
