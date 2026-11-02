/**
 * #1934 — the store-shaped fixture the confirmation tests share: a real clone
 * with a real review identity, an isolated ledger + findings store, and the
 * seeded open CRITICAL row a confirmation retires.
 *
 * Extracted from smoke-tests/test-review-findings-confirmed-retire.ts for the
 * AGENTS.md §12 500-line gate — the #1934 untouched-row cases pushed that file
 * over the cap, and the fixture plus its seeding helpers are the half that is
 * pure plumbing rather than assertion. Both the store-round file and the join
 * file build the SAME fixture, so the split also removes the two hand-copied
 * versions of the clone recipe drifting apart (the isolation contract below is
 * the kind of thing that silently stops isolating when one copy is edited).
 *
 * Isolation contract (load-bearing, copied verbatim from the sibling):
 * `PI_ENSEMBLE_REVIEW_LEDGER_FILE` pins BOTH the ledger and the findings store
 * into the fixture dir, so a round reads and writes only this test's files, and
 * the ledger a confirmation is read from is a file the test wrote. The env is
 * set only AFTER every git call, because a relative
 * `git rev-parse --git-common-dir` answer is resolved against `cwd`.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import path from "node:path";
import type { Finding } from "../../src/lens-review-types.ts";
import { readBranchRows } from "../../src/review-findings-store.ts";
// Re-exported for the round-driving consumers that import the store's entry
// point from the fixture module rather than from `src/` (window-guards-helpers,
// the confirmed-store and untouched-confirm files). Removing it would be an API
// change dressed as a refactor.
export { recordFindingRunOutcome } from "../../src/review-findings-store.ts";
import type { StoredFinding } from "../../src/review-findings-file.ts";
import type { LedgerEntry } from "../../src/review-ledger-entry.ts";
import { resetFindingsStateCache } from "../../src/review-state-path.ts";
// The store-round drivers live in `confirmation-store-rounds.ts` (the §12
// 500-line gate split them along the seam this file's jsdoc names: clone recipe
// here, store traffic there). They are RE-EXPORTED rather than moved out of
// reach so every consumer keeps ONE import for the fixture and the channels that
// guard it — the split is a file boundary, not an API change, and no call site
// had to learn the new module's name.
export type { SeedResult, SetupOutcome } from "./confirmation-store-rounds.ts";
export { asSetup, seed, seedOk, reReport, silentRound } from "./confirmation-store-rounds.ts";
import type { SeedResult } from "./confirmation-store-rounds.ts";

/** The head content of `src/a.ts` every case cites line 3 of. */
export const HEAD_LINES = [
  "// header",
  "export function a() {",
  "  return unsafe(raw);", // the cited line — never changed by any case here
  "}",
  "export const b = 2;",
];
export const CITED = 3;

/** The finding round 1 files; identical line/path/title so round 2 re-reports it. */
export const FINDING: Finding = {
  lens: "PERFORMANCE",
  severity: "CRITICAL",
  path: "src/a.ts",
  line: CITED,
  title: "Unvalidated input reaches the executor",
};

export async function rowsOf(dir: string): Promise<{ rows: StoredFinding[]; problem: string }> {
  try {
    return { rows: await readBranchRows(dir, "feature/work"), problem: "" };
  } catch (err) {
    return {
      rows: [],
      problem: `rowsOf: ${String((err as Error)?.message ?? err)}`.slice(0, 200),
    };
  }
}

/** How long one fixture `git` call may take before it is a fault rather than a
 * slow machine. Generous by design: every call below runs against a temp dir on
 * the same disk, so a real one returns in milliseconds, and the number exists
 * only to bound the case that would otherwise hang the suite — a `git` waiting
 * on a credential or editor prompt it will never get an answer to. Without a
 * `timeout` an `execFileSync` waits forever and every remaining case in the
 * file never runs, which is the same silent-green shape as the uncaught throw
 * this file's setup channel exists to remove, reached by a different road. */
const GIT_TIMEOUT_MS = 30_000;

export const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
  }).trim();

