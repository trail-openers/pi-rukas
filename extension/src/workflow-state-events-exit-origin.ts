/**
 * /work workflow state — the closed exit-origin vocabulary (#1247).
 *
 * Where a `session_shutdown` came from, as the `cycle-interrupted` event
 * records it. Pi's `reason` field only ever says `quit` / `reload` / `new` /
 * `resume` / `fork`, which cannot distinguish a signal from a closed pipe from
 * a session that simply ended, so the origin is tracked at the process level
 * (exit-cause.ts) and stored on the event.
 *
 * The vocabulary lives HERE, in the schema layer, for two reasons:
 *
 * - **No import cycle.** `workflow-state-events.ts` types the event field and
 *   exit-cause.ts produces the value; if either owned the union the other had
 *   to import across that boundary. A type-only module with no runtime
 *   imports sits under both.
 * - **The validator must be able to reject a value it cannot name.**
 *   `validateDiscriminants` reads `KNOWN_EXIT_ORIGINS` to refuse a state file
 *   whose origin is a string no tracker could have written — a fabricated
 *   `signal:SIGKILL` would otherwise render to the operator as a fact about
 *   what killed the session. The tuple and the type are checked against each
 *   other below, so the two cannot drift.
 *
 * `signal:${(typeof TRACKED_SIGNALS)[number]}` is the whole signal vocabulary:
 * a signal this module does not arm is NOT expressible, which is deliberate —
 * an origin the tracker can never record must not be a value the schema accepts.
 */

/** The signals `armExitCause` listens for. Arm from this tuple; nothing else. */
export const TRACKED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** The origin the extension can actually observe, or `unknown`. */
export type ExitOrigin =
  | "stdin-eof" // stdin reached EOF: the caller closed its input pipe
  | `signal:${(typeof TRACKED_SIGNALS)[number]}` // a signal arrived (see TRACKED_SIGNALS)
  | "unknown"; // nothing explained it — Pi's own exit, or an unobservable quit

/**
 * Every `ExitOrigin`, as a runtime tuple. A value outside it is not an origin,
 * it is corruption: `validateDiscriminants` reports it so the cycle refuses to
 * resume on a shutdown whose cause is fiction.
 */
export const KNOWN_EXIT_ORIGINS: readonly ExitOrigin[] = [
  "stdin-eof",
  ...TRACKED_SIGNALS.map((sig) => `signal:${sig}` as const),
  "unknown",
];

// Compile-time exhaustiveness: a `TRACKED_SIGNALS` entry missing from the
// tuple, or a tuple entry that is not an `ExitOrigin`, lands a literal in
// `_originExhaustive` and fails tsc naming it. Mirrors the `MissingEventKinds`
// assertion in workflow-state-validate.ts.
type MissingOrigins = Exclude<ExitOrigin, (typeof KNOWN_EXIT_ORIGINS)[number]>;
const _originExhaustive: [MissingOrigins] extends [never] ? true : MissingOrigins = true;
void _originExhaustive;

/** True for a value the schema accepts as an origin (the validator's check). */
export function isKnownExitOrigin(value: unknown): value is ExitOrigin {
  return (KNOWN_EXIT_ORIGINS as readonly unknown[]).includes(value);
}
