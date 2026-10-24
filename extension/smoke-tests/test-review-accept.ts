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
import { registerReviewAcceptGuard, reviewStateRefusal } from "../src/review-accept-guard.ts";
import { FINDINGS_FILE } from "../src/review-state-path.ts";
import {
  type FindingRun,
  readBranchRows,
  recordFindingRunOutcome,
} from "../src/review-findings-store.ts";

/** A round's decisions, or undefined when nothing was recorded (the outcome's reason is not needed here). */
const decide = async (run: FindingRun) => {
  const out = await recordFindingRunOutcome(run);
  return out.ok ? out.decisions : undefined;
};

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

// The operator's shell: this process's env minus any agent-context variable, so
// the suite passes whether or not it was itself spawned by a pi-rukas role.
const AGENT_VARS = ["PI_ENSEMBLE_ROLE", "PI_ENSEMBLE_SUBAGENT_MODE", "PI_ENSEMBLE_TRUST_MODE"];
const OPERATOR_ENV: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter(
    (e): e is [string, string] => e[1] !== undefined && !AGENT_VARS.includes(e[0]),
  ),
);

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
  const run = await decide({
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
    review: "full",
  });
  const rowId = run?.[0]?.rowId ?? "";
  assert(/^[0-9a-f]{8}$/.test(rowId), "setup: a finding row exists");

  const bad = await runReviewAccept(["feat/x", rowId, "--reason", "short"], dir, OPERATOR_ENV);
  assert(bad.code === 2, "accept: a short reason exits 2 and writes nothing");
  assert(
    (await readBranchRows(dir, "feat/x"))[0]?.status === "open",
    "accept: the refused reason left the row open",
  );

  const ok = await runReviewAccept(
    ["feat/x", rowId, "--reason", "known, tracked in a follow-up issue"],
    dir,
    OPERATOR_ENV,
  );
  assert(ok.code === 0, `accept: a valid acceptance exits 0 (${ok.message})`);
  const row = (await readBranchRows(dir, "feat/x"))[0];
  assert(
    row?.status === "accepted" && row.acceptance?.by === "operator@example.com",
    "accept: the row is accepted and accepted.by is the git operator identity",
  );

  git(dir, "config", "--unset", "user.email");
  // Isolate from the host's global git config: a machine with a global
  // user.email would otherwise supply an identity and the refusal never fires.
  // runReviewAccept's env argument only drives agent detection; the identity
  // lookup inherits process.env, so the isolation is set there.
  const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
  const savedNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  const noId = await runReviewAccept(
    ["feat/x", rowId, "--reason", "known, tracked in a follow-up issue"],
    dir,
    OPERATOR_ENV,
  ).finally(() => {
    // `Reflect.deleteProperty`, NOT an `undefined` assignment: on `process.env` an
    // assignment coerces its value, so assigning the undefined literal leaves the STRING
    // "undefined" in the child's environment — the opposite of removing the variable.
    // Biome's noDelete rule is why `delete` is not used either.
    if (savedGlobal === undefined) Reflect.deleteProperty(process.env, "GIT_CONFIG_GLOBAL");
    else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
    if (savedNoSystem === undefined) Reflect.deleteProperty(process.env, "GIT_CONFIG_NOSYSTEM");
    else process.env.GIT_CONFIG_NOSYSTEM = savedNoSystem;
  });
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
    { cwd: dir, encoding: "utf8", env: OPERATOR_ENV },
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
  return c.includes("registerTool") && c.includes("acceptFinding");
});
assert(registersAcceptance.length === 0, "boundary: no Pi tool registers acceptance");

// The guard's own contract (what it refuses, what it must leave alone) lives in
// test-review-state-guard.ts. What this suite pins is that the guard is WIRED:
// one tool_call hook, registered from the mode-independent block, that blocks the
// store's location in every mode. The refusal rows here are the minimum needed to
// prove the wiring reaches both branches (bash and the edit tools).
const STATE_LEAF = "review-state";
const D = String.fromCharCode(36);
const bashRefused = (c: string): boolean =>
  reviewStateRefusal("bash", { command: c }) !== undefined;

const STORE_PATH = `~/.pi/agent/${STATE_LEAF}/deadbeef01234567/${FINDINGS_FILE}`;
for (const c of [
  `cat ${STORE_PATH}`,
  `cp /tmp/x ${STORE_PATH}`,
  `echo ${FINDINGS_FILE}`,
  // A path built in a variable is still the store's path (#1764 criterion 6).
  `F=${STORE_PATH}; cat $F`,
  `export F=~/.pi/agent/${STATE_LEAF}; ls $D{F}`,
  // A runtime writing the store by its basename names the store, so the path
  // guard refuses it — the row the old shell-semantics guard refused for a
  // SHAPE, this one refuses for the NAME.
  "node -e \"require('fs').writeFileSync('review-findings.json','{}')\"",
]) {
  assert(bashRefused(c), `guard: refuses a command naming the store — ${c.slice(0, 48)}`);
}
for (const c of [
  "git status",
  "bun test smoke-tests/test-review-accept.ts",
  'git commit -m "feat: review-accept guard"',
  'git commit -m "docs: review-accept flow"',
  "git diff HEAD -- extension/src/review-accept-guard.ts",
  // #1764 — the operator CLI spelled by an agent is NOT this guard's business: the
  // script lives in the repository, so refusing its name would refuse the prose that
  // discusses it (criterion 12). The CLI's own agent-context check refuses it, and
  // test-review-accept-layers.ts asserts that layer.
  "bun extension/scripts/review-accept.ts feat/x deadbeef --reason 'a reason that is long enough'",
  "cd extension && bunx tsx scripts/review-accept.ts main 0123abcd --reason y",
  "git show HEAD:README.md --output=/tmp/readme.txt",
  'gh pr create --body "Adds the review-accept acceptance path"',
  "echo review-acceptance-notes",
  "gh pr view 1105",
  "glab mr view 12",
]) {
  assert(
    !bashRefused(c),
    `guard: an ordinary command is never refused — ${c.slice(0, 48)}`,
  );
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
    input: { command: `cat ~/.pi/agent/${STATE_LEAF}/k/t/${FINDINGS_FILE}` },
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