export interface ConfirmationFixture {
  root: string;
  dir: string;
  ledgerFile: string;
  /** The head commit, or "" when the fixture did not build. `headSha` is the
   * build's output, so an empty one IS the fault signal — see `problem`. */
  headSha: string;
  /** The values BOTH env pins had BEFORE this fixture set them, so
   * `releaseFixture` can restore them. `undefined` means "was not set" and
   * `null` means "this fixture never installed the pins" — see `FixtureEnv`.
   * A fixture that did not build carries `null` on BOTH members. */
  priorEnv: FixtureEnv;
  /** "" when the fixture is usable; otherwise why it is not. A fixture that
   * could not be built is a SETUP FAULT, reported here rather than thrown:
   * `makeFixture` runs OUTSIDE every caller's `try/finally` — it is what the
   * `try` is entered WITH — so a throw escaped the file as an unhandled
   * exception, and bun then reported the whole run with zero `✗` lines while
   * every case after the fault silently did not run. Measured on the
   * pre-channel shape: neutralising one `git` step printed 2 lines and every
   * later case was absent. A caller asks `okFixture` and skips its case, which
   * reddens BY NAME and lets the other cases still run. */
  problem: string;
}

/** A fixture the caller may actually use: built, with a head sha in hand. */
export type GoodFixture = ConfirmationFixture & { headSha: string; problem: "" };

/** Narrow a fixture, recording a build fault as a NAMED RED instead of throwing
 * it. The companion to the `problem` field, and the reason no call site needs
 * `!` or `as`: through this predicate the compiler will not hand out `f.dir` /
 * `f.headSha` until the check has been made — the same discipline that types
 * the fixture's ledger rows on the reader's own entry type rather than casting. */
export function okFixture(
  f: ConfirmationFixture,
  label: string,
  report: (msg: string) => void,
): f is GoodFixture {
  const ok = f.problem === "" && f.headSha !== "";
  if (!ok) report(`${label}: the fixture did not build (${f.problem || "no head sha"})`);
  return ok;
}

/** The two env vars this fixture pins. `PI_ENSEMBLE_REVIEW_LEDGER_FILE` pins
 * the ledger AND (via `review-state-path.ts`) the findings store; `PI_AGENT_DIR`
 * pins whatever state a round resolves against the agent home. */
const LEDGER_ENV = "PI_ENSEMBLE_REVIEW_LEDGER_FILE";
const AGENT_DIR_ENV = "PI_AGENT_DIR";

/** The two env values a fixture saved, so `releaseFixture` can put them back.
 *
 * THREE states per member, and the third is the one that keeps the teardown
 * safe:
 * - a string  — the pin was set, so release restores exactly that value;
 * - `undefined` — the pin was NOT set when this fixture installed its own,
 *   so release deletes it (it is the fixture's own pin being removed);
 * - `null` — THIS FIXTURE NEVER INSTALLED THE PINS, so release does nothing at
 *   all with that member.
 *
 * WHY `null` AND NOT `undefined` OR A MISSING FIELD. The fault arm of
 * `makeFixture` returns a fixture whose recipe died BEFORE the pins were
 * installed (the pins are the last thing the recipe sets). Every consumer calls
 * `releaseFixture` unconditionally in its `finally`, and a member that meant
 * "was unset" makes that release `delete` the HOST's pin — so a fixture that
 * never set anything tears down pins it never touched, and every case after it
 * resolves through the non-override branch and writes rows into the real
 * per-clone review ledger or the developer's `~/.pi`, exactly the hazard this
 * file's jsdoc calls load-bearing. Measured on the shipped functions with both
 * host pins set: `before=["/host/ledger.json","/host/agent"] after=[null,null]`.
 * It is NEW behaviour — before the `{problem}` channel a faulting `makeFixture`
 * threw, so no `finally` ever ran. `undefined` cannot carry both meanings,
 * because it already means "delete" and that is the dangerous one; so the skip
 * signal is a distinct value the type makes unmissable: `priorEnv` cannot
 * express "unset the host's value" for a fixture that never set it. The two
 * representations are one keystroke apart and only one is safe, which is why the
 * sentinel is spelled out here rather than inferred at the call site. */
export interface FixtureEnv {
  ledgerFile: string | undefined | null;
  agentDir: string | undefined | null;
}

