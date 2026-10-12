#!/usr/bin/env bun
/**
 * #1105 — the operator's review-accept path and its refusals.
 *
 * Covers: argument and reason validation (≥ 20 characters, not a secret); the
 * acceptance itself in a real temp clone (operator identity from
 * `git config user.email`, row marked accepted); the CLI entry point; the
 * human-only boundary — absent from agents.json, not a registered Pi tool, and
 * refused for agent bash by the mode-independent guard.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MIN_REASON_CHARS,
  parseAcceptArgs,
  reasonProblem,
  runReviewAccept,
} from "../scripts/review-accept.ts";
import { registerReviewAcceptGuard, runsReviewAccept } from "../src/review-accept-guard.ts";
import { readBranchRows, recordFindingRun } from "../src/review-findings-store.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ── argument and reason validation ──────────────────────────────────────────

assert(typeof parseAcceptArgs([]) === "string", "args: no arguments is a usage error");
assert(typeof parseAcceptArgs(["feat/x", "deadbeef"]) === "string", "args: --reason is required");
assert(
  typeof parseAcceptArgs(["feat/x", "NOTHEX!!", "--reason", "x"]) === "string",
  "args: the row id must be 8 hex",
);
assert(
  typeof parseAcceptArgs(["feat/x", "deadbeef", "--reason"]) === "string",
  "args: --reason needs a value",
);
assert(
  typeof parseAcceptArgs(["feat/x", "deadbeef", "--by", "me", "--reason", "x"]) === "string",
  "args: no --by option — identity comes from git",
);
const parsed = parseAcceptArgs(["feat/x", "deadbeef", "--reason", "a reason of enough length"]);
assert(
  typeof parsed !== "string" && parsed.rowId === "deadbeef" && parsed.branch === "feat/x",
  "args: a valid invocation parses",
);

assert(MIN_REASON_CHARS === 20, "reason: the minimum is 20 characters");
assert(reasonProblem("too short") !== undefined, "reason: under 20 characters is refused");
assert(
  reasonProblem("   padded    ") !== undefined,
  "reason: whitespace does not count toward the minimum",
);
assert(
  reasonProblem("token=abcdefghijklmnop123456 is what we use here") !== undefined,
  "reason: a reason that looks like a secret is refused",
);
assert(
  reasonProblem("tracked in #1234, out of scope for this change") === undefined,
  "reason: a long, plain reason is accepted",
);

// ── acceptance in a real clone ──────────────────────────────────────────────

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const dir = mkdtempSync(path.join(os.tmpdir(), "review-accept-"));
try {
  git(dir, "init", "-q", "-b", "feat/x");
  git(dir, "config", "user.email", "operator@example.com");
  git(dir, "config", "user.name", "op");
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "src", "a.ts"), "export function alpha() {\n  return 1 / 0;\n}\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "c");
  const head = git(dir, "rev-parse", "HEAD");
  const run = await recordFindingRun({
    cwd: dir,
    branch: "feat/x",
    headSha: head,
    findings: [
      {
        lens: "SIMPLICITY",
        severity: "MEDIUM",
        path: "src/a.ts",
        line: 2,
        title: "Division by zero",
      },
    ],
    complete: true,
  });
  const rowId = run?.[0]?.rowId ?? "";
  assert(/^[0-9a-f]{8}$/.test(rowId), "setup: a finding row exists");

  const bad = await runReviewAccept(["feat/x", rowId, "--reason", "short"], dir);
  assert(bad.code === 2, "accept: a short reason exits 2 and writes nothing");
  assert(
    (await readBranchRows(dir, "feat/x"))[0]?.status === "open",
    "accept: the refused reason left the row open",
  );

  const ok = await runReviewAccept(
    ["feat/x", rowId, "--reason", "known, tracked in a follow-up issue"],
    dir,
  );
  assert(ok.code === 0, `accept: a valid acceptance exits 0 (${ok.message})`);
  const row = (await readBranchRows(dir, "feat/x"))[0];
  assert(
    row?.status === "accepted" && row.acceptance?.by === "operator@example.com",
    "accept: the row is accepted and accepted.by is the git operator identity",
  );

  git(dir, "config", "--unset", "user.email");
  const noId = await runReviewAccept(
    ["feat/x", rowId, "--reason", "known, tracked in a follow-up issue"],
    dir,
  );
  assert(noId.code === 2, "accept: no git identity refuses (the operator must be known)");

  // The CLI entry point, run as the operator would (a refusal exits 2).
  const cli = spawnSync(
    process.execPath,
    [
      path.join(import.meta.dir, "..", "scripts", "review-accept.ts"),
      "feat/x",
      rowId,
      "--reason",
      "x",
    ],
    { cwd: dir, encoding: "utf8" },
  );
  assert(cli.status === 2, "cli: a short reason exits 2 from the entry point");
  assert(cli.stderr.includes("at least 20"), "cli: the refusal names the reason rule on stderr");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ── the human-only boundary ─────────────────────────────────────────────────

const repoExt = path.join(import.meta.dir, "..");
const agents = readFileSync(path.join(repoExt, "..", "agents.json"), "utf8");
assert(!agents.includes("review-accept"), "boundary: review-accept is absent from agents.json");

const srcFiles = readdirSync(path.join(repoExt, "src")).filter((f) => f.endsWith(".ts"));
const contents = new Map(
  srcFiles.map((f) => [f, readFileSync(path.join(repoExt, "src", f), "utf8")]),
);
const importsScripts = srcFiles.filter((f) =>
  /from ["']\.\.\/scripts\//.test(contents.get(f) ?? ""),
);
assert(importsScripts.length === 0, "boundary: no src module imports the operator script");
const registersAcceptance = srcFiles.filter((f) => {
  const c = contents.get(f) ?? "";
  return c.includes("registerTool") && c.includes("acceptRow");
});
assert(registersAcceptance.length === 0, "boundary: no Pi tool registers acceptRow");

const agentCommands = [
  "bun extension/scripts/review-accept.ts feat/x deadbeef --reason 'a reason that is long enough'",
  "oo bun extension/scripts/review-accept.ts feat/x deadbeef --reason x",
  'bun "extension/scripts/review-accept.ts" feat/x deadbeef --reason x',
  "cd extension && bunx tsx scripts/review-accept.ts main 0123abcd --reason y",
];
for (const c of agentCommands) {
  assert(
    runsReviewAccept(c) !== undefined,
    `guard: refuses an agent run of the script — ${c.slice(0, 48)}`,
  );
}
for (const c of [
  "git status",
  "bun test smoke-tests/test-review-accept.ts",
  "echo review-acceptance-notes",
]) {
  assert(runsReviewAccept(c) === undefined, `guard: leaves unrelated commands alone — ${c}`);
}

const handlers: Record<string, (e: unknown, c: unknown) => Promise<unknown>> = {};
registerReviewAcceptGuard({
  on: (ev: string, fn: (e: unknown, c: unknown) => Promise<unknown>) => {
    handlers[ev] = fn;
  },
} as never);
const verdict = (await handlers.tool_call?.(
  {
    toolName: "bash",
    input: { command: "bun extension/scripts/review-accept.ts feat/x deadbeef --reason x" },
  },
  {},
)) as { block?: boolean } | undefined;
assert(
  verdict?.block === true,
  "guard: the tool_call hook blocks the agent bash invocation in every mode",
);
const allowed = (await handlers.tool_call?.({ toolName: "read", input: {} }, {})) as
  | { block?: boolean }
  | undefined;
assert(allowed === undefined, "guard: non-bash tools pass through");

process.exit(exit);
