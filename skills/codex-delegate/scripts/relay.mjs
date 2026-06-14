#!/usr/bin/env node
/**
 * delegate-skills · codex-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to the OpenAI Codex CLI (`codex exec`),
 * capture the run, and write a structured result the orchestrating agent can
 * review. The orchestrator runs this one command and reads the result JSON —
 * every Codex-specific mechanic lives in here, which keeps the skill
 * orchestrator-agnostic. Verified on Claude Code; other shell-capable agents
 * (OpenCode, Cursor, …) are designed-for but not yet verified.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `codex` and `git`. The `codex` process it
 * launches does authenticate — exactly as you do at the terminal. Read this
 * file before you run it.
 *
 * It deliberately does NOT commit. Whether Codex's sandbox can write `.git`
 * varies by Codex version, OS, and execution path, so committing is always the
 * orchestrator's job — after it reviews the diff and re-runs the project gates.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Path to the brief. If omitted, the brief is read from stdin.
 *   --cd <dir>              Working root for Codex (default: current directory).
 *   --model <name>          Codex model (default: Codex's own configured default).
 *   --sandbox <mode>        read-only | workspace-write | danger-full-access
 *                           (default: workspace-write).
 *   --read-only             Shortcut for --sandbox read-only (review/diagnosis, no edits).
 *   --resume-last           Continue the most recent Codex session; send only the delta brief.
 *                           (Inherits the original session's sandbox and working root.)
 *   --skip-git-repo-check   Allow running outside a git repository.
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir under
 *                           the system temp dir, so the repo under review stays clean).
 *   -h, --help              Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout —
 *   status, exitCode, codexVersion, threadId (for a later resume), finalMessage
 *   (Codex's own report), touchedFiles (git porcelain), and the paths to
 *   events.jsonl and final.txt.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief) exits 2
 * before any run and writes no result file; a missing `codex` binary exits 127;
 * otherwise the exit code mirrors Codex's own (0 success, non-zero failure).
 * Once the brief validates, `result.json` is written on every outcome —
 * completed, failed, or codex_unavailable. An orchestrator that polls for the
 * file must therefore also treat a non-zero exit with no file as a usage error.
 */

import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";

const SANDBOX_MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);

function fail(message, code = 2) {
  process.stderr.write(`relay: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = {
    brief: null,
    cd: process.cwd(),
    model: null,
    sandbox: "workspace-write",
    resumeLast: false,
    skipGitRepoCheck: false,
    outDir: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) fail(`${arg} requires a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "-h":
      case "--help":
        process.stdout.write(headerComment());
        process.exit(0);
        break;
      case "--brief": opts.brief = next(); break;
      case "--cd": opts.cd = resolve(next()); break;
      case "--model": opts.model = next(); break;
      case "--sandbox": opts.sandbox = next(); break;
      case "--read-only": opts.sandbox = "read-only"; break;
      case "--resume-last": opts.resumeLast = true; break;
      case "--skip-git-repo-check": opts.skipGitRepoCheck = true; break;
      case "--out-dir": opts.outDir = resolve(next()); break;
      default:
        fail(`unknown option: ${arg}`);
    }
  }
  if (!SANDBOX_MODES.has(opts.sandbox)) {
    fail(`invalid --sandbox "${opts.sandbox}" (expected: ${[...SANDBOX_MODES].join(", ")})`);
  }
  return opts;
}

