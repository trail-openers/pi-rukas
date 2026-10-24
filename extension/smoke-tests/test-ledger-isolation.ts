#!/usr/bin/env bun
/**
 * #1069 — the offline suite must never touch the REAL per-clone review ledger.
 *
 * The review ledger lives under the git COMMON dir (`review-ledger-path.ts`),
 * and a worktree's common dir resolves to the MAIN clone's .git. Any test
 * that drives a lens or adversarial entry point without its own isolation
 * (the `PI_ENSEMBLE_REVIEW_LEDGER_FILE` override, a temp-repo cwd, or a
 * mocked `appendLedgerEntry`) therefore writes rows into the real per-clone
 * ledger when it runs in a worktree of this clone — the #1069 symptom was a
 * merge refused because the branch's latest lens entry said
 * passed=false/REVIEW_INCOMPLETE although the hand-run review reported
 * APPROVED (a suite run had overwritten the genuine entry).
 *
 * Three checks:
 *   1. the suite env: when the gate (verify-loop.sh) has set
 *      PI_ENSEMBLE_REVIEW_LEDGER_FILE, it names an ABSOLUTE file OUTSIDE
 *      any .git directory (the merge-guard-helpers.ts canary, in env form).
 *   2. a static scan of smoke-tests/*.ts: every file that CALLS a ledger
 *      writer seam (runLensReview / finishLensReview / writeLensLedgerEntry /
 *      appendLedgerEntry / writeAdversarialLedgerEntry / runAdversarialLoop)
 *      must carry one of the known isolation markers, or it is named as a
 *      failure.
 *   3. the scan is proved in both directions (AGENTS.md §12): a deliberately
 *      unisolated fixture IS named, an isolated one is not, the tree is clean,
 *      and the gate still carries the export.
 *   4. #1449 — no override SURVIVES into this process from the suite's own
 *      import-time helpers. Checks 1-3 ask "is the value well-shaped"; none
 *      asked "who set it, and does it outlive the code that set it". That gap
 *      is the #1449 incident: `isolateLedger` used to adopt an already-set
 *      value as its own target and never restore it, so a leak in one file
 *      redirected every later real ledger write in the process tree — including
 *      a hand-run `dispatch_lens_review` whose rows then never reached the
 *      per-clone ledger the #912 guard reads.
 *
 * The scan is name-based, so an aliased import of a writer seam would evade
 * it; runtime isolation is the primary mechanism.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execp } from "../src/exec.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// The seams that end in a real ledger write when driven without isolation:
// the two review entry points (their finish/ledger-write paths), the low
// level writer, and the two explicit writer functions.
const LEADER_SEAMS = [
  "runLensReview(",
  "finishLensReview(",
  "writeLensLedgerEntry(",
  "appendLedgerEntry(",
  "writeAdversarialLedgerEntry(",
  "runAdversarialLoop(",
] as const;

/** True when the line does NOT contain an actual call to a seam. A call is
 * the seam name followed (modulo whitespace) by `(` OUTSIDE a string
 * literal; lines that merely NAME a seam — marker arrays (the token inside
 * quotes, as in test-live-suffix-convention.ts), imports, const destructures
 * from an import, type positions, object-literal values — are not calls.
 * Comments are never calls. */