/** Build an isolated clone whose head carries a fix in a DIFFERENT file, so the
 * cited line is byte-unchanged at head for every case built on it. */
export function makeFixture(): ConfirmationFixture {
  const root = mkdtempSync(path.join(os.tmpdir(), "conf-store-"));
  const dir = path.join(root, "repo");
  const ledgerFile = path.join(root, "review-ledger.json");
  // A fault still hands back a `root`, so the caller's `finally` can
  // `removeFixture` it: a failed build that leaked its temp dir would turn one
  // fault into a disk leak multiplied by every remaining case.
  const unusable = (why: string): ConfirmationFixture => ({
    root,
    dir,
    ledgerFile,
    headSha: "",
    // `null`, NOT `undefined`, on both members. `undefined` is the record that
    // says "this pin was unset when I installed mine, so delete it on release" —
    // and this fixture installed NOTHING. `null` is the sentinel `releaseFixture`
    // reads as "leave this variable alone": see `FixtureEnv` for the measurement
    // of what the one-keystroke difference does to the host's pins.
    priorEnv: { ledgerFile: null, agentDir: null },
    problem: `fixture: ${why}`.slice(0, 240),
  });
  try {
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "t@t");
    git(dir, "config", "user.name", "T");
    git(dir, "config", "commit.gpgsign", "false");
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "a.ts"), `${HEAD_LINES.join("\n")}\n`);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    // `workingTreePatchId` resolves the identity against `<remote>/<mainline>`, so
    // the fixture needs the same origin the real clone has — without it there is
    // no patch id, and a round with no identity consults no confirmation (AC2's
    // answer, never AC1's).
    const origin = path.join(root, "origin.git");
    git(root, "init", "--bare", "-q", "--initial-branch=main", origin);
    git(dir, "remote", "add", "origin", origin);
    git(dir, "push", "-q", "-u", "origin", "main");
    git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    git(dir, "checkout", "-q", "-b", "feature/work");
    writeFileSync(path.join(dir, "src", "fix.ts"), "// the fix, in a DIFFERENT file\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "fix in another file");
    const headSha = git(dir, "rev-parse", "HEAD");
    // The env is pointed at THIS fixture only after every git call: a relative
    // `git rev-parse --git-common-dir` answer is resolved against `cwd`, so a
    // fixture that set the override first would key its store on a path under a
    // different directory than the one it writes to.
    // The pins are RESTORABLE, not destructive: whatever the process already had
    // is recorded and `releaseFixture` writes it back. A fixture that deleted the
    // variables instead would hand an OUTER fixture's rounds the host's real
    // paths the moment an inner case finished — and a round then writes rows into
    // the real per-clone review ledger or the developer's `~/.pi` state. Nothing
    // here would fail; the data is simply gone.
    const priorEnv = {
      ledgerFile: process.env[LEDGER_ENV],
      agentDir: process.env[AGENT_DIR_ENV],
    };
    process.env[LEDGER_ENV] = ledgerFile;
    process.env[AGENT_DIR_ENV] = path.join(root, "agent");
    resetFindingsStateCache();
    return { root, dir, ledgerFile, headSha, priorEnv, problem: "" };
  } catch (err) {
    // The env pins are deliberately NOT touched on this path. They are the last
    // thing the recipe sets, so a failure before them means the process still
    // holds its own ledger and agent dir — restoring them here would be an
    // unnecessary write over state nothing changed, and a `priorEnv` recorded
    // before the failure would claim a swap that never happened.
    return unusable(`git/fixture step failed: ${(err as Error)?.message ?? String(err)}`);
  }
}

/** Put back the env this fixture's `makeFixture` replaced. Call from a
 * `finally`, before `removeFixture`. It writes back exactly what `make` saved
 * (including "was unset" as an actual delete) and touches nothing else, so
 * nesting a fixture inside another fixture restores the outer's pins rather
 * than unpinning the process. */
/** What `releaseFixture` needs from its argument: the record `makeFixture` kept
 * of the env it replaced. A test that owns its own pins (it set them itself
 * rather than through `makeFixture`) hands back an object of this shape. A
 * faulted fixture's record carries `null` on both members, which `releaseFixture`
 * reads as "leave the host's pins alone" — see `FixtureEnv`. */
