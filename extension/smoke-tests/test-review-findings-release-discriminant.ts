#!/usr/bin/env bun
/**
 * #1934 — the two witnesses for `releaseFixture`'s sentinel arm that judge the
 * arm's CONTRACT rather than its env effect: the record's discriminant, and the
 * process-global cache the arm must still clear.
 *
 * Split from `test-review-findings-unset-arms.ts` by the AGENTS.md §12 500-line
 * gate. The seam is the object of judgement, not a line count: that file judges
 * `assertUnset`'s four env arms (two per pin, each of which must be able to go
 * red); the two cases here judge (a) that the record `releaseFixture` branches
 * on is the field it claims to branch on, and (b) that the arm clears the
 * PROCESS-GLOBAL store caches, which is state no fixture owns. They share with
 * the arms file only the fixture and the `delete`-vs-assign discipline, and they
 * need the store's resolver and the filesystem, which none of the arm cases
 * touch — so moving them either way would drag an import and a precondition
 * across for no shared assertion.
 *
 * A SECOND SPLIT ALONG THE SAME SEAM (#1934 round 2), for the same reason rather
 * than to satisfy the line count: the two AC4/`SetupOutcome` cases that used to
 * live at the foot of this file drive real STORE ROUNDS (`seed`, `reReport`,
 * `silentRound`, `rowsOf`) and assert on the helpers' success arm. They shared no
 * local, no helper and no precondition with the sentinel-arm cases above — this
 * file consults the resolver and the filesystem, they consult the store and the
 * ledger — and between them the two shapes pushed the file past 500 lines. They
 * are now `test-review-findings-lapsed-arm.ts`, moved unchanged. Every case that
 * was here is still run; none was deleted, narrowed or merged to make the number.
 *
 * WHY THE CHANNEL IS DUPLICATED RATHER THAN IMPORTED: a test file imported by
 * another test file runs its top level — including its `process.exit(exit)` —
 * inside the importer's run, so a test file cannot export its assertion channel.
 * Each file therefore declares its own `assert` and exits with its own code.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { execp } from "../src/exec.ts";
import {
  FINDINGS_FILE,
  findingsStateDir,
  resetFindingsStateCache,
} from "../src/review-state-path.ts";
import {
  assertUnset,
  CITED,
  makeFixture,
  neverInstalledEnv,
  okFixture,
  releaseFixture,
  releaseUnpinProblems,
  removeFixture,
} from "./lib/confirmation-store-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ---------------------------------------------------------------------------
// H1 — the sentinel arm must still clear the PROCESS-GLOBAL state cache
// ---------------------------------------------------------------------------

// Why this case is separate from `never_built_case` rather than another
// assertion inside it: that case judges what the release does NOT do (leave the
// host unpinned) by reading `process.env`; this one judges what it MUST still do
// (clear the caches) by reading THE FILESYSTEM, through the store's own resolver.
// They share the sentinel record and nothing else, and their preconditions are
// opposite — the host pins are set there and blank here, because the cache is
// only ever consulted on the non-override arm.
cache_case: {
  // `resetFindingsStateCache` empties TWO process-global structures keyed on a
  // clone's git common dir: `resolved` (its store location) and `attempted`
  // (the clones whose one-time migration this process has done),
  // review-state-path.ts:417-419. Neither is fixture state, so the sentinel
  // arm's "nothing this fixture moved" reasoning does not license skipping the
  // reset — the entry the PREVIOUS fixture's healthy `makeFixture` left behind
  // is the next case's answer.
  //
  // TWO CANDIDATE OBSERVABLES WERE TRIED AND ONLY ONE MEASURES ANYTHING, which
  // is why the dead one is written down rather than rediscovered:
  //   - reading `findingsStateDir`'s `dir` before and after the release is
  //     REDUCED: measured identical with the reset present and absent, because
  //     `tokenFor` re-mints the same answer once `resolved` is gone. The
  //     location cache is simply not observable from the resolve's return.
  //   - `attempted` is observable only through `migrateOnce`, which short-circuits
  //     on it (review-state-path.ts:248) BEFORE it inspects the marker, and which
  //     writes the marker before it moves any bytes (253-258). So a clone the
  //     process has forgotten and a clone it remembers behave DIFFERENTLY on
  //     disk, and nothing but the reset makes them differ.
  //
  // Arms, each with its own precondition red so a green at the end cannot come
  // from the case having judged nothing:
  //   P1 the env carries NO ledger override, so the resolve takes the
  //      non-override arm — the override arm returns before `migrateOnce` and
  //      would leave `attempted` untouched whatever this case did.
  //   P2 the first resolve migrates the legacy store: the bytes leave the git
  //      dir and the clone enters `attempted`.
  //   P3 BOTH are put back to the never-migrated state — bytes present, marker
  //      removed — so a second pass has work to do and the only thing that can
  //      stop it is `attempted`.
  //   P4 the sentinel release runs.
  //   P5 a second resolve. Reset present: the clone migrates again and the bytes
  //      are gone. Reset absent: `attempted` still holds the clone, the pass is a
  //      silent no-op, and the bytes survive — the released fixture's bookkeeping
  //      is what the next case reads.
  const legacyRows = JSON.stringify({
    rows: [
      {
        id: "deadbeef",
        branch: "feature/work",
        path: "src/a.ts",
        anchor: "a".repeat(64),
        titleClass: "b".repeat(64),
        title: "the row the migration must bring along",
        severity: "CRITICAL",
        lens: "PERFORMANCE",
        line: CITED,
        snippetHash: "c".repeat(64),
        lineHash: "d".repeat(64),
        status: "open",
        firstSeen: 1,
        lastSeen: 1,
      },
    ],
  });
  const savedLedger = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  const savedAgent = process.env.PI_AGENT_DIR;
  const world = mkdtempSync(path.join(os.tmpdir(), "cache-leak-"));
  const agent = path.join(world, "agent");
  delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  // P1 — no override in effect for ANY resolve this case performs. The pin must
  // go AFTER `makeFixture`, not before: `makeFixture`'s healthy path installs
  // `<root>/review-ledger.json` and records the previous value, so a case that
  // cleared the variable first would have the fixture put it back and every
  // resolve below would take the override arm — measured, the first resolve
  // answered at `/tmp/conf-store-XXXX` (the override's own directory) where the
  // non-override arm answers under `$PI_AGENT_DIR/review-state/<key>/<token>`, and
  // the whole case then judged the wrong arm while still reading as a witness.
  // `releaseFixture` below is handed a sentinel record precisely so it does NOT
  // restore that pin and cannot undo this delete.
  const f = makeFixture();
  delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  // The agent root is THIS temp dir rather than the host's `~/.pi`: the
  // migration must not touch a developer's real state to be witnessed.
  process.env.PI_AGENT_DIR = agent;
  resetFindingsStateCache();
  try {
    if (!okFixture(f, "cache", (m) => assert(false, m))) break cache_case;
    const commonDir = path.join(f.dir, ".git");
    const legacy = path.join(commonDir, FINDINGS_FILE);
    assert(
      !("PI_ENSEMBLE_REVIEW_LEDGER_FILE" in process.env),
      `cache: no ledger override is in effect, so the resolve takes the NON-override arm (override=${String(process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE)})`,
    );
    writeFileSync(legacy, legacyRows, "utf8");
    const first = await findingsStateDir(execp, f.dir);
    assert(
      first !== undefined && existsSync(legacy) === false,
      `cache: the first resolve migrated the pre-#1764 store out of the clone's git dir (legacy=${existsSync(legacy)}, dir=${String(first?.dir)})`,
    );
    assert(
      first !== undefined && existsSync(first.file),
      `cache: …and wrote the migrated bytes into the token store (${String(first?.file)})`,
    );
    const marker = first === undefined ? undefined : path.join(first.dir, "MIGRATED");
    assert(
      marker !== undefined && existsSync(marker),
      `cache: the first pass left its once-per-clone marker (${String(marker)})`,
    );
    // P3: back to a never-migrated clone. Deleting only one of the two would
    // leave the marker's own short-circuit as the answer and the case would read
    // green on a release that cleared nothing.
    if (marker !== undefined) rmSync(marker, { force: true });
    writeFileSync(legacy, legacyRows, "utf8");
    assert(
      existsSync(legacy) && marker !== undefined && !existsSync(marker),
      `cache: the clone is back to the never-migrated state — bytes present, no marker (legacy=${existsSync(legacy)}, marker=${String(marker !== undefined && existsSync(marker))})`,
    );
    // P4: the sentinel release, on the record `unusable()` produces.
    releaseFixture({ priorEnv: neverInstalledEnv() });
    // P5.
    const second = await findingsStateDir(execp, f.dir);
    assert(
      existsSync(legacy) === false,
      `cache: the sentinel release cleared the PROCESS-GLOBAL caches, so a second resolve of the SAME clone migrates it again rather than answering from the released fixture's bookkeeping (legacyStillThere=${existsSync(legacy)}, marker=${String(marker !== undefined && existsSync(marker))}, secondDir=${String(second?.dir)})`,
    );
  } finally {
    if (savedLedger === undefined) delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = savedLedger;
    if (savedAgent === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = savedAgent;
    resetFindingsStateCache();
    removeFixture(f);
    rmSync(world, { recursive: true, force: true });
  }
  break cache_case;
}

// ---------------------------------------------------------------------------
// H2 — the discriminant is the guard: a half-installed record must not compile,
// and the sentinel arm must be selected by `installed`, not by member equality
// ---------------------------------------------------------------------------

// WHY THIS CASE EXISTS BESIDE `never_built_case`. That case reaches the sentinel
// arm through a fixture whose build faulted, so the arm is selected for it and
// the case observes the consequence. This case drives the arm DIRECTLY, on the
// record the shipped fault arm builds, and asserts on the FIELD that selects it
// — because the reviewer measured that the release guard's `||` weakened to `&&`
// left every file in the fixture family green, this one included (16 greens,
// `reds=0`): a predicate that reads `ledgerFile === null` judges a VALUE, and a
// mutant can keep the value while moving the guard. `installed` is what
// `releaseFixture` and `assertUnset` branch on, so it is what a witness has to
// read. The compile-error half of the claim is checked by `tsc` — the two
// records the old interface accepted (`{ledgerFile: null, agentDir: undefined}`
// and both-null-without-the-tag) are errors under the union, and type-check
// clean under the old shape; both were measured, and the transcripts are in the
// PR.
discriminant_case: {
  const sentinel = neverInstalledEnv();
  // WITNESS 1 — the field the shipped code branches on, read directly. Under the
  // old two-member type this assertion was NOT WRITABLE (no such field existed),
  // which is exactly why the `&&` mutant survived: there was nothing to test.
  assert(
    sentinel.installed === false &&
      sentinel.ledgerFile === null &&
      sentinel.agentDir === null,
    `discriminant: the never-installed record carries the tag the release branches on, not merely two nulls (${JSON.stringify(sentinel)})`,
  );
  // WITNESS 2 — the fault arm of `makeFixture` builds the SAME record, so the
  // arm this case drives is the one the shipped fault path produces rather than
  // a stand-in shaped like it. Forced the same way `never_built_case` does it:
  // `git` off PATH, so the recipe dies before the pins.
  const savedPath = process.env.PATH;
  process.env.PATH = "/nonexistent-bin-dir-for-1934-discriminant";
  const faulted = makeFixture();
  process.env.PATH = savedPath;
  assert(
    faulted.problem !== "" && faulted.priorEnv.installed === false,
    `discriminant: makeFixture's fault arm records installed:false, the same tag (${JSON.stringify(faulted.priorEnv)}, problem=${faulted.problem.slice(0, 40)})`,
  );
  // WITNESS 3 — the healthy arm carries the OTHER tag, so the two states are
  // distinguishable at runtime and not merely in a type nobody can print. Built
  // with both host pins set, the way `restore_case` builds it.
  const hostDir = mkdtempSync(path.join(os.tmpdir(), "discriminant-host-"));
  const savedLedger = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  const savedAgent = process.env.PI_AGENT_DIR;
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = path.join(hostDir, "ledger.json");
  process.env.PI_AGENT_DIR = path.join(hostDir, "agent");
  resetFindingsStateCache();
  const healthy = makeFixture();
  try {
    if (!okFixture(healthy, "discriminant", (m) => assert(false, m))) break discriminant_case;
    assert(
      healthy.priorEnv.installed === true,
      `discriminant: a fixture that DID install its pins records installed:true (${JSON.stringify(healthy.priorEnv)})`,
    );
    // WITNESS 4 — and the two tags drive two DIFFERENT behaviours, which is what
    // makes the tag observable rather than decorative: the sentinel release
    // leaves a host pin exactly where it is, and the release of the healthy
    // fixture moves it. Same env, same call, one field apart.
    // The env `makeFixture` installed and recorded: the fixture's own file, with
    // the host's path in the record. That is the state both arms start from, and
    // it is what separates a pin the case put there from a pin the FIXTURE put
    // there — the sentinel arm must preserve the former and the healthy arm must
    // undo the latter.
    const pinnedLedger = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    releaseFixture({ priorEnv: neverInstalledEnv() });
    const afterSentinel = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    releaseFixture(healthy);
    const afterHealthy = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    assert(
      pinnedLedger === healthy.ledgerFile &&
        healthy.priorEnv.installed === true &&
        healthy.priorEnv.ledgerFile !== healthy.ledgerFile,
      `discriminant: the fixture pinned the ledger to its own file and recorded the host's as prior (pinned=${JSON.stringify(pinnedLedger)}, recorded=${JSON.stringify(healthy.priorEnv.ledgerFile)})`,
    );
    assert(
      afterSentinel === pinnedLedger && afterHealthy !== pinnedLedger,
      `discriminant: the two arms do two different things (sentinel left it at ${JSON.stringify(afterSentinel)} where the fixture had pinned ${JSON.stringify(pinnedLedger)}; the healthy release moved it to ${JSON.stringify(afterHealthy)})`,
    );
    // WITNESS 5 — `assertUnset` answers the tag too: the sentinel record is
    // refused, the healthy one is auditable. A release guard that fell through
    // both arms would still answer here, so the refusal is checked for its
    // subject and not just its shape.
    const refusal = assertUnset({ priorEnv: neverInstalledEnv() }, "discriminant");
    const audit = assertUnset(healthy, "discriminant");
    // The refusal is pinned to THIS arm the way H5 pins the four env arms: the
    // arm's OWN spelling is required, and each other arm's spelling is excluded.
    // Before this, the witness read `length === 1` plus `"never installed"` plus
    // `audit.length === 0`, and the reviewer's cross-emission mutant — the
    // sentinel arm rewritten to print the LEDGER was-unset arm's message
    // verbatim — satisfied every clause, because `"never installed"` was the
    // only own-subject and the shipped `!=` / `still present` exclusions came
    // from `never-built`'s witness, not this one. Measured with this clause
    // relaxed to the H5-era shape (length + anti-clauses, own-subject gone):
    // `reds=0 greens=21` here. The three exclusions are the whole set of
    // spellings the other arms can emit: `still present` and `!=` are
    // `assertUnset`'s four env arms, and `still in process.env after the
    // release` belongs to `releaseUnpinProblems` (see WITNESS 6).
    assert(
      refusal.length === 1 &&
        refusal[0]?.includes("never installed") === true &&
        refusal[0]?.includes("its release judges nothing") === true &&
        refusal[0]?.includes("still present") === false &&
        refusal[0]?.includes("!=") === false &&
        refusal[0]?.includes("still in process.env after the release") === false &&
        audit.length === 0,
      `discriminant: assertUnset refuses the sentinel record and audits the healthy one (refusal=${JSON.stringify(refusal)}, audit=${JSON.stringify(audit)})`,
    );
    // WITNESS 6 — and the unpin witness REFUSES the sentinel record rather than
    // certifying it. This is the arm H4's whole shape turns on: a release that
    // ran no branch has nothing to certify, and a witness returning `[]` for it
    // is the silent-green this file exists to remove. Checked separately from
    // `assertUnset`'s refusal because the two predicates answer different
    // questions — "is this record's restore correct" and "did the release unset
    // what it installed" — and a mutation of one must not silence the other.
    const sentinelUnpin = releaseUnpinProblems({ priorEnv: neverInstalledEnv() }, "sentinel");
    // Same structural independence as WITNESS 5 above and as H5's four arms: the
    // arm's own spelling required, every other arm's spelling excluded. The
    // exclusions are drawn from the OTHER function's arms rather than this one's
    // because `releaseUnpinProblems` has only three arms and the two unpin arms
    // have no vocabulary in common with this one — so what a cross-emitting
    // mutant actually produces is one of `assertUnset`'s four env-arm messages
    // (`still present` / `!=`) or one of this function's own unpin messages
    // (`still in process.env after the release`). A `length === 1` plus
    // one-subject reading accepts any of them: measured, the mutant that makes
    // this arm emit the LEDGER unpin arm's message verbatim reddens only once
    // the exclusion is present.
    assert(
      sentinelUnpin.length === 1 &&
        sentinelUnpin[0]?.includes("judged no pin") === true &&
        sentinelUnpin[0]?.includes("its unpin is unwitnessed") === true &&
        sentinelUnpin[0]?.includes("still in process.env after the release") === false &&
        sentinelUnpin[0]?.includes("still present") === false &&
        sentinelUnpin[0]?.includes("!=") === false,
      `discriminant: releaseUnpinProblems refuses to certify a release that installed nothing (problems=${JSON.stringify(sentinelUnpin)})`,
    );
  } finally {
    if (savedLedger === undefined) delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = savedLedger;
    if (savedAgent === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = savedAgent;
    resetFindingsStateCache();
    removeFixture(faulted);
    removeFixture(healthy);
    rmSync(hostDir, { recursive: true, force: true });
  }
  break discriminant_case;
}

process.exit(exit);