function isNotACall(line: string): boolean {
  const t = line.trim();
  if (/^(\/\/|\/\*|\*|#!|;)/.test(t)) return true; // comment (incl. doc lines)
  // Strip string literals so a seam named as DATA cannot read as a call;
  // the real call survives because its `(` is code, not a literal.
  const outsideQuotes = t
    .replace(/"[^"\\]*(?:\\.[^"\\])*"/g, "S")
    .replace(/'[^'\\]*(?:\\.[^'\\])*'/g, "S");
  for (const seam of LEADER_SEAMS) {
    const token = seam.slice(0, -1); // the name without its trailing `(`
    const re = new RegExp(token + "\\s*\\(");
    if (re.test(outsideQuotes)) return false; // a real call on this line
  }
  return true;
}

/** The #1069 isolation markers a calling file may carry. Any ONE of these is
 * sufficient; the scan fails a file only when it has a call and none. */
const ISOLATION_MARKERS = [
  // The env override — set by the file itself when run individually
  // (test-review-tools-refrange.ts, merge-guard-helpers.ts,
  // test-auto-delta-base.ts, test-lens-retry-note.ts, ...).
  "PI_ENSEMBLE_REVIEW_LEDGER_FILE",
  // The shared helper module self-isolates on import (lib/
  // review-ledger-test-helpers.ts, #1069) — importing it isolates the file.
  "review-ledger-test-helpers",
  // The findings-memory fixture (lib/review-findings-fixtures.ts, #1125) points
  // the ledger AND the findings file at a per-fixture temp dir in its factory,
  // so a test that builds its repo through `setupReviewFixture` is isolated
  // without naming the env var itself — the marker lives in the fixture.
  "setupReviewFixture",
  // A mocked writer seam (test-lens-kill-ledger.ts mocks appendLedgerEntry).
  "mock.module",
  // A temp git repo as the write cwd: the writer keys its file on the
  // common dir of the CWD it is given, and these files pass their scratch
  // repo's path — the write lands in the temp dir, never the real ledger.
  "mkdtempSync",
];

/** The scan's own file is exempt: it holds the seam list as data, not calls. */
const EXEMPT_FILES = new Set<string>(["test-ledger-isolation.ts"]);

const SMOKE_TESTS = import.meta.dirname;

// --- 1. the suite env ------------------------------------------------------
{
  const override = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  if (override === undefined || override.trim() === "") {
    console.log(
      "✓ suite env: PI_ENSEMBLE_REVIEW_LEDGER_FILE unset (standalone run — gate's export not in effect; env check skipped)",
    );
  } else {
    const abs = path.isAbsolute(override) ? override : path.resolve(process.cwd(), override);
    assert(
      abs.length > 0 && !/([/\\])\.git([/\\]|$)/.test(abs),
      `suite env: the gate's ledger override (${abs}) is NOT inside a .git directory`,
    );
    assert(path.isAbsolute(override), "suite env: the gate's ledger override is an absolute path");
  }
}

// --- 2. the static scan -----------------------------------------------------

function scanDir(dir: string): string[] {
  const offenders: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.startsWith("test-") || !name.endsWith(".ts")) continue;
    if (name.endsWith("-live.ts")) continue; // live tests are out of the offline gate's scope
    if (EXEMPT_FILES.has(name)) continue;
    const file = path.join(dir, name);
    const text = readFileSync(file, "utf8");
    let calls = 0;
    let marker = false;
    for (const line of text.split("\n")) {
      if (ISOLATION_MARKERS.some((m) => line.includes(m))) marker = true;
      if (!LEADER_SEAMS.some((seam) => line.includes(seam))) continue;
      if (isNotACall(line)) continue;
      calls++;
    }
    if (calls > 0 && !marker) offenders.push(name);
  }
  return offenders;
}

const offenders = scanDir(SMOKE_TESTS);
assert(
  offenders.length === 0,
  offenders.length === 0
    ? "static scan: every test that calls a ledger writer seam carries an isolation marker"
    : `static scan: NO isolation marker in: ${offenders.join(", ")} — these drive a real ledger write into the per-clone .git when run in a worktree (#1069)`,
);

// The scan must actually bite: a deliberately unisolated fixture calling a
// seam must be named; an isolated one (env override) must not.
{
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), "ledger-iso-scan-"));
  try {
    writeFileSync(
      path.join(fixtureDir, "test-unisolated-fixture.ts"),
      'const r = await runLensReview({ diff: "d" } as never);\nvoid r;\n',
    );
    writeFileSync(
      path.join(fixtureDir, "test-isolated-fixture.ts"),
      'process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = "/tmp/x.json";\nconst r = await runLensReview({ diff: "d" } as never);\nvoid r;\n',
    );
    // A fixture isolated by the shared findings-memory factory rather than by
    // naming the env var itself: the marker lives in the fixture it imports.
    writeFileSync(
      path.join(fixtureDir, "test-fixture-isolated.ts"),
      'import { setupReviewFixture } from "./lib/review-findings-fixtures.ts";\nconst f = setupReviewFixture({ prefix: "p", files: {}, report: () => [] });\nconst r = await runLensReview({ diff: "d" } as never);\nvoid r; void f;\n',
    );
    const found = scanDir(fixtureDir);
    assert(
      found.includes("test-unisolated-fixture.ts"),
      "static scan (canary): a deliberately unisolated file IS named",
    );
    assert(
      !found.includes("test-isolated-fixture.ts"),
      "static scan (canary): an isolated file (env override) is NOT flagged",
    );
    assert(
      !found.includes("test-fixture-isolated.ts"),
      "static scan (canary): a file isolated via setupReviewFixture is NOT flagged",
    );
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}

