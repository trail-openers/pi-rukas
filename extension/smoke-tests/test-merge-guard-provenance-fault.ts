#!/usr/bin/env bun
/**
 * #1449 fix round — the write-side provenance read must not weaken the #912 guard.
 *
 * The guard's refusal gains its "a review ran, at another file" wording from ONE
 * extra read of a file the environment names: `misdirectedWriteOf` re-opens the
 * ledger the override points at and looks for the `writtenTo` stamp a writer left
 * there. That read sits on the hot path EVERY merge-guard evaluation takes, so it
 * carries the opposite failure contract from the verdict read next to it. The
 * verdict read decides the merge and fails closed. The provenance read may be
 * silent; it may never crash the gate, and it may never turn a refusal into an
 * allow.
 *
 * This file is where that contract is pinned. The split from
 * `test-ledger-override-provenance.ts` is the AGENTS.md §12 size cap, and the
 * seam is real rather than mechanical: that file asks "does a misdirected write
 * get REPORTED", these arms ask "can the reporting read ever damage the gate".
 *
 * Three layers, each watched for throws SEPARATELY — because all three swallow,
 * and a test that only watches the outermost stays green when either inner layer
 * is deleted:
 *
 *   (a) `readLedgerFileSafe` — the permissive reader (inner layer);
 *   (b) `misdirectedWriteOf` — the helper's own catch (outer layer);
 *   (c) `registerMergeGuard` end to end — a hostile provenance file still refuses.
 *
 * Plus the adversarial half of #1449: the note a misdirected adversarial row
 * produces has a PRODUCTION caller (the loop's own `makeLedgerWrite`), which is
 * what `test-seams-wired.ts` cannot tell a wired helper from a returning-the-
 * wrong-thing one. The sibling question — can the WRITER's return shape damage
 * the LOOP — is `test-adversarial-ledger-writer-shapes.ts`.
 *
 * Isolation: every arm runs against a fresh temp clone and pins
 * `PI_ENSEMBLE_REVIEW_LEDGER_FILE` to its own path, restored in `finally`. The
 * main clone's `.git/review-ledger.json` is never a target of any write here.
 */
import { spawnSync } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeLedgerWrite } from "../src/adversarial-ledger-capture.ts";
import { misdirectedLedgerNote } from "../src/adversarial-ledger-note.ts";
import { misdirectedWriteOf } from "../src/merge-guard-provenance.ts";
import { registerMergeGuard } from "../src/merge-guard.ts";
import { readLedgerFileSafe } from "../src/review-ledger-read.ts";
import { MISDIRECTED_LEDGER_NOTE, readLedgerFile } from "../src/review-ledger.ts";
import type { LedgerEntry } from "../src/review-ledger.ts";
import { BRANCH, forgeExec, setupRepo } from "./lib/adversarial-ledger-harness.ts";

let passed = 0;
let failed = 0;
function assert(cond: unknown, msg: string) {
  try {
    if (!cond) throw new Error("falsy");
    console.log(`\u2713 ${msg}`);
    passed++;
  } catch {
    console.error(`\u2717 ${msg}`);
    failed++;
  }
}

/** A passing adversarial row, for the arms that build a ledger by hand. */
const ADV_ROW: LedgerEntry = {
  branch: BRANCH,
  kind: "adversarial",
  patchId: "p1",
  passed: true,
  at: 1,
};

/** Run a real git command the way the writers' executor seam calls it. */
const gitAt = (dir: string) => async (cmd0: string, o?: { argv?: string[]; cwd?: string }) => ({
  stdout: o?.argv
    ? execFileSync(cmd0, o.argv, {
        cwd: o?.cwd ?? dir,
        encoding: "utf8",
        stdio: "pipe",
      })
    : execFileSync("/bin/sh", ["-c", cmd0], {
        cwd: o?.cwd ?? dir,
        encoding: "utf8",
        stdio: "pipe",
      }),
});

