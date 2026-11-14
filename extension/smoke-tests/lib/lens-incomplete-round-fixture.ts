/**
 * lib/lens-incomplete-writer-fixture — drive the REAL lens engine through
 * incomplete and completed rounds and read the ledger rows back, for the #2223
 * suites (`test-lens-incomplete-full-review.ts` and the arms that need the
 * writer's own output rather than a hand-built row).
 *
 * Two properties are load-bearing and are asserted HERE, where a broken fixture
 * fails loudly rather than making a case fail for the wrong reason:
 *
 *   - **a `blocked` round pays its fan-out.** The lens roster is resolved from the
 *     repository's own bundled `skill/` dir, so no lens is blocked by the HOST's
 *     missing install, and the round's blocked rows come from the caller's `block`
 *     predicate — the EDQUOT / spawn-failure shape the issue reproduces
 *     (`attempts: 0`). A fixture whose roster came back empty would block before the
 *     fan-out and make "the fan-out ran" unfalsifiable, so the blocked arm asserts a
 *     non-zero dispatch count on the way out. (An EMPTY skills dir cannot drive this:
 *     `runLensReview` refuses an empty roster before the fan-out, so a blocked round
 *     needs a healthy roster whose CHILDREN fail.)
 *   - **the ledger is this case's own file.** `PI_ENSEMBLE_REVIEW_LEDGER_FILE` is
 *     exported for the case's duration and restored (and its temp dir removed) by
 *     `cleanup`, so no later case in the process inherits it — the leak
 *     `test-ledger-isolation.ts` polices.
 *
 * Every row comes from the REAL write path (`runLensReview` →
 * `writeLensLedgerEntry` → `appendLedgerEntry` → `bumpLensRound`), so a row a stub
 * invented cannot make the delta readers lie.
 */

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runLensReview } from "../../src/lens-review.ts";
import {
  type LedgerEntry,
  appendLedgerEntry,
  readLedgerAt,
  workingTreePatchId,
} from "../../src/review-ledger.ts";
import { execp } from "../../src/exec.ts";
import { setupRepo } from "./review-ledger-test-helpers.ts";

/** One driven round: its summary and what it paid for. */
export interface DrivenRound {
  summary: Awaited<ReturnType<typeof runLensReview>>;
  /** How many lens children the round dispatched. */
  calls: number;
}

/** A case's fixture; `cleanup` restores the env and removes both temp dirs. */
export interface LensRoundFixture {
  repo: string;
  branch: string;
  /** The branch head when the fixture was built. */
  head: string;
  /** The ledger file this case owns (the override points here). */
  file: string;
  /** The lens rows this branch has, in file order. */
  rows: () => LedgerEntry[];
  /**
   * Drive one round. `block` says which lens children come back blocked; `full`
   * is the layer's own whole-branch opt-out.
   *
   * A case that needs to see WHAT the round did to the ledger — rather than what
   * it was allowed to do — also needs the fan-out to be REACHED: an
   * already-reviewed head takes the empty-delta arm and returns before it, so such
   * a case passes `full` and states that the opt-out is a premise, not the claim.
   *
   * The round's ledger write is fire-and-forget by contract (#912) and the next
   * round's delta base is the row this one left behind, so `drive` awaits the
   * layer's own await seam (#984) rather than sleeping: a delay is only ever a race
   * that happens to pass.
   */
  drive: (block: DriveBlock, opts?: { full?: boolean }) => Promise<DrivenRound>;
  /** Move the branch (and origin) one empty commit past where it stands. */
  advance: (message: string) => Promise<string>;
  /** Restore the env and remove this case's temp dirs. Idempotent. */
  cleanup: () => void;
}

/** Which of a round's six lens children report themselves blocked. */
export type DriveBlock = "none" | "all" | "first";

/** One blocked lens row: `ok: false`, `attempts: 0`, the named error as `parseError`. */
function blockedRow(name: string): Record<string, unknown> {
  return {
    lens: name,
    ok: false,
    ms: 0,
    startMs: Date.now(),
    findings: [],
    attempts: 0,
    blocked: true,
    parseError: "lens child spawn failed: quota exceeded",
  };
}

/** One clean lens row. */
function cleanRow(name: string): Record<string, unknown> {
  return {
    lens: name,
    ok: true,
    ms: 1,
    startMs: Date.now(),
    findings: [],
    attempts: 1,
    blocked: false,
    summary: "clean",
  };
}

