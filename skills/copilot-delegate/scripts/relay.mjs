#!/usr/bin/env node
/**
 * delegate-skills · copilot-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to the GitHub Copilot CLI (`copilot -p`),
 * capture the run, and write a structured result the orchestrating agent can
 * review. The orchestrator runs this one command and reads the result JSON —
 * every Copilot-specific mechanic lives in here, which keeps the skill
 * orchestrator-agnostic.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `copilot` and `git`. The `copilot` process it
 * launches does authenticate — exactly as you do at the terminal. Read this
 * file before you run it.
 *
 * The brief is passed to `copilot` via `-p BRIEF` (CLI argument), so it is
 * visible in the host process list (`ps`, /proc). On a shared machine keep
 * secrets out of the brief; reference workspace files or environment variables
 * instead. The OS caps individual arguments (~128KB on Linux); the relay
 * rejects briefs over 120 KB before launch.
 *
 * It deliberately does NOT commit. Committing is always the orchestrator's job —
 * after it reviews the diff and re-runs the project gates.
 *
 * The relay sets tool permissions explicitly to avoid blocking on interactive
 * prompts in a non-interactive pipe:
 *   default       — `--allow-all-tools --no-ask-user` (all tools approved
 *                    without prompting; paths scoped to cwd; no extra URL
 *                    permissions beyond cwd defaults)
 *   --read-only   — additionally `--deny-tool=write --deny-tool=shell`
 *                    (best-effort; verify touchedFiles afterward)
 *   --allow-all   — `--allow-all --no-ask-user` (all tools, paths, and URLs;
 *                    explicit opt-in for isolated/trusted contexts only)
 *
 * `--read-only` is best-effort: deny rules are model-level constraints, not a
 * kernel-enforced sandbox. The relay snapshots the tree before a read-only run
 * and flags readOnlyViolation:true in result.json if the tree changed anyway.
 *
 * On Windows, `copilot` (npm package @github/copilot) installs as a `.cmd`
 * shim. The relay launches it with shell:true on win32 so the shim resolves.
 * Path arguments are quoted for the Windows shell; --model and --agent are
 * restricted to safe token characters. Note: Windows support is not yet
 * smoke-tested — see README verification status.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>                Path to the brief. If omitted, read from stdin.
 *   --cd <dir>                    Working root for Copilot (default: current directory).
 *   --model <name>                Copilot model (default: Copilot's own configured default).
 *   --read-only                   Constrained mode: deny write and shell tools (best-effort).
 *                                 The relay flags a violation if the tree changes anyway.
 *   --allow-all                   Full access: all tools, paths, and URLs (--allow-all).
 *                                 Explicit opt-in for isolated/trusted contexts only.
 *   --autopilot                   Enable autopilot mode (multi-step autonomous completion).
 *                                 Requires --max-autopilot-continues or uses default (20).
 *   --max-autopilot-continues <n> Maximum autopilot continuation steps (positive integer;
 *                                 default 20 when --autopilot is used).
 *   --agent <name>                Custom Copilot agent to use (--agent=<name>).
 *   --add-dir <dir>               Add an extra allowed directory (--add-dir=DIR). Repeatable.
 *   --resume-last                 Continue the most recent Copilot session (--continue);
 *                                 send only the delta brief.
 *   --timeout <dur>               Relay watchdog (default: 30m). Copilot has no CLI timeout.
 *                                 Duration format: h/m/s strings like 30m, 90s, 1h30m.
 *   --out-dir <dir>               Where to write run artifacts (default: a fresh dir under
 *                                 the system temp dir, so the repo under review stays clean).
 *   -h, --help                    Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout —
 *   schema, tool ("copilot"), status (completed | failed | copilot_unavailable),
 *   exitCode, signal, copilotVersion, autonomy, model, autopilot, resumed,
 *   sessionId, startedAt, finishedAt, finalMessage (Copilot's own report),
 *   touchedFiles (git porcelain, null if git cannot report), readOnlyViolation
 *   (when --read-only and the tree changed), briefPath, finalPath, eventsPath,
 *   stderrPath, and stderrTail on failure.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief) exits 2
 * before any run and writes no result file; a missing `copilot` binary exits
 * 127; otherwise the exit code mirrors Copilot's own (0 success, non-zero
 * failure). If the child dies on a signal, the exit code is 128 plus the
 * signal number and result.json records the signal. Once the brief validates,
 * result.json is written on every outcome — completed, failed, or
 * copilot_unavailable.
 */

