/**
 * lean/spec-intake-switch — how a run obtains its `pi-spec v1` contract.
 *
 * `require` (the default, and today's behaviour byte-for-byte): the issue body
 * carries the block, and an issue without one is refused by `decline`.
 *
 * `derive`: an issue whose body carries NO block at all gets one derived inside
 * the run by one bounded read-only child (`lean/spec-derive.ts`), so a team
 * that writes tickets by hand can still run the engine. Every other parse
 * failure and every readiness failure declines exactly as it does under
 * `require` — the mode widens intake, it does not widen tolerance for a broken
 * contract.
 *
 * Resolution order: env (`PI_ENSEMBLE_LEAN_SPEC_INTAKE`) when set, then
 * `.pi/work.json` `lean.specIntake` (validated by `lean/config.ts` at load),
 * then `require`. An env value outside the two is an error naming the allowed
 * values, never a fallback: a typo'd knob that read as "the safe setting" would
 * be a silent behaviour change, in the direction where the run costs a model
 * call.
 *
 * The env is read at CALL time, like every other lean switch: the offline
 * suites share one bun process and pin their own arms with `withEnv`, so a
 * load-time read would let one file's pin disable the next file's.
 */

import type { WorkConfig } from "./config.ts";

/** The two modes, in the order `--capabilities` publishes them. */
export const SPEC_INTAKE_VALUES = ["require", "derive"] as const;

export type SpecIntake = (typeof SPEC_INTAKE_VALUES)[number];

/** The knob's env name, spelled once so the gate, the docs and this reader agree. */
export const SPEC_INTAKE_ENV = "PI_ENSEMBLE_LEAN_SPEC_INTAKE";

/** A knob set to something it cannot mean. Never collapsed into the default. */
export class SpecIntakeError extends Error {
  override readonly name = "SpecIntakeError";
}

/** The reason a refused value reads the way it does: it names both allowed values. */
function refusal(where: string, value: unknown): SpecIntakeError {
  return new SpecIntakeError(
    `${where} must be one of ${SPEC_INTAKE_VALUES.join(", ")} (got ${JSON.stringify(String(value))})`,
  );
}

/**
 * Validate one knob value. `undefined` means "this source said nothing", which
 * lets the next source decide; anything but the two names is refused.
 */
export function validateSpecIntake(
  value: unknown,
  where = SPEC_INTAKE_ENV,
): SpecIntake | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !SPEC_INTAKE_VALUES.includes(value as SpecIntake))
    throw refusal(where, value);
  return value as SpecIntake;
}

/**
 * The resolved mode: env when set, else the run's committed config, else
 * `require`. `config` is what `loadWorkConfig` returned for this run's base —
 * the loader already refused a value outside the two, so a read here cannot
 * invent a mode a file could not carry.
 */
export function resolveSpecIntake(config?: WorkConfig): SpecIntake {
  const env = validateSpecIntake(process.env[SPEC_INTAKE_ENV]);
  if (env !== undefined) return env;
  const fromConfig = config?.lean?.specIntake;
  return fromConfig ?? "require";
}

/**
 * The mode the env alone decides, for a caller that has no config in hand yet.
 * A read that exists so a case (and the headless flag check) can ask the env
 * half of the resolution without loading a config first.
 */
export function specIntakeFromEnv(config?: WorkConfig): SpecIntake {
  return resolveSpecIntake(config);
}

/**
 * Apply the `--spec-intake <mode>` verb flag for one headless run; returns the
 * refusal text, or `undefined` when the flag was absent or valid.
 *
 * Written to the env the switch reads, and as late as the parser allows: `process.env`
 * is process-wide, so a value written early (or left) would arm the next run in this
 * host, including an interactive one that never asked. Validated here rather than
 * left to the switch so a `--spec-intake derve` typo is an argument error the host
 * sees, not a run that declined every ticket it was meant to take.
 */
export function applySpecIntakeFlag(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!SPEC_INTAKE_VALUES.includes(value as SpecIntake))
    return `--spec-intake must be one of ${SPEC_INTAKE_VALUES.join(", ")}`;
  process.env[SPEC_INTAKE_ENV] = value;
  return undefined;
}