// The gate must NOT set the env var globally (tests that use temp repos are
// already isolated; a global export would break the ledger tests' round
// counter). Tests that use the real repo's cwd set it themselves.
{
  const gate = path.join(SMOKE_TESTS, "lib", "verify-loop.sh");
  assert(existsSync(gate), "gate: verify-loop.sh exists");
  const gateText = readFileSync(gate, "utf8");
  assert(
    !gateText.includes("export PI_ENSEMBLE_REVIEW_LEDGER_FILE="),
    "gate: verify-loop.sh does NOT export PI_ENSEMBLE_REVIEW_LEDGER_FILE globally",
  );
}

// --- 4. #1449 — the helper cannot leak the override into this process -----
//
// The three checks above only validate a value that is already set. None of
// them can see the failure that mattered: a helper that SETS the override at
// import time and never restores it, so the importing process (a sibling test
// file in the same shell, or a parent Pi process that imported the suite) ends
// up pointing every writer at someone else's temp file. This case drives the
// real helper through the module graph the way a test file does, then asserts
// the env is back where it started.
{
  const before = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  const helpers = await import("./lib/review-ledger-test-helpers.ts");
  // A pre-existing value is NOT this helper's isolation target — driving it
  // twice with one already set is the shape the old idempotence-by-inheritance
  // silently accepted (and then rmSync'd a directory it never created).
  const releaseA = helpers.isolateLedger();
  const a = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  const releaseB = helpers.isolateLedger();
  const b = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  // Each call gets its OWN target: two files in one process must not end up
  // sharing one isolation, which is what "idempotent" meant before #1449.
  assert(
    !!a && !!b && a !== b,
    `#1449 each isolateLedger() call takes a fresh private target (first: ${a ?? "<unset>"}, second: ${b ?? "<unset>"})`,
  );
  assert(
    !!a && !/([/\\])\.git([/\\]|$)/.test(a!) && path.isAbsolute(a!),
    `#1449 the target it sets (${a}) is an absolute path outside any .git directory`,
  );
  assert(
    !!b && !/([/\\])\.git([/\\]|$)/.test(b!) && path.isAbsolute(b!),
    `#1449 the second target (${b}) is likewise absolute and outside any .git directory`,
  );
  assert(
    helpers.activeIsolations().length === 2,
    `#1449 both calls are tracked so both are undone (active: ${
      helpers.activeIsolations().length
    })`,
  );
  releaseB();
  releaseA();
  const after = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  assert(
    after === before,
    `#1449 no PI_ENSEMBLE_REVIEW_LEDGER_FILE survives into the importing process after the helper's isolations release (before: ${
      before === undefined ? "<unset>" : before
    }, after: ${after === undefined ? "<unset>" : after})`,
  );
  assert(
    helpers.activeIsolations().length === 0,
    "#1449 every isolation this process opened is released — nothing left to clean up on exit",
  );

  // ---- out-of-order release: the env must never name a removed directory ----
  //
  // Each `isolateLedger()` saves the env as it found it, so the INNER call's
  // `previous` is the OUTER call's file. Releasing in acquisition (FIFO) order —
  // outer first — and writing that saved value back points the env at the inner
  // isolation's file while the outer one believed it had cleared it; releasing
  // the inner first writes back a path whose directory the outer release then
  // deletes. Either way a writer running afterwards targets a directory that no
  // longer exists, which is the same class of bug the helper exists to prevent.
  //
  // The contract: after ANY release, whatever the env names is a file inside a
  // directory that still exists.
  {
    const rel1 = helpers.isolateLedger();
    const first = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    const rel2 = helpers.isolateLedger();
    const second = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    assert(
      first && second && first !== second,
      `#1449 [fifo] two nested isolations have distinct targets (${first}, ${second})`,
    );
    // Release the OUTER one first — the order the naive `previous` restore gets wrong.
    rel1();
    const afterOuter = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    assert(
      afterOuter === second,
      `#1449 [fifo] releasing the OUTER isolation while the inner is live re-points the env at the inner's file, not at a stale saved value (${afterOuter})`,
    );
    assert(
      !!afterOuter && existsSync(afterOuter.replace(/[^/]+$/, "")),
      `#1449 [fifo] the path the env names after that release still exists — a writer at this moment is not writing into a deleted directory (${afterOuter})`,
    );
    rel2();
    const afterInner = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    assert(
      afterInner === before,
      `#1449 [fifo] releasing the last isolation restores the value the first one replaced (${afterInner})`,
    );
    assert(
      helpers.activeIsolations().length === 0,
      "#1449 [fifo] nothing left tracked after an out-of-order release pair",
    );
    // Double release is idempotent — the exit handler and an explicit caller both
    // reach for the same release.
    rel2();
    assert(
      process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE === before,
      "#1449 [fifo] a second release of an already-released isolation is inert",
    );
  }
  // A helper that never adopts an inherited value must not DELETE one it was
  // handed either: an operator's/gate's override has to survive a sibling
  // file's isolate/release cycle untouched.
  assert(
    process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE === before,
    "#1449 a pre-set value is restored verbatim, not dropped",
  );
  // #1449 — the explicit "honour what is already set" path is a different
  // function, and it must not own (or delete) a directory it did not create.
  const adoptProbe = "/tmp/pi-1449-adopt/review-ledger.json";
  const priorAdopt = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = adoptProbe;
  try {
    assert(
      helpers.adoptLedgerOverride() === adoptProbe,
      "#1449 adoptLedgerOverride reports the already-set value instead of replacing it",
    );
    assert(
      helpers.activeIsolations().length === 0,
      "#1449 adopting an inherited value registers no cleanup — the helper cannot rm a dir it did not make",
    );
  } finally {
    // biome-ignore lint/performance/noDelete: delete is the correct "reset to unset"
    if (priorAdopt === undefined) delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = priorAdopt;
  }
}