export async function lensRoundFixture(opts: { name: string }): Promise<LensRoundFixture> {
  const dir = mkdtempSync(path.join(os.tmpdir(), `lens2223-${opts.name}-`));
  const file = path.join(dir, "review-ledger.json");
  const priorLedger = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  const priorSkills = process.env.PI_ENSEMBLE_SKILLS_DIR;
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = file;
  // Three levels up because this fixture lives in `smoke-tests/lib/`.
  process.env.PI_ENSEMBLE_SKILLS_DIR = path.resolve(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "skill",
  );
  const { repo, branch } = setupRepo();
  const head = headOf(repo, branch);

  const drive = async (
    block: DriveBlock,
    opts?: { full?: boolean },
  ): Promise<DrivenRound> => {
    let calls = 0;
    const pending: Promise<unknown>[] = [];
    const summary = await runLensReview({
      base: "origin/dev",
      head: branch,
      cwd: repo,
      branch,
      ...(opts?.full === true ? { full: true } : {}),
      onLedgerWrite: (p) => {
        pending.push(p);
      },
      lensChildFn: (async (a: { lens: { name: string } }) => {
        calls += 1;
        const blocked = block === "all" || (block === "first" && calls === 1);
        return (blocked ? blockedRow(a.lens.name) : cleanRow(a.lens.name)) as never;
      }) as never,
    });
    // A blocked round that dispatched nobody is a fixture that stopped early, and
    // every "the fan-out ran" assertion in the suite would then be vacuous.
    if (block !== "none" && calls === 0) {
      throw new Error("fixture: the blocked round dispatched no lens child (roster empty?)");
    }
    await Promise.all(pending);
    return { summary, calls };
  };

  let cleaned = false;
  return {
    repo,
    branch,
    head,
    file,
    rows: () => readLedgerAt(file).filter((e) => e.kind === "lens" && e.branch === branch),
    drive,
    advance: async (message: string) => {
      execSync(`git -c user.email=t@t.t -c user.name=t commit -q --allow-empty -m ${message}`, {
        cwd: repo,
        encoding: "utf8",
      });
      execSync("git push -q origin feature/x", { cwd: repo, encoding: "utf8" });
      return headOf(repo, branch);
    },
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      if (priorLedger === undefined) delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
      else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = priorLedger;
      if (priorSkills === undefined) delete process.env.PI_ENSEMBLE_SKILLS_DIR;
      else process.env.PI_ENSEMBLE_SKILLS_DIR = priorSkills;
      rmSync(path.dirname(repo), { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const headOf = (repo: string, ref: string): string =>
  execSync(`git rev-parse ${ref}`, { cwd: repo, encoding: "utf8" }).trim();

/** The identity the real writer computes for the repo at its current head. */
export async function roundIdentity(
  repo: string,
): Promise<{ patchId: string; diffSha256: string }> {
  const w = await workingTreePatchId(execp, repo, { digest: true });
  if (!w.patchId || !w.diffSha256) throw new Error(`fixture: no identity (${w.warning ?? "?"})`);
  return { patchId: w.patchId, diffSha256: w.diffSha256 };
}

/**
 * Write one lens row through the PRODUCTION writer and confirm it landed in the
 * file the readers open. A seeded row the writer refused — or that landed in
 * another file — would let a case assert about a ledger no reader can see.
 */
export async function seedLensRow(
  f: Pick<LensRoundFixture, "file" | "repo" | "branch">,
  over: Record<string, unknown>,
): Promise<void> {
  const entry = {
    branch: f.branch,
    kind: "lens",
    patchId: "p1",
    passed: false,
    at: Date.now(),
    detail: "REVIEW_INCOMPLETE",
    hasCritical: false,
    ...over,
  } as unknown as LedgerEntry;
  const stamped: { current: LedgerEntry; landedAtPath?: string } = { current: entry };
  const failure = await appendLedgerEntry(entry, execp, f.repo, stamped);
  if (failure) throw new Error(`fixture: the writer refused the row (${failure})`);
  if (!readLedgerAt(f.file).some((e) => e.at === entry.at)) {
    throw new Error("fixture: the row did not land in the file the readers open");
  }
}