export interface ReleaseTarget {
  priorEnv: FixtureEnv;
}

export function releaseFixture(f: ReleaseTarget): void {
  // A `null` member means this fixture never installed the pins, so there is
  // nothing of ours to take back and NO reason to touch the variable — the
  // host's value stays exactly as it is. Checked FIRST, because `null` must
  // never fall through to the `delete` arm below. Both members are tested in
  // one condition: the only value that produces a `null` is `unusable()`, which
  // sets both, and a half-installed release is not a state this type allows.
  if (f.priorEnv.ledgerFile === null || f.priorEnv.agentDir === null) {
    // A fixture that never installed the pins leaves the env exactly as it found
    // it: no delete, no write, and no cache reset — nothing this call would
    // change is state the failed build moved. See `FixtureEnv` for the hazard
    // this arm exists to close.
    return;
  }
  if (f.priorEnv.ledgerFile === undefined) delete process.env[LEDGER_ENV];
  else process.env[LEDGER_ENV] = f.priorEnv.ledgerFile;
  if (f.priorEnv.agentDir === undefined) delete process.env[AGENT_DIR_ENV];
  else process.env[AGENT_DIR_ENV] = f.priorEnv.agentDir;
  resetFindingsStateCache();
}

/** The witness that `releaseFixture`'s two "was unset" branches really UNSET, and
 * that its two "was set" branches really compare.
 *
 * WHY IT LIVES HERE AND NOT ONLY IN A TEST. Biome's autofix for `delete x`
 * rewrites it to `x = undefined`, and on **bun** that assignment does not
 * remove the variable — it stores the 9-character string `"undefined"`. Every
 * consumer that reads the pin through `?.trim()` then sees a truthy path and
 * resolves state to a file literally named `undefined`, so the guard INVERTS
 * rather than defuses: the fixture looks unpinned and is in fact pinned
 * somewhere worse. Measured: applying that autofix to `releaseFixture` itself
 * left all four confirmation tests green, because the only witnesses of these
 * two branches lived in a test file's private copy of the same shape. This
 * function is the counter-witness on the SHARED original — a test asserts
 * absence through it, so the autofix reddens here and not only there.
 *
 * WHAT IS JUDGED, ARM BY ARM — measured, not asserted. There are four arms and
 * each was tested by deleting its BODY in a compiler-valid mutant (whole copy
 * of the repo under /tmp, `bun run` of the witness file, red line recorded):
 * - ledger / was-set   → RED   (`restore: a corrupted LEDGER restore is exactly
 *   one problem naming that pin`) — witnessed by the `restore` case.
 * - ledger / was-unset → RED   (`release: an "unset" pin re-pinned to the
 *   literal string is exactly one problem naming that pin`) — witnessed by the
 *   `unset_case`, whose inverted probe writes the literal string back and
 *   requires exactly one problem naming that pin.
 * - agent  / was-set   → RED   (`restore: a corrupted AGENT_DIR restore is
 *   exactly one problem naming that pin`) — witnessed by the `restore` case's
 *   agent-side corruption, which the split left in place.
 * - agent  / was-unset → **NOT WITNESSED by the arms below on its own.** The
 *   `unset_case`'s inverted probe corrupts only the LEDGER pin, so with the
 *   agent arm body deleted that case still sees "exactly one problem naming
 *   PI_ENSEMBLE_REVIEW_LEDGER_FILE" and stays green; the mutant measured
 *   `reds=0, greens=17`. The `unset_case`'s direct `!(NAME in process.env)`
 *   check does fail under the same mutant, because the release is the thing
 *   that must have deleted the key — so the BEHAVIOUR is caught even where this
 *   predicate's arm is not. What was added is the mirror of the ledger probe for
 *   `PI_AGENT_DIR`, which makes the arm itself able to go red.
 *
 * A future split that drops one of these cases reddens nothing but this
 * paragraph, which is the only place the arm-by-arm contract is stated — so it
 * states what is measured and names the one arm that needed its own probe.
 * A branch that cannot go red is not coverage, whatever this comment says. */