/**
 * Drive the REAL #912 guard with ONLY `gh` stubbed, and with the ledger the
 * override names pointed at `ledgerAt` — a path the caller has filled with
 * something hostile (malformed JSON, a directory, nothing at all).
 *
 * The guard resolves its ledger path through `ledgerPathFor`, which honours the
 * override BEFORE any git call — so pointing the env var at `ledgerAt` is exactly
 * what makes the guard read the hostile file, and exactly what makes
 * `misdirectedWriteOf` open it too. Nothing else is faked: the fetch, the head
 * check and the patch-id are real git against the fixture clone, so a refusal
 * here cannot be an artefact of a stub.
 */
async function guardDecision(
  repo: string,
  ledgerAt: string,
): Promise<{ block: boolean; reason: string }> {
  const saved = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = ledgerAt;
  let handler: ((e: unknown, c: unknown) => Promise<unknown>) | undefined;
  try {
    registerMergeGuard(
      // biome-ignore lint/suspicious/noAssignInExpressions: the harness's own capture idiom
      { on: (n: string, fn: typeof handler) => n === "tool_call" && (handler = fn) } as never,
      { execFn: forgeExec(repo, { comments: [] }) },
    );
    const prev = process.cwd();
    process.chdir(repo);
    try {
      const r = (await handler?.({ toolName: "bash", input: { command: "gh pr merge 12" } }, {})) as
        | { block?: boolean; reason?: string }
        | undefined;
      return { block: r?.block === true, reason: r?.reason ?? "" };
    } finally {
      process.chdir(prev);
    }
  } finally {
    // biome-ignore lint/performance/noDelete: unsetting is the state under test
    if (saved === undefined) delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = saved;
  }
}

/**
 * Does the production loop path actually append the misdirection note?
 *
 * Drives the real `makeLedgerWrite` — the loop's own writer — against a fixture
 * clone whose override points at a file that is NOT its own ledger, then waits
 * for the fire-and-forget write to settle. The note is DELIVERED after the
 * synchronous return (that is the fire-and-forget contract the loop's seven exits
 * rely on), so this polls the held result rather than reading it inline.
 *
 * The target sits inside the clone's parent dir and the clone is FRESH per call:
 * rows dedupe per (branch, kind), so a second write on the same clone resolves to
 * the same path and would honestly report "no misdirection".
 */