// ── 5. #1764 — the findings store never resolves INSIDE a clone or a worktree ──
//
// The whole point of `review-state-path.ts` is that the findings file left the git
// common dir. A regression that put it back would re-open the guard problem the
// relocation closed, so the property is asserted here rather than trusted: for a
// real clone and one of its linked worktrees, the resolved findings DIR must sit
// under the agent dir, not under the clone, its git dir, or any worktree. The one
// documented exception is the fallback (a store that could not be relocated stays
// beside the ledger) — and that shape must be the one the resolver WARNS about, so
// a test asserting it also proves the operator sees it.
{
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
  const { gitTestEnv } = await import("./lib/git-test-env.ts");
  const statePath = await import("../src/review-state-path.ts");
  const root = mkdtempSync(path.join(os.tmpdir(), "findings-outside-"));
  const repo = path.join(root, "repo");
  const wt = path.join(root, "wt");
  mkdirSync(repo);
  const env = gitTestEnv();
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env }).trim();
  const savedAgent = process.env.PI_AGENT_DIR;
  const savedOverride = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  process.env.PI_AGENT_DIR = path.join(root, "agent");
  delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  try {
    statePath.resetFindingsStateCache();
    git("init", "-q", "-b", "main");
    git("config", "user.email", "dev@example.com");
    git("config", "user.name", "dev");
    writeFileSync(path.join(repo, "a.ts"), "export const a = 1;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    git("worktree", "add", "-q", "-b", "feat/wt", wt, "HEAD");
    const commonDir = path.resolve(repo, git("rev-parse", "--git-common-dir"));

    for (const [label, cwd] of [
      ["the main checkout", repo],
      ["a linked worktree", wt],
    ] as Array<[string, string]>) {
      statePath.resetFindingsStateCache();
      const loc = await statePath.findingsStateDir(execp, cwd);
      assert(loc !== undefined, `#1764 ${label}: a findings location resolves`);
      assert(
        loc!.fellBack === false,
        `#1764 ${label}: the store is relocated, so the invariant is not being proven by the fallback`,
      );
      // The property is about the CLONE and its worktrees, not the temp dir they
      // were created in: a gate that points TMPDIR at one directory legitimately
      // puts the agent dir beside the repo, and that is not the regression.
      const insideAny = (candidate: string): boolean =>
        candidate === repo ||
        candidate.startsWith(`${repo}${path.sep}`) ||
        candidate === wt ||
        candidate.startsWith(`${wt}${path.sep}`) ||
        candidate === commonDir ||
        candidate.startsWith(`${commonDir}${path.sep}`);
      assert(
        !insideAny(loc!.dir),
        `#1764 ${label}: the findings dir is not inside the clone, its git dir or a worktree`,
      );
      assert(
        !loc!.dir.includes(`${path.sep}.git${path.sep}`) && !loc!.dir.endsWith(`${path.sep}.git`),
        `#1764 ${label}: and no path segment of it is a git directory`,
      );
      assert(
        loc!.dir.startsWith(path.join(process.env.PI_AGENT_DIR!, statePath.STATE_LEAF)),
        `#1764 ${label}: it lives under <agentDir>/<state leaf> instead`,
      );
    }

    // The documented exception: when the state dir cannot be created the store
    // stays beside the ledger - inside the clone - and that is only allowed as the
    // WARNED fallback. A fresh agent dir is used so the process cache from the two
    // relocated resolves above cannot answer for it; an unwritable state root is
    // the fault, and the resolver must both fall back and say so on stderr rather
    // than relocate silently (or throw).
    statePath.resetFindingsStateCache();
    // The chmod probe: make the state root read-only and ask the resolver what
    // it does. The WHOLE created agent dir is restored in the finally below —
    // restoring only the leaf leaves the parent at 0500 and makes `rmSync` of
    // the temp root fail for the next test in the pool.
    const probeAgentDir = mkdtempSync(path.join(root, "agent-fallback-"));
    const probeStateRoot = path.join(probeAgentDir, statePath.STATE_LEAF);
    mkdirSync(probeStateRoot, { mode: 0o700 });
    // The probe's agent dir is installed AFTER the fault is in place: the
    // two relocated resolves above left a process cache keyed on this clone,
    // and installing early would let a neighbour read a half-built fixture.
    process.env.PI_AGENT_DIR = probeAgentDir;
    statePath.resetFindingsStateCache();
    if (process.getuid?.() === 0) {
      // A 0500 directory does not stop root: open(2)/mkdir(2) succeed for the
      // superuser whatever the mode bits say, so the probe would report a
      // fallback that never happened (or none, depending on the filesystem).
      // The property is not being tested then, and saying so beats a green
      // line that proves nothing.
      console.log(
        "SKIP #1764 chmod probe: running as root, a 0500 state root is writable to root so the fallback cannot be provoked",
      );
      chmodSync(probeStateRoot, 0o700);
    } else {
      chmodSync(probeStateRoot, 0o500);
      const warned: string[] = [];
      const realWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: string | Uint8Array): boolean => {
        warned.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      }) as typeof process.stderr.write;
      let fellBack;
      try {
        fellBack = await statePath.findingsStateDir(execp, repo);
      } finally {
        // The restore and the env/spy restore come BEFORE any assertion, so a
        // failing assertion cannot leave the tree 0500 or stderr intercepted for
        // the rest of the process.
        process.stderr.write = realWrite;
        chmodSync(probeStateRoot, 0o700);
        chmodSync(probeAgentDir, 0o700);
      }
      assert(
        fellBack?.fellBack === true,
        "#1764: an uncreatable state dir falls back beside the ledger",
      );
      assert(
        fellBack!.dir === commonDir,
        "#1764: the ONE documented in-clone location is the fallback, beside the ledger",
      );
      assert(
        warned.some((w) => w.includes("WARN") && w.includes("review-state")),
        "#1764: the fallback traces, so an in-clone store is never silent",
      );
    }
    git("worktree", "prune");
  } finally {
    if (savedAgent === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = savedAgent;
    if (savedOverride === undefined) delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = savedOverride;
    statePath.resetFindingsStateCache();
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