export function assertUnset(f: ReleaseTarget, label: string): string[] {
  const problems: string[] = [];
  if (f.priorEnv.ledgerFile === null || f.priorEnv.agentDir === null) {
    // A fixture that never installed the pins has no release to audit. Without
    // this arm the sentinel would fall into the `=== undefined` branch below and
    // report the host's own pin as a leak — `null` means "nothing to judge",
    // which is a different answer from "nothing wrong", and a witness that
    // returns `[]` for a case it never ran is the silent-green shape this file
    // exists to remove.
    return [
      `${label}: the fixture never installed the pins (priorEnv=${JSON.stringify(f.priorEnv)}), so its release judges nothing`,
    ];
  }
  if (f.priorEnv.ledgerFile === undefined) {
    if (LEDGER_ENV in process.env) {
      problems.push(
        `${label}: ${LEDGER_ENV} still present (${JSON.stringify(process.env[LEDGER_ENV])})`,
      );
    }
  } else if (process.env[LEDGER_ENV] !== f.priorEnv.ledgerFile) {
    problems.push(`${label}: ${LEDGER_ENV} != ${f.priorEnv.ledgerFile}`);
  }
  if (f.priorEnv.agentDir === undefined) {
    if (AGENT_DIR_ENV in process.env) {
      problems.push(
        `${label}: ${AGENT_DIR_ENV} still present (${JSON.stringify(process.env[AGENT_DIR_ENV])})`,
      );
    }
  } else if (process.env[AGENT_DIR_ENV] !== f.priorEnv.agentDir) {
    problems.push(`${label}: ${AGENT_DIR_ENV} != ${f.priorEnv.agentDir}`);
  }
  return problems;
}

export function removeFixture(f: ConfirmationFixture): void {
  rmSync(f.root, { recursive: true, force: true });
}

/** A SETUP channel every consumer of this fixture shares, so "a fault is a named
 * red, not an exception" is stated once rather than reinvented per file — which
 * is how one file ended up with `{ problem }` and its sibling with a `throw`.
 *
 * WHY IT TAKES `note` INSTEAD OF CALLING `assert` ITSELF: a test file imported
 * by another test file runs its top level — including its `process.exit(exit)`
 * — inside the importer's run, so a helper module cannot own the file's `assert`
 * or its exit code. The caller passes its own `assert` as `note`; the helper
 * owns only the shape of the question and the predicate that makes the value
 * usable afterwards without `!` or `as`.
 *
 * WHY ANY OF THIS INSTEAD OF A `throw`: these calls sit BEFORE the case's `try`
 * is entered, so a throw escaped the file as an unhandled exception and bun
 * reported the whole run with ZERO `✗` lines while every case after the fault
 * silently did not run. Measured on the pre-channel shape: neutralising one `git`
 * step printed 2 lines and the remaining cases were absent. A caller records the
 * red, `break`s out of its labelled block, and the other cases still run. */
export function setupOk<T extends { problem: string }>(
  setup: T,
  label: string,
  note: (msg: string) => void,
): setup is Extract<T, { problem: "" }> {
  const ok = setup.problem === "";
  if (!ok) note(`${label}: setup failed (${setup.problem})`);
  return ok;
}

/** `setupOk` specialised to `rowsOf`'s shape. */
export function rowsOk(
  r: { rows: StoredFinding[]; problem: string },
  label: string,
  note: (msg: string) => void,
): r is { rows: StoredFinding[]; problem: "" } {
  const ok = r.problem === "";
  if (!ok) note(`${label}: setup failed (${r.problem || "store read produced nothing"})`);
  return ok;
}

/** Write a ledger file. Typed on the reader's OWN entry type rather than on
 * `Array<Record<string, unknown>>`: a fixture row whose `kind` had been widened
 * to `string` used to reach the file and still type-check, and `validEntries`
 * (review-ledger-read.ts) then dropped the row, so the witness passed on an
 * empty join. Here the compiler checks every field against the type the reader
 * enforces. The shared fixture's writer and `window-guards-helpers.ts`'s local
 * copy are the SAME function now — the local copy existed only to narrow this
 * signature, and a second serializer is a second thing to get wrong. */
export function writeLedger(file: string, entries: LedgerEntry[]): void {
  writeFileSync(file, JSON.stringify({ entries }, null, 2), "utf8");
}