import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { constants, tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_TIMEOUT = "30m";
const DEFAULT_MAX_AUTOPILOT_CONTINUES = 20;

function fail(message, code = 2) {
  process.stderr.write(`relay: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = {
    brief: null,
    cd: process.cwd(),
    model: null,
    autonomy: "default",
    autopilot: false,
    maxAutopilotContinues: null,
    agent: null,
    addDirs: [],
    resumeLast: false,
    timeout: DEFAULT_TIMEOUT,
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
      case "--read-only": opts.autonomy = "read-only"; break;
      case "--allow-all": opts.autonomy = "allow-all"; break;
      case "--autopilot": opts.autopilot = true; break;
      case "--max-autopilot-continues": opts.maxAutopilotContinues = next(); break;
      case "--agent": opts.agent = next(); break;
      case "--add-dir": opts.addDirs.push(next()); break;
      case "--resume-last": opts.resumeLast = true; break;
      case "--timeout": opts.timeout = next(); break;
      case "--out-dir": opts.outDir = resolve(next()); break;
      default:
        fail(`unknown option: ${arg}`);
    }
  }
  if (parseDuration(opts.timeout) === null) {
    fail(`--timeout "${opts.timeout}" is not a valid duration; use h/m/s strings like 30m, 90s, or 1h30m`);
  }
  // Token-validate values that reach the shell on win32 (shell:true for .cmd shim).
  const safeToken = /^[A-Za-z0-9][A-Za-z0-9._:\/-]*$/;
  for (const flag of ["model", "agent"]) {
    if (opts[flag] !== null && !safeToken.test(opts[flag])) {
      fail(`--${flag} value contains unsupported characters (allowed: letters, digits, . _ : / -)`);
    }
  }
  if (opts.maxAutopilotContinues !== null && !/^[1-9]\d*$/.test(opts.maxAutopilotContinues)) {
    fail("--max-autopilot-continues must be a positive integer");
  }
  // Resolve add-dirs against --cd (not relay cwd) after the full loop, since
  // --add-dir may appear before --cd on the command line.
  opts.addDirs = opts.addDirs.map((d) => resolve(opts.cd, d));
  return opts;
}

function headerComment() {
  // The leading block comment doubles as --help text.
  const src = readFileSync(new URL(import.meta.url), "utf8");
  const match = src.match(/\/\*\*([\s\S]*?)\*\//);
  if (!match) return "relay.mjs — dispatch a brief to copilot -p\n";
  return `${match[1].replace(/^\s*\* ?/gm, "").trim()}\n`;
}

function readBrief(opts) {
  if (opts.brief) {
    if (!existsSync(opts.brief)) fail(`brief file not found: ${opts.brief}`);
    return readFileSync(opts.brief, "utf8");
  }
  if (process.stdin.isTTY) {
    fail("no --brief given and stdin is a TTY; pass --brief <file> or pipe the brief on stdin");
  }
  let stdin = "";
  try {
    stdin = readFileSync(0, "utf8");
  } catch {
    stdin = "";
  }
  return stdin;
}

function copilotVersion() {
  try {
    // On Windows, npm installs `copilot` as a .cmd shim; spawning it without
    // shell:true ENOENTs. Use shell:true for the version probe on win32 only.
    // Prefer `copilot version` (documented subcommand); fall back to `--version`.
    try {
      return execFileSync("copilot", ["version"], {
        encoding: "utf8",
        shell: process.platform === "win32",
      }).trim();
    } catch {
      return execFileSync("copilot", ["--version"], {
        encoding: "utf8",
        shell: process.platform === "win32",
      }).trim();
    }
  } catch (err) {
    // Only a missing binary means "unavailable"; any other probe failure must
    // not masquerade as exit 127.
    if (err && err.code === "ENOENT") return null;
    return "unknown";
  }
}

function parseDuration(dur) {
  // Whole-string match: "1mtypo" must be rejected, not read as one minute.
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(dur);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return (Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) * 1000;
}

function gitTouchedFiles(cwd) {
  // null (not []) when git cannot report — git missing, or a non-repo run —
  // so the caller can tell "git unavailable" apart from "Copilot changed nothing."
  // [] means git ran and the working tree is clean.
  try {
    const out = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
    return out.split("\n").map((l) => l.trimEnd()).filter(Boolean);
  } catch {
    return null;
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function autonomyFlags(autonomy) {
  // Maps the relay's three autonomy modes onto Copilot's native permission
  // flags. Without explicit permission flags, Copilot prompts for approval in
  // a non-interactive pipe — so every path sets permissions explicitly.
  //   default    — tools approved without prompting; paths stay at cwd default;
  //                no extra URL permissions
  //   read-only  — additionally deny write and shell tools (best-effort;
  //                deny rules take precedence over --allow-all-tools, but
  //                this is a model-level constraint, not a hard sandbox)
  //   allow-all  — all tools, paths, and URLs (--allow-all = --allow-all-tools
  //                + --allow-all-paths + --allow-all-urls); opt-in only
  switch (autonomy) {
    case "read-only":
      return ["--allow-all-tools", "--deny-tool=write", "--deny-tool=shell", "--no-ask-user"];
    case "allow-all":
      return ["--allow-all", "--no-ask-user"];
    case "default":
    default:
      return ["--allow-all-tools", "--no-ask-user"];
  }
}

function buildArgv(opts, brief) {
  // On win32 with shell:true, space-containing paths must be quoted so cmd.exe
  // doesn't split them. --model and --agent are restricted to safe tokens at
  // parse time. The brief rides as a separate `-p` argument.
  const quotePath = (p) => (process.platform === "win32" ? `"${p}"` : p);
  const argv = ["--output-format=json"];
  argv.push(...autonomyFlags(opts.autonomy));
  if (opts.model) argv.push(`--model=${opts.model}`);
  if (opts.agent) argv.push(`--agent=${opts.agent}`);
  for (const dir of opts.addDirs) argv.push(`--add-dir=${quotePath(dir)}`);
  if (opts.resumeLast) argv.push("--continue");
  if (opts.autopilot) {
    argv.push("--autopilot");
    const limit = opts.maxAutopilotContinues != null
      ? opts.maxAutopilotContinues
      : DEFAULT_MAX_AUTOPILOT_CONTINUES;
    argv.push(`--max-autopilot-continues=${limit}`);
  }
  // Brief delivered as `-p BRIEF` (two separate elements). The brief is visible
  // in the process list on POSIX; keep secrets out of briefs on shared machines.
  argv.push("-p", brief);
  return argv;
}

function makeLineScanner(onObject) {
  // Copilot's --output-format=json emits JSONL (one JSON object per line).
  // Parse line-by-line; ignore non-JSON lines (decorations, blank lines, etc.).
  let partial = "";
  return (chunk) => {
    partial += chunk;
    const lines = partial.split("\n");
    partial = lines.pop(); // last element may be an incomplete line
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { onObject(JSON.parse(trimmed)); } catch { /* ignore non-JSON lines */ }
    }
  };
}

function extractText(event) {
  // Defensive extraction across possible Copilot JSONL event schemas.
  // The output format may evolve; check the most common patterns first.
  if (event.role === "assistant" && typeof event.content === "string") return event.content;
  if (event.type === "message" && event.role === "assistant" && typeof event.content === "string") return event.content;
  if (event.type === "text" && typeof event.content === "string") return event.content;
  if (event.type === "text" && typeof event.text === "string") return event.text;
  return null;
}

function extractSessionId(event) {
  // Try several field names; Copilot JSONL schema may vary across versions.
  return (
    (typeof event.sessionId === "string" ? event.sessionId : null) ??
    (typeof event.session_id === "string" ? event.session_id : null) ??
    (event.session && typeof event.session === "object"
      ? (event.session.id ?? event.session.sessionId ?? null)
      : null) ??
    (event.type === "session" && typeof event.id === "string" ? event.id : null) ??
    null
  );
}

function prepareRunDir(opts, brief) {
  const startedAt = new Date().toISOString();
  // Default to system temp so the repo under review stays pristine — the
  // touched-files report must show only Copilot's edits, not relay artifacts.
  const outDir = opts.outDir || join(
    tmpdir(), "delegate-relay", `${basename(opts.cd) || "repo"}-${timestamp()}`
  );
  mkdirSync(outDir, { recursive: true });
  const run = {
    startedAt,
    briefPath: join(outDir, "brief.txt"),
    finalPath: join(outDir, "final.txt"),
    eventsPath: join(outDir, "events.jsonl"),
    stderrPath: join(outDir, "stderr.txt"),
    resultPath: join(outDir, "result.json"),
  };
  writeFileSync(run.briefPath, brief, "utf8");
  writeFileSync(run.eventsPath, "", "utf8");
  writeFileSync(run.stderrPath, "", "utf8");
  return run;
}

function makeResultWriter(opts, version, run) {
  return (extra) => {
    const result = {
      schema: "delegate-relay.result.v1",
      tool: "copilot",
      workdir: opts.cd,
      autonomy: opts.autonomy,
      model: opts.model,
      autopilot: opts.autopilot,
      resumed: opts.resumeLast,
      copilotVersion: version,
      startedAt: run.startedAt,
      finishedAt: new Date().toISOString(),
      briefPath: run.briefPath,
      finalPath: existsSync(run.finalPath) ? run.finalPath : null,
      eventsPath: run.eventsPath,
      stderrPath: run.stderrPath,
      ...extra,
    };
    writeFileSync(run.resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    return result;
  };
}

function reportUnavailable(writeResult, resultPath) {
  const result = writeResult({
    status: "copilot_unavailable",
    exitCode: 127,
    signal: null,
    sessionId: null,
    finalMessage: "",
    touchedFiles: null,
  });
  printSummary(result, resultPath);
  process.stderr.write(
    "relay: `copilot` not found on PATH. Install the GitHub Copilot CLI " +
    "(`npm install -g @github/copilot`) and authenticate with `copilot login`.\n"
  );
  process.exit(127);
}

function dispatchToCopilot(opts, brief, run, writeResult) {
  // Snapshot the tree before a --read-only run so the relay can detect if
  // Copilot wrote anyway (readOnlyViolation in result.json).
  const beforeTree = opts.autonomy === "read-only" ? gitTouchedFiles(opts.cd) : null;
  const argv = buildArgv(opts, brief);
  // shell:true on win32 so the copilot.cmd npm shim resolves. Safe: --model
  // and --agent are token-validated; path args are quoted in buildArgv.
  const child = spawn("copilot", argv, {
    cwd: opts.cd,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  let sessionId = null;
  const textChunks = [];
  const stderrTail = [];

  const scan = makeLineScanner((event) => {
    const text = extractText(event);
    if (text) textChunks.push(text);
    const sid = extractSessionId(event);
    if (sid) sessionId = sid;
  });

  // Decode across chunk boundaries: a multibyte UTF-8 character split between
  // two data events would otherwise decode as U+FFFD and corrupt the report.
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");

  child.stdout.on("data", (chunk) => {
    appendFileSync(run.eventsPath, chunk); // faithful raw record
    scan(stdoutDecoder.write(chunk));
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk); // surface Copilot progress live for the orchestrator
    appendFileSync(run.stderrPath, chunk);
    const text = stderrDecoder.write(chunk);
    for (const line of text.split("\n")) {
      if (line.trim()) stderrTail.push(line.trimEnd());
    }
    while (stderrTail.length > 20) stderrTail.shift();
  });

  const assembleFinal = () => {
    const message = textChunks.join("\n\n").trim();
    if (message) writeFileSync(run.finalPath, message, "utf8");
    return message;
  };

  let settled = false;
  let watchdogFired = false;
  let sigkillTimer = null;
  const timeoutMs = parseDuration(opts.timeout) ?? parseDuration(DEFAULT_TIMEOUT);
  const watchdogTimer = setTimeout(() => {
    watchdogFired = true;
    child.kill("SIGTERM");
    sigkillTimer = setTimeout(() => {
      if (!settled) child.kill("SIGKILL");
    }, 10_000);
  }, timeoutMs);

  child.on("error", (err) => {
    if (settled) return;
    settled = true;
    clearTimeout(watchdogTimer);
    if (sigkillTimer) clearTimeout(sigkillTimer);
    const result = writeResult({
      status: "failed",
      exitCode: 1,
      signal: null,
      sessionId,
      finalMessage: assembleFinal(),
      touchedFiles: gitTouchedFiles(opts.cd),
      stderrTail: stderrTail.slice(-20),
      error: String(err && err.message ? err.message : err),
    });
    printSummary(result, run.resultPath);
    process.exit(1);
  });

  child.on("close", (code, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(watchdogTimer);
    if (sigkillTimer) clearTimeout(sigkillTimer);
    // A timed-out run is failed even if Copilot handles SIGTERM by exiting 0.
    const succeeded = code === 0 && !watchdogFired;
    const mapped = code ?? (constants.signals[signal] ? 128 + constants.signals[signal] : 1);
    const exitCode = succeeded ? 0 : mapped === 0 ? 1 : mapped;
    const finalMessage = assembleFinal();
    const touchedFiles = gitTouchedFiles(opts.cd);
    const result = writeResult({
      status: succeeded ? "completed" : "failed",
      exitCode,
      signal: signal ?? null,
      sessionId,
      finalMessage,
      touchedFiles,
      ...(opts.autonomy === "read-only"
        ? {
            readOnlyViolation:
              beforeTree !== null &&
              touchedFiles !== null &&
              JSON.stringify(beforeTree) !== JSON.stringify(touchedFiles),
          }
        : {}),
      ...(succeeded ? {} : { stderrTail: stderrTail.slice(-20) }),
      ...(watchdogFired
        ? { error: `copilot did not finish within --timeout ${opts.timeout}; killed by the relay watchdog` }
        : {}),
    });
    printSummary(result, run.resultPath);
    process.exit(result.exitCode);
  });
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const brief = readBrief(opts);
  if (!brief.trim()) fail("empty brief (pass --brief <file> or pipe the brief on stdin)");

  // `copilot -p` takes the prompt as a CLI argument, so the brief rides argv.
  // The OS caps one argument (~128KB on Linux via MAX_ARG_STRLEN); reject a
  // large brief early instead of an opaque E2BIG spawn failure.
  const briefBytes = Buffer.byteLength(brief, "utf8");
  const MAX_BRIEF_BYTES = 120 * 1024;
  if (briefBytes > MAX_BRIEF_BYTES) {
    fail(
      `brief is ${Math.round(briefBytes / 1024)}KB; copilot passes the prompt as a CLI argument, ` +
      `which the OS caps (~128KB on Linux). Trim it, or reference large context by file path in ` +
      `the workspace rather than inlining it in the brief.`
    );
  }

  const version = copilotVersion();
  const run = prepareRunDir(opts, brief);
  const writeResult = makeResultWriter(opts, version, run);

  if (!version) {
    reportUnavailable(writeResult, run.resultPath);
    return;
  }

  dispatchToCopilot(opts, brief, run, writeResult);
}

function printSummary(result, resultPath) {
  const lines = [];
  lines.push("");
  lines.push(
    `relay: ${result.status} (exit ${result.exitCode}${result.signal ? `, killed by ${result.signal}` : ""})` +
    `  ·  copilot ${result.copilotVersion ?? "?"}`
  );
  if (result.signal === "SIGKILL") {
    lines.push(
      "hint: the host killed the process (commonly the OOM killer or a supervisor timeout) — " +
      "this is not a copilot error; check host memory and re-dispatch, or split the task into smaller briefs."
    );
  }
  if (result.readOnlyViolation) {
    lines.push(
      "warning: this --read-only run modified the working tree — tool denial is best-effort; " +
      "review the diff before trusting the run."
    );
  }
  lines.push(`autonomy: ${result.autonomy}`);
  if (result.autopilot) lines.push("autopilot: enabled");
  if (result.resumed) lines.push("mode: resumed previous session (--continue)");
  if (result.sessionId) lines.push(`session id (resume with: --resume-last): ${result.sessionId}`);
  const touched = result.touchedFiles;
  if (touched === null) {
    lines.push("touched files: git unavailable — inspect the working tree directly");
  } else {
    lines.push(`touched files: ${touched.length}`);
    for (const file of touched.slice(0, 40)) lines.push(`  ${file}`);
    if (touched.length > 40) lines.push(`  … and ${touched.length - 40} more`);
  }
  if (result.stderrTail && result.stderrTail.length) {
    lines.push("last stderr:");
    for (const line of result.stderrTail.slice(-8)) lines.push(`  ${line}`);
  }
  lines.push("");
  lines.push("--- copilot final report ---");
  lines.push(result.finalMessage || "(no final message captured)");
  lines.push("--- end report ---");
  lines.push("");
  lines.push(`result: ${resultPath}`);
  lines.push(
    "relay does not commit. Review the diff, re-run the project gates yourself, then commit from the orchestrator."
  );
  process.stdout.write(`${lines.join("\n")}\n`);
}

main();
