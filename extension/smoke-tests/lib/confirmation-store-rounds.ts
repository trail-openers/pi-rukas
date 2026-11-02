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
      /** #1125 — memory the round set aside. OPTIONAL, and deliberately so: the
       * store omits the key rather than writing an empty list
       * (review-findings-store.ts:375-377), and no test in this branch reads a
       * *missing* `setAside` as a finding. Where an absent field means "nothing
       * happened", the helper supplies `[]` instead — see `lapsed`. */
      setAside?: SetAsideNotice[];
      /**
       * #1934 AC4 — the rows whose independent confirmation lapsed. REQUIRED on
       * the success arm, and that requirement is the whole point of the field
       * being here rather than a `?:` beside `setAside`.
       *
       * `lapsed` is the ONLY disclosure of the AC4 event: the row itself keeps
       * `confirmationLapsed: true` but the proof of WHAT lapsed — the provenance
       * of the confirmation it was retired on — lives in this notice, and
       * `test-review-findings-confirmed-store.ts`'s AC4 witness reads exactly one
       * thing (`second.lapsed?.some(l => … && /patch=/.test(l.provenance))`). With
       * the field optional, a helper that dropped it — an `asSetup` that stopped
       * forwarding `out.lapsed`, or a `{...}` spread that lost the key — made
       * #1934's central disclosure vanish with ZERO reds: `?.some(...)` on
       * `undefined` is `undefined`, `=== true` is false, and the one assertion
       * that would notice is in a different file's `break`-guarded block. Making
       * it required turns "the helper forgot to carry the lapse" into a compile
       * error at the helper, which is the only place the bug can be caught cheaply.
       *
       * EMPTY IS NOT ABSENT, and the type keeps them apart: an empty array is a
       * round that found no lapse (a real, reportable answer) and `undefined`
       * cannot be written here at all. The helpers therefore pass `[]` rather
       * than omitting, so a case that never reads the field is still a case whose
       * lapse disclosure exists to be read. Proven non-vacuous by the
       * `lapsed-dropped` mutant in `test-review-findings-release-discriminant.ts`.
       */
      lapsed: ConfirmationLapse[];
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
        // `?? []` and not `out.lapsed`: the store omits the key when the list is
        // empty (review-findings-store.ts:375-377), so the round's own answer for
        // "no lapse" is `undefined`, and forwarding it would put that `undefined`
        // on the arm whose whole job is to say "this round reported its lapses".
        // `[]` is the same answer in the shape the type can carry, and it is what
        // keeps an empty disclosure distinguishable from a missing one — see the
        // field's docstring on `SetupOutcome`.
        lapsed: out.lapsed ?? [],
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