async function loopAppendsTheMisdirectedNote(): Promise<boolean> {
  const noteRepo = setupRepo();
  const outside = path.join(path.dirname(noteRepo.dir), "loop-note-redirect.json");
  const saved = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = outside;
  try {
    let held = { ok: true, loopOutcome: "approved", text: "REVIEW DONE" } as {
      ok: boolean;
      loopOutcome: string;
      text: string;
    };
    const write = makeLedgerWrite({
      state: { captured: { binding: {}, headRef: undefined } },
      workCwd: noteRepo.dir,
      branch: BRANCH,
      resolvedBranch: BRANCH,
      execFn: gitAt(noteRepo.dir),
      decorate: (raw) => raw,
      // The loop's own note threader is passed through untouched, so what this
      // sees is the note `makeLedgerWrite` added and nothing else.
      note: (raw) => {
        held = raw;
        return raw;
      },
    });
    const sync = write(held as never);
    // The synchronous return is byte-identical to an un-noted result: the note
    // arrives when the write settles, never before.
    if (sync.text !== "REVIEW DONE") return false;
    for (let i = 0; i < 400; i++) {
      if (held.text !== "REVIEW DONE") return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return false;
  } finally {
    // biome-ignore lint/performance/noDelete: restoring the pre-arm env
    if (saved === undefined) delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = saved;
    rmSync(outside, { force: true });
    rmSync(path.dirname(noteRepo.dir), { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Arms
// ---------------------------------------------------------------------------

const faultDir = mkdtempSync(path.join(os.tmpdir(), "pi-1449-fault-"));
const corrupt = path.join(faultDir, "corrupt.json");
const missing = path.join(faultDir, "no-such-file.json");
const stamped = path.join(faultDir, "stamped.json");
// Malformed JSON that REACHES the parse layer (a truncated file — the shape an
// interrupted ledger rename leaves behind) rather than short-circuiting on a
// non-array `entries`, which `readLedgerFile` returns as an empty ledger.
writeFileSync(corrupt, '{"entries": [ {"branch": "feature/x", ', "utf8");
writeFileSync(
  stamped,
  JSON.stringify({
    entries: [{ ...ADV_ROW, branch: BRANCH, writtenTo: "/tmp/elsewhere/review-ledger.json" }],
  }),
  "utf8",
);
// A path `existsSync` PASSES and the read then throws — the arm the `existsSync`
// guard in front of the read does not cover, and the one that makes the outer
// `catch` load-bearing rather than decorative. A mode-000 file is the portable
// version: `existsSync` is a stat and succeeds, `readFileSync` throws EACCES.
// (A directory is not portable: macOS reports EISDIR, elsewhere the read can
// succeed with empty bytes — which parses as nothing and would pass for the
// wrong reason. `readableProbeFaults` below pins that this one really faults.)
const denied = path.join(faultDir, "denied.json");
writeFileSync(denied, JSON.stringify({ entries: [{ ...ADV_ROW, writtenTo: "/nope/x.json" }] }));
execFileSync("/bin/sh", ["-c", `chmod 000 ${JSON.stringify(denied)}`], { stdio: "ignore" });
const unreadableProbe = denied;

// The clone the guard-decision arms run in, at module scope so the `finally`
// below can always clean it up — a fixture that leaks a temp clone when an arm
// throws is the same scratch-hygiene debt #1449 is about.
const faultRepo = setupRepo();

/**
 * Does a fault in the provenance read stay INSIDE the guard?
 *
 * The failure this pins is the one the finding was about: a throw escaping the
 * diagnostic and reaching the `tool_call` handler that owns the merge verdict.
 * It is asserted where it would actually matter — the real hook, in a child
 * process — rather than of the helper in isolation. The helper's own `catch` and
 * `readLedgerFileSafe`'s BOTH swallow, and the INNER one catches first, so
 * deleting either changes no return value and no helper-level output assert can
 * see it. A fault that escaped BOTH would surface as the hook throwing, which is
 * what this drives for. "BLOCKED" is the only acceptable answer: the guard
 * DECIDED. "HOOK_THREW" is the fault escaping — a command the guard was meant to
 * refuse reaching the agent, the fail-OPEN direction #1449 must never open.
 */
function faultStaysInsideTheGuard(): { blocked: boolean; hookThrew: boolean; detail: string } {
  const harness = JSON.stringify(
    path.resolve(import.meta.dirname, "lib", "adversarial-ledger-harness.ts"),
  );
  const guardSrc = JSON.stringify(path.resolve(import.meta.dirname, "..", "src", "merge-guard.ts"));
  const probe = JSON.stringify(unreadableProbe);
  const child = `
const { registerMergeGuard } = await import(${guardSrc});
const { forgeExec, setupRepo } = await import(${harness});
const repo = setupRepo();
process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = ${probe};
let handler;
registerMergeGuard({ on: (n, fn) => { if (n === "tool_call") handler = fn; } },
  { execFn: forgeExec(repo.dir, { comments: [] }) });
const prev = process.cwd();
process.chdir(repo.dir);
try {
  const r = await handler({ toolName: "bash", input: { command: "gh pr merge 12" } }, {});
  process.stdout.write(r && r.block ? "BLOCKED" : "ALLOWED");
} catch (e) {
  process.stdout.write("HOOK_THREW " + (e && e.message));
} finally {
  process.chdir(prev);
  const fs = require("node:fs");
  try { fs.chmodSync(${probe}, 0o644); } catch {}
  fs.rmSync(require("node:path").dirname(repo.dir), { recursive: true, force: true });
}
`;
  const r = spawnSync(process.execPath, ["-e", child], { encoding: "utf8" });
  const out = r.stdout ?? "";
  return {
    blocked: out.includes("BLOCKED"),
    hookThrew: out.includes("HOOK_THREW"),
    detail: (out || (r.stderr ?? "")).slice(0, 180),
  };
}

try {
  // The stamp-comparison arms moved to test-ledger-provenance-compare.ts for the
  // 500-line gate; this suite keeps the fault tolerance of the same read.

  // ---- (a) the helper: no throw, no misdirection claimed -----------------
  assert(
    misdirectedWriteOf(corrupt, BRANCH) === undefined,
    "#1449 a corrupt provenance file yields 'no misdirection detected', not a throw",
  );
  const unreadableSeen = misdirectedWriteOf(unreadableProbe, BRANCH);
  assert(
    unreadableSeen === undefined,
    "#1449 an existsSync-passing but unreadable provenance file yields 'no misdirection detected'",
  );
  // The probe that makes that arm real: had the file been readable, its row's
  // stamp would come back and the assert above would pass for the wrong reason.
  let probeFaults = false;
  try {
    readLedgerFile(unreadableProbe);
  } catch {
    probeFaults = true;
  }
  assert(
    probeFaults,
    "#1449 the unreadable probe really faults on read (else the arm above proves nothing)",
  );
  assert(
    misdirectedWriteOf(missing, BRANCH) === undefined,
    "#1449 a missing provenance file yields 'no misdirection detected'",
  );
  // A real stamp is still read out of a well-formed file — so the three
  // undefined results above are the FAULT arms answering, not a helper that
  // simply never returns anything (the mutation the asserts above cannot detect
  // on their own).
  assert(
    misdirectedWriteOf(stamped, BRANCH) === "/tmp/elsewhere/review-ledger.json",
    "#1449 the fault arms above are faults answering, not a helper that never reports a stamp",
  );

  // The two swallow layers, watched separately. All three layers swallow, so a
  // test that watches only the return value stays green when any ONE layer is
  // deleted — which is exactly the mutation these two asserts exist to catch.
  let innerThrew = false;
  try {
    readLedgerFileSafe(corrupt);
    readLedgerFileSafe(missing);
    readLedgerFileSafe(unreadableProbe);
  } catch {
    innerThrew = true;
  }
  assert(
    !innerThrew,
    "#1449 readLedgerFileSafe never throws on corrupt/missing input (inner layer)",
  );

  let outerThrew = false;
  try {
    misdirectedWriteOf(corrupt, BRANCH);
    misdirectedWriteOf(unreadableProbe, BRANCH);
  } catch {
    outerThrew = true;
  }
  assert(!outerThrew, "#1449 misdirectedWriteOf never throws out to the guard (outer layer)");
  // …and the fault stays contained WHERE IT MATTERS: driven through the real
  // hook, an unreadable ledger yields a DECISION, never an escaped throw. This is
  // the arm that sees a broken swallow layer — the helper's two catches are
  // mutually redundant on return value (the inner one catches first), so no
  // helper-level output assert can tell them apart and a deleted `catch` would
  // otherwise survive green.
  const contained = faultStaysInsideTheGuard();
  assert(
    contained.blocked && !contained.hookThrew,
    `#1449 the real hook DECIDES (refuses) under an unreadable ledger — no fault escapes to the tool_call handler (${contained.detail})`,
  );

  // …and the throwing sibling still DOES throw, so the permissive reader is a
  // deliberate second contract rather than a softening of the first. If
  // `readLedgerFile` itself had been made permissive instead, `appendLedgerEntry`
  // would silently start its under-lock read from an empty ledger — the
  // concurrent-writer data-loss direction #1449 must not open.
  let siblingThrew = false;
  try {
    readLedgerFile(corrupt);
  } catch {
    siblingThrew = true;
  }
  assert(
    siblingThrew,
    "#1449 readLedgerFile still throws — the permissive read is a new layer, not a softening of the old one",
  );

  // ---- (c) the guard end to end: a hostile provenance file still refuses ---
  {
    const refused = await guardDecision(faultRepo.dir, corrupt);
    assert(
      refused.block === true,
      "#1449 a corrupt ledger still refuses the merge — the guard stays fail closed",
    );
    // The refusal is the FIRST fail-closed one the guard reaches — the
    // adversarial half, which the corrupt file has just erased. Asserting the
    // lens-side "no entry to evaluate" wording here would need an adversarial row
    // matching the guard's OWN recomputed patch-id, which a hand-written fixture
    // cannot supply (a guessed patchId is refused as stale — a different
    // fail-closed arm). What is load-bearing for #1449 is that it refuses, and
    // that no redirect was invented; both are asserted, here and in the EISDIR arm.
    assert(
      /adversarial review on file|patchId|refuses by default|round-cap/.test(refused.reason ?? ""),
      "#1449 the refusal under a corrupt provenance file is a fail-closed ledger refusal",
    );
    assert(
      !/DID run/i.test(refused.reason ?? ""),
      "#1449 a fault in the provenance read invents no claim that a review ran",
    );

    const refusedDir = await guardDecision(faultRepo.dir, unreadableProbe);
    assert(
      refusedDir.block === true,
      "#1449 an unreadable ledger still refuses the merge — the guard stays fail closed",
    );
    assert(
      !/DID run/i.test(refusedDir.reason ?? ""),
      "#1449 the unreadable arm refuses with no invented redirect claim either",
    );

    const refusedMissing = await guardDecision(faultRepo.dir, missing);
    assert(
      refusedMissing.block === true,
      "#1449 a missing ledger still refuses the merge — the guard stays fail closed",
    );

    // A redirect that really happened must not have its refusal LIFTED by a
    // fault: an adversarial row is on disk, the lens row is not, and a provenance
    // file the reader cannot parse changes nothing about the verdict.
    const advOnly = path.join(faultDir, "adv-only.json");
    writeFileSync(advOnly, JSON.stringify({ entries: [ADV_ROW] }), "utf8");
    const stillRefused = await guardDecision(faultRepo.dir, advOnly);
    assert(
      stillRefused.block === true,
      "#1449 with an adversarial row present and no lens row the merge still refuses",
    );
    assert(
      !/DID run/i.test(stillRefused.reason ?? ""),
      "#1449 the ordinary refusal makes no redirect claim without a stamp",
    );

    // The two hostile-STAMP arms (a `writtenTo` naming a dangling symlink, and an
    // `expectedClonePath` whose directory is gone) moved to
    // `test-merge-guard-hostile-stamp.ts` for the 500-line gate. Both ask the
    // same question of the guard — can a hostile value on the RIGHT-hand side of
    // the provenance comparison lift the block? — and that file drives the real
    // hook, so the split kept the assertion that matters and not just the helper.
  }

  // ---- (d) the adversarial note has a production caller ------------------
  {
    const note = misdirectedLedgerNote({ recorded: true, landedAtPath: "/tmp/x.json" });
    assert(
      typeof note === "string" && note.includes("/tmp/x.json"),
      "#1449 a redirected adversarial outcome renders a note naming the file",
    );
    assert(
      typeof note === "string" && note.startsWith(MISDIRECTED_LEDGER_NOTE),
      "#1449 the adversarial note is the shared constant, not per-site prose",
    );
    assert(
      misdirectedLedgerNote({ recorded: true }) === undefined,
      "#1449 an ordinary recorded write yields no note (the 99% path stays byte-identical)",
    );
    assert(
      misdirectedLedgerNote({
        recorded: false,
        reason: "no branch to key the ledger entry on",
      }) === undefined,
      "#1449 a by-design skip is never reported as a misdirection",
    );
    assert(
      await loopAppendsTheMisdirectedNote(),
      "#1449 the loop's ledger write routes its outcome through the note (production path, not a stub)",
    );
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
} finally {
  rmSync(faultDir, { recursive: true, force: true });
  rmSync(path.dirname(faultRepo.dir), { recursive: true, force: true });
}
