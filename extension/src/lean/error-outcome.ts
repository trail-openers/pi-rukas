/**
 * lean/error-outcome — the ONE outcome the engine records when a handler throws.
 *
 * A handler that throws is infrastructure, so the step records
 * `{kind: "error", message}` and the run ends handed-back. That record is also
 * the only place a failed step's cost can still be read: a dispatch that died
 * spent its tokens, and `state.ts` gives the three dispatching steps
 * (`specify`, `build`, `challenge`) a `dispatches` field for exactly that
 * (#1920 A). The steps therefore hand their rows back on the error itself —
 * `BuildInfraError`, `ChallengeInfraError` and `SpecifyInfraError` each carry a
 * `dispatches` array — and this module is what moves them onto the record.
 *
 * Two rules, both load-bearing:
 *
 *   - only a step that OWNS dispatches gets the field. An outcome carrying it
 *     on another state is refused at load by `OWNER_OF_FIELD` in
 *     `state-outcome.ts`, so writing one there would make the durable record
 *     of a run that hit this branch unreadable — the rows are dropped rather
 *     than the load broken;
 *   - only an ARRAY of well-formed rows is copied. `rowsOf` reads a structural
 *     property off an untrusted value (a handler may throw anything) and rebuilds
 *     each row from its own checks: a truthy non-array, or a row the validator
 *     would refuse, is dropped rather than written — a bad row would make the
 *     durable record of a run that hit this branch unreadable.
 *
 * A leaf module: it imports no step and no engine type, so the engine stays
 * inside the size cap and the rules can be read — and tested — on their own.
 */

import type { Outcome } from "./state.ts";
import type { DispatchUsageRow } from "./step-budget.ts";

/** The three states whose step may pay for a child, hence record its cost. */
const DISPATCHING_STATES: readonly string[] = ["specify", "build", "challenge"];

/** What the engine records for one handler throw: a message, and rows when it has them. */
export type ErrorOutcome = Outcome & { kind: "error"; dispatches?: DispatchUsageRow[] };

/**
 * The rows a throw brought back, copied into the SHAPE the record demands.
 *
 * The value was already validated once, by the step that built it through
 * `dispatchUsageRow`; reading it back field by field here keeps the recorded
 * rows a product of this module's own check rather than a cast over an
 * untrusted throw — a handler may throw anything, and a row missing its usage
 * report would be refused at load and cost the run its whole state file.
 */
function rowsOf(err: unknown): DispatchUsageRow[] | undefined {
  const rows = (err as { dispatches?: unknown })?.dispatches;
  if (!Array.isArray(rows)) return undefined;
  const out: DispatchUsageRow[] = [];
  for (const raw of rows) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const u = row.usage as Record<string, unknown> | undefined;
    if (
      typeof row.role !== "string" ||
      row.role === "" ||
      typeof row.ok !== "boolean" ||
      typeof row.ms !== "number" ||
      !Number.isFinite(row.ms) ||
      row.ms < 0 ||
      u === undefined ||
      !["input", "output", "cacheRead", "cacheWrite", "turns"].every(
        (k) => typeof u[k] === "number" && Number.isSafeInteger(u[k]) && (u[k] as number) >= 0,
      ) ||
      typeof u.cost !== "number" ||
      !Number.isFinite(u.cost) ||
      u.cost < 0
    )
      continue;
    out.push({
      role: row.role,
      ms: row.ms,
      ok: row.ok,
      usage: {
        input: u.input as number,
        output: u.output as number,
        cacheRead: u.cacheRead as number,
        cacheWrite: u.cacheWrite as number,
        cost: u.cost,
        turns: u.turns as number,
      },
    });
  }
  return out.length === 0 ? undefined : out;
}

/**
 * The outcome the engine records for a handler that threw `err` in `state`.
 * A non-empty `message` always survives; the rows are added only when both
 * rules above hold.
 */
export function errorOutcome(state: string, err: unknown): ErrorOutcome {
  const message = (err as Error)?.message ?? String(err);
  const rows = DISPATCHING_STATES.includes(state) ? rowsOf(err) : undefined;
  return rows === undefined || rows.length === 0
    ? { kind: "error", message }
    : { kind: "error", message, dispatches: rows };
}
