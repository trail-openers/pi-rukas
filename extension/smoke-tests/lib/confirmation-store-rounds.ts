/**
 * #1934 — the store-round drivers the confirmation tests share: the seeded
 * filing, the re-reporting round, and the silent (untouched-row) round, each
 * widened with the `{ problem }` setup channel.
 *
 * Split out of `confirmation-store-fixture.ts` for the AGENTS.md §12 500-line
 * gate. The seam is the one the fixture's own jsdoc already names: that file is
 * the CLONE RECIPE and its env pins (a real clone, a real review identity, the
 * two isolated pins), and this one is the store traffic driven ON TOP of a
 * built fixture. Nothing here touches `process.env` — every function takes the
 * fixture's `dir`/`headSha` as an argument and calls into the store, so moving
 * them cannot affect the isolation contract, which lives entirely next to
 * `makeFixture` / `releaseFixture`.
 *
 * The `SetupOutcome` / `SeedResult` unions and the `asSetup` / `seedOk`
 * narrowing helpers ride along because they describe THESE returns; a caller
 * that drives a round itself (this repo's untouched file, through
 * `recordFindingRunOutcome`) gets one failure convention from here rather than
 * inventing a second beside the first.
 */

import type { Finding } from "../../src/lens-review-types.ts";
import { recordFindingRunOutcome } from "../../src/review-findings-store.ts";
import type {
  Decision,
  ResolvedNotice,
  SetAsideNotice,
  StoredFinding,
} from "../../src/review-findings-file.ts";
import type { ConfirmationLapse } from "../../src/review-findings-store-types.ts";
import type { RecordOutcome } from "../../src/review-findings-store.ts";
import { FINDING, rowsOf } from "./confirmation-store-fixture.ts";

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
  // A PLAIN object type on the fault arm, not an intersection. `setupOk` in the
  // fixture module narrows with `T & { problem: "" }`, and if the fault arm were
  // itself an intersection the narrowed union is `{…} | (A & B & {problem:""})` —
  // an arm whose discriminant sits inside an intersection, which TypeScript will
  // not discriminate. The symptom is not a confusing error but NO error:
  // `out.resolved` reported as absent on an arm that has it, which is how a
  // guard that works becomes a guard that silently does not.
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

/** `setupOk` (see the fixture module) specialised to the shape `seed` returns,
 * so a call site narrows to `s.row` instead of re-declaring the record. It lives
 * here because it is the narrowing OF `seed`'s return: moving `seed` moved its
 * predicate with it, so the two cannot drift apart. */
export function seedOk(
  s: SeedResult,
  label: string,
  note: (msg: string) => void,
): s is { row: StoredFinding; problem: "" } {
  const ok = s.problem === "" && (s as { row?: StoredFinding }).row !== undefined;
  if (!ok) note(`${label}: setup failed (${s.problem || "seed produced no row"})`);
  return ok;
}

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
