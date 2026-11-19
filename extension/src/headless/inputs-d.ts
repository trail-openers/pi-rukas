/**
 * headless/inputs-d — the S–T rows of the `HEADLESS_INPUTS` list, imported and
 * spliced into place by `inputs-b.ts`.
 *
 * Split out along the same alphabetical seam the list is already sorted on, for
 * the §12 file-size cap (the pattern `inputs-c.ts` established): `inputs-b.ts`
 * carries the inventory in order and a per-range module holds a block of rows,
 * so a new knob never pushes the spine past the cap on its own. `inputs-b.ts`
 * splices this block at the position the list's own collation puts it — after
 * the R block (`HEADLESS_INPUTS_C`) and before `USER_EXTENSION` — so the
 * exported array stays sorted by name, which is what `test-headless-inputs.ts`
 * asserts.
 */

import { type HostInput, ROLE_MEMBERS, dir, family, flag, input, int, ms, str } from "./entry.ts";

/** The S–T rows, in the list's order. */
export const HEADLESS_INPUTS_D: readonly HostInput[] = [
  flag("SAFETY_NET_COMMIT", true),
  flag("SANDBOX_MODE", false, "sandbox"),
  input("SCOPE_FANOUT_FACTOR", "number", 3),
  int("SCOPE_FANOUT_MIN", 6),
  flag("SCOPE_GATE", true),
  flag("SEAM_ESCALATION", true),
  flag("SESSION_REATTACH", false),
  // #1521 — how long a child that reported may linger before it is reaped.
  ms("SETTLED_REAP_MS", 60_000),
  dir("SKILLS_DIR", "~/.pi/agent/skills"),
  flag("SKIP_RATCHET", true),
  flag("SLOW_NOTICE", true),
  ms("SLOW_NOTICE_MS", 1_200_000),
  int("SLOW_NOTICE_TOKENS", 20_000_000, "cycle", { unit: "tokens" }),
  int("SLOW_NOTICE_TURNS", 150, "cycle", { unit: "turns" }),
  flag("SMOKE", true),
  int("SPAWN_CAP", 64),
  ms("SPAWN_TIMEOUT_MS", 7_200_000),
  flag("SPECULATIVE_EXPLORE", false),
  ms("STALE_THRESHOLD_MS", 900_000, "interactive"),
  ms("STEP_NOTICE_MS", 5_400_000),
  flag("STRICT_PERMISSIONS", false),
  flag("SUBAGENT_MODE", false, "internal"),
  str("SUBAGENT_MODEL", null),
  str("SUBAGENT_PROVIDER", null),
  flag("SYMBOL_MERGE_RETRY", true),
  // #1454 r2 — a TEST-ONLY fault injection: force the path-claims lock
  // unreachable so `test-work-driver-claims-concurrent-writers.ts` can prove its
  // own positive assertion can fail. Listed (not exempted) because the gate
  // sweeps every `PI_ENSEMBLE_*` read in src/ regardless of who sets it: an
  // operator who exports it gets an UNSERIALISED claim registry, which is
  // exactly the kind of outcome-changing knob this table exists to surface.
  flag("TEST_CLAIMS_LOCK_BLOCKED", false, "internal"),
  // #1454 r2 — a TEST-ONLY knob: widen the read-modify-write window of a claim
  // writer by this many ms, so the mutation arm of
  // `test-work-driver-claims-concurrent-writers.ts` loses a claim
  // DETERMINISTICALLY instead of only when eight children happen to overlap.
  // Read ONLY while `PI_ENSEMBLE_TEST_CLAIMS_LOCK_BLOCKED=1` is also set —
  // `resolveClaimsWindowMs` returns 0 without it — so a production cycle never
  // waits here and the delay cannot reach a real run.
  ms("TEST_CLAIMS_WINDOW_MS", 0, "internal"),
  int("TEST_DELETE_TOLERANCE", 0),
  flag("TIMEOUT_FLAG_PRECEDENCE", true), // #2362: --timeout beats an exported budget
  // Unset: no budget for any role (#1642); an explicit value arms a ceiling.
  family(int("TOKEN_BUDGET_<ROLE>", null, "cycle", { unit: "tokens" }), ROLE_MEMBERS),
  ms("TOOL_INACTIVITY_TIMEOUT_MS", 3_600_000),
  // #1879 — the compiler-integrity canary. 0 skips it and every guarded tier
  // then says "compiler integrity not checked" rather than going silent.
  flag("TOOLCHAIN_CANARY", true),
  input("TRANSCRIPT_RETENTION_DAYS", "number", 5, "cycle", { unit: "days" }),
  flag("TRANSIENT_RETRY", true),
  ms("TRANSIENT_RETRY_BACKOFF_MS", 5_000),
  flag("TRUST_MODE", false, "internal"),
  // 0 = off; 1 = nudge at turn 80; any other positive integer is the turn.
  int("TURN_NUDGE", 0, "cycle", { unit: "turns" }),
];