function headerComment() {
  // The leading block comment doubles as --help text.
  const src = readFileSync(new URL(import.meta.url), "utf8");
  const match = src.match(/\/\*\*([\s\S]*?)\*\//);
  if (!match) return "relay.mjs — dispatch a brief to codex exec\n";
  return match[1].replace(/^\s*\* ?/gm, "").trim() + "\n";
}

function readBrief(opts) {
  if (opts.brief) {
    if (!existsSync(opts.brief)) fail(`brief file not found: ${opts.brief}`);
    return readFileSync(opts.brief, "utf8");
  }
  // No --brief: read from stdin (fd 0). Empty stdin is an error.
  let stdin = "";
  try {
    stdin = readFileSync(0, "utf8");
  } catch {
    stdin = "";
  }
  return stdin;
}

function codexVersion() {
  try {
    return execFileSync("codex", ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function gitTouchedFiles(cwd) {
  try {
    const out = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
    return out.split("\n").map((line) => line.trimEnd()).filter(Boolean);
  } catch {
    return [];
  }
}

function timestamp() {
  // Local script (not a workflow): Date is available and fine here.
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function buildArgv(opts, finalPath) {
  const argv = ["exec"];
  if (opts.resumeLast) argv.push("resume", "--last");
  argv.push("--json", "-o", finalPath);
  // `-s`/`-C` are not accepted by `exec resume`; resume inherits the original
  // session's sandbox and working root, and we set the child process cwd below.
  if (!opts.resumeLast) {
    argv.push("-s", opts.sandbox);
  }
  if (opts.model) argv.push("-m", opts.model);
  if (opts.skipGitRepoCheck) argv.push("--skip-git-repo-check");
  argv.push("-"); // read the prompt from stdin
  return argv;
}

function extractThreadId(event) {
  return (
    event.thread_id ??
    event.threadId ??
    (event.thread && (event.thread.thread_id ?? event.thread.id)) ??
    null
  );
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const brief = readBrief(opts);
  if (!brief.trim()) fail("empty brief (pass --brief <file> or pipe the brief on stdin)");

  const version = codexVersion();
  const startedAt = new Date().toISOString();
  // Default the run dir to system temp so the repo under review stays pristine —
  // the touched-files report must show only Codex's edits, not relay's artifacts.
  const outDir = opts.outDir || join(tmpdir(), "delegate-relay", `${basename(opts.cd) || "repo"}-${timestamp()}`);
  mkdirSync(outDir, { recursive: true });

  const eventsPath = join(outDir, "events.jsonl");
  const finalPath = join(outDir, "final.txt");
  const briefPath = join(outDir, "brief.txt");
  const resultPath = join(outDir, "result.json");
  writeFileSync(briefPath, brief, "utf8");
  writeFileSync(eventsPath, "", "utf8");

  const writeResult = (extra) => {
    const finishedAt = new Date().toISOString();
    const result = {
      schema: "delegate-relay.result.v1",
      workdir: opts.cd,
      sandbox: opts.resumeLast ? "(inherited from resumed session)" : opts.sandbox,
      model: opts.model,
      resumeLast: opts.resumeLast,
      codexVersion: version,
      startedAt,
      finishedAt,
      briefPath,
      eventsPath,
      finalPath: existsSync(finalPath) ? finalPath : null,
      ...extra,
    };
    writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    return result;
  };

  if (!version) {
    const result = writeResult({ status: "codex_unavailable", exitCode: 127, threadId: null, finalMessage: "", touchedFiles: [] });
    printSummary(result, resultPath);
    process.stderr.write("relay: `codex` not found on PATH. Install it (npm i -g @openai/codex) and run `codex login`.\n");
    process.exit(127);
  }

  const argv = buildArgv(opts, finalPath);
  const child = spawn("codex", argv, { cwd: opts.cd, stdio: ["pipe", "pipe", "pipe"] });

  let threadId = null;
  let stdoutBuf = "";
  const stderrTail = [];

  child.stdout.on("data", (chunk) => {
    stdoutBuf += chunk.toString();
    let nl;
    while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line.trim()) continue;
      appendFileSync(eventsPath, `${line}\n`, "utf8");
      try {
        const event = JSON.parse(line);
        const tid = extractThreadId(event);
        if (tid) threadId = tid;
      } catch {
        // Non-JSON progress line; it is preserved in events.jsonl regardless.
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    process.stderr.write(text); // surface Codex progress live for the orchestrator
    for (const line of text.split("\n")) {
      if (line.trim()) stderrTail.push(line.trimEnd());
    }
    while (stderrTail.length > 20) stderrTail.shift();
  });

  child.on("error", (err) => {
    const result = writeResult({ status: "failed", exitCode: 1, threadId, finalMessage: "", touchedFiles: gitTouchedFiles(opts.cd), error: String(err && err.message ? err.message : err) });
    printSummary(result, resultPath);
    process.exit(1);
  });

  child.on("close", (code) => {
    if (stdoutBuf.trim()) {
      appendFileSync(eventsPath, `${stdoutBuf}\n`, "utf8");
      try {
        const tid = extractThreadId(JSON.parse(stdoutBuf));
        if (tid) threadId = tid;
      } catch {
        // A newline-less final line that isn't valid JSON; preserved in the log only.
      }
    }
    const finalMessage = existsSync(finalPath) ? readFileSync(finalPath, "utf8").trim() : "";
    const result = writeResult({
      status: code === 0 ? "completed" : "failed",
      exitCode: code === null ? 1 : code,
      threadId,
      finalMessage,
      touchedFiles: gitTouchedFiles(opts.cd),
      ...(code === 0 ? {} : { stderrTail: stderrTail.slice(-20) }),
    });
    printSummary(result, resultPath);
    process.exit(result.exitCode);
  });

  // If the child failed to launch, writing to its stdin can emit a stray 'error'
  // on the pipe; the 'error' handler above owns that outcome, so swallow it here.
  child.stdin.on("error", () => {});
  child.stdin.write(brief);
  child.stdin.end();
}

function printSummary(result, resultPath) {
  const lines = [];
  lines.push("");
  lines.push(`relay: ${result.status} (exit ${result.exitCode})  ·  codex ${result.codexVersion ?? "?"}`);
  if (result.resumeLast) lines.push("mode: resumed most recent session");
  if (result.threadId) lines.push(`thread id (resume with: codex exec resume ${result.threadId}): ${result.threadId}`);
  const touched = result.touchedFiles || [];
  lines.push(`touched files: ${touched.length}`);
  for (const file of touched.slice(0, 40)) lines.push(`  ${file}`);
  if (touched.length > 40) lines.push(`  … and ${touched.length - 40} more`);
  if (result.stderrTail && result.stderrTail.length) {
    lines.push("last stderr:");
    for (const line of result.stderrTail.slice(-8)) lines.push(`  ${line}`);
  }
  lines.push("");
  lines.push("--- codex final report ---");
  lines.push(result.finalMessage || "(no final message captured)");
  lines.push("--- end report ---");
  lines.push("");
  lines.push(`result: ${resultPath}`);
  lines.push("relay does not commit. Review the diff, re-run the project gates yourself, then commit from the orchestrator.");
  process.stdout.write(`${lines.join("\n")}\n`);
}

main();
