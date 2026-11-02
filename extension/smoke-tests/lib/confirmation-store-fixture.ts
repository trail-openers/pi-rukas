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
import { readBranchRows, recordFindingRunOutcome } from "../../src/review-findings-store.ts";
export { recordFindingRunOutcome } from "../../src/review-findings-store.ts";
import type {
  Decision,
  ResolvedNotice,
  SetAsideNotice,
  StoredFinding,
} from "../../src/review-findings-file.ts";
import type { ConfirmationLapse } from "../../src/review-findings-store-types.ts";
import type { RecordOutcome } from "../../src/review-findings-store.ts";
import type { LedgerEntry } from "../../src/review-ledger-entry.ts";
import { resetFindingsStateCache } from "../../src/review-state-path.ts";

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
   * `releaseFixture` can restore them. `undefined` means "was not set". */
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
 * `undefined` on either member means "this variable was not set when the
 * fixture made it", which release restores as an actual delete. */
export interface FixtureEnv {
  ledgerFile: string | undefined;
  agentDir: string | undefined;
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
    priorEnv: { ledgerFile: undefined, agentDir: undefined },
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
 * rather than through `makeFixture`) hands back an object of this shape. */
export interface ReleaseTarget {
  priorEnv: FixtureEnv;
}

export function releaseFixture(f: ReleaseTarget): void {
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
 * ALL FOUR BRANCHES ARE JUDGED, and where each is judged. The two "was unset"
 * arms (a pin the fixture found absent must be ABSENT after release) are
 * witnessed by the `unset_case` at the foot of
 * `test-review-findings-window-guards-env.ts`, including an arm that writes the
 * literal string back and requires exactly one problem naming that pin; the two
 * "was set" arms (a pin the fixture found set must EQUAL what it recorded) by the
 * `restore` case in the same file. The split that moved these cases out of
 * `test-review-findings-window-guards.ts` deleted the unset-arm witnesses and
 * left this comment claiming they existed — the claim is now the fact, and a
 * future split that drops one case reddens nothing but this paragraph, which is
 * the only place the four-branch contract is stated. */
export function assertUnset(f: ReleaseTarget, label: string): string[] {
  const problems: string[] = [];
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

/** `setupOk` specialised to the shape `seed` returns, so a call site narrows to
 * `s.row` instead of re-declaring the record. */
export function seedOk(
  s: SeedResult,
  label: string,
  note: (msg: string) => void,
): s is { row: StoredFinding; problem: "" } {
  const ok = s.problem === "" && (s as { row?: StoredFinding }).row !== undefined;
  if (!ok) note(`${label}: setup failed (${s.problem || "seed produced no row"})`);
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

/** What `seed` hands back: the filed row, or the reason it is not there. */
export type SeedResult = { row: StoredFinding; problem: "" } | { problem: string };

/** The store's own answer for one round, widened with a `problem` channel.
 *
 * WHY THE CHANNEL IS ON THE RETURN AND NOT IN A `throw`. `RecordOutcome` is
 * already `{ ok: false, reason }` for a round the STORE refused, and every one
 * of these three helpers had a caller that treated that as "assert it and carry
 * on" — so a refused round reached the assertions below it as a row that was
 * never filed. A `throw` was worse: these helpers are called before the case's
 * `try` is entered, so the exception escaped the file and bun printed ZERO `✗`
 * lines over a run in which the faulted case — and, because the file aborted,
 * every case after it — did not run. `{ problem }` is the shape that reddens by
 * name, sets the exit code, and still lets the rest of the file run.
 *
 * `problem` is the DISCRIMINANT, not just a field: `""` means the round
 * recorded and its `decisions` / `resolved` / `lapsed` are present, any other
 * string means it did not. A single-armed `problem: string` would leave the
 * compiler unable to settle which arm a guarded value is on once the guard
 * crosses a `finally` — a real shape in these files, where the case body is
 * inside `try` and its teardown is not. */
export type SetupOutcome =
  | {
      problem: "";
      ok: true;
      decisions: Decision[];
      carried: Finding[];
      resolved: ResolvedNotice[];
      setAside?: SetAsideNotice[];
      lapsed?: ConfirmationLapse[];
    }
  // A PLAIN object type on the fault arm, not an intersection. `setupOk` below
  // narrows with `T & { problem: "" }`, and if the fault arm were itself an
  // intersection the narrowed union is `{…} | (A & B & {problem:""})` — an arm
  // whose discriminant sits inside an intersection, which TypeScript will not
  // discriminate. The symptom is not a confusing error but NO error: `out.resolved`
  // reported as absent on an arm that has it, which is how a guard that works
  // becomes a guard that silently does not.
  | { problem: string; ok?: false; reason?: string };

/** Widen a round the caller drove DIRECTLY through the store's entry point into
 * the same `{ problem }` shape `reReport` / `silentRound` return. Exported so a
 * call site that needs `recordFindingRunOutcome` verbatim (this repo's untouched
 * file drives a round with its own `findings` / `now`) gets ONE failure
 * convention rather than inventing a second beside the first — the divergence
 * this file's channels exist to prevent. */
export const asSetup = (out: RecordOutcome, label: string): SetupOutcome =>
  // Written as two returns, not `{ problem: "" as const, ...out }`: spreading a
  // discriminated union makes the RESULT a union again and the compiler cannot
  // settle which arm it is — the same reason the row constructions in
  // `window-guards-helpers.ts` branch per arm instead of spreading. Each return
  // here is one arm, checked field by field against it.
  out.ok
    ? {
        problem: "",
        ok: true,
        decisions: out.decisions,
        carried: out.carried,
        resolved: out.resolved,
        setAside: out.setAside,
        lapsed: out.lapsed,
      }
    : { problem: `${label}: ${out.reason}`, ok: false, reason: out.reason };

/** Seed an open CRITICAL row through the real store (real hashes, real ids). */
export async function seed(dir: string, headSha: string): Promise<SeedResult> {
  const out = await recordFindingRunOutcome({
    cwd: dir,
    branch: "feature/work",
    headSha,
    findings: [FINDING],
    review: "full",
  });
  if (!out.ok) return { problem: `seed: filing round failed: ${out.reason}` };
  const read = await rowsOf(dir);
  if (read.problem !== "") return { problem: read.problem };
  const row = read.rows.find((r) => r.severity === "CRITICAL");
  if (!row) return { problem: "seed: filing round produced no CRITICAL row" };
  return { row, problem: "" };
}

/** A round that re-reports the finding, with confirmations consulted. */
export async function reReport(
  dir: string,
  headSha: string,
  patchId: string,
): Promise<SetupOutcome> {
  return asSetup(
    await recordFindingRunOutcome({
      cwd: dir,
      branch: "feature/work",
      headSha,
      findings: [FINDING],
      review: "full",
      confirmFixes: true,
      patchId,
      now: Date.now() + 10_000,
    }),
    "reReport",
  );
}

/** A round SILENT about the finding (the untouched-row shape), confirmations on. */
export async function silentRound(
  dir: string,
  headSha: string,
  patchId: string,
  now: number,
): Promise<SetupOutcome> {
  return asSetup(
    await recordFindingRunOutcome({
      cwd: dir,
      branch: "feature/work",
      headSha,
      findings: [],
      review: "full",
      confirmFixes: true,
      patchId,
      now,
    }),
    "silentRound",
  );
}
