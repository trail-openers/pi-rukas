/**
 * lean/spec-intake-switch — how a run obtains its `pi-spec v1` contract.
 *
 * `require` (the default): the issue body carries the block, and an issue without one is refused by
 * `decline`.
 *
 * `derive`: an issue whose body carries NO block at all gets one derived inside
 * the run by one bounded read-only child (`lean/spec-derive.ts`), so a team
 * that writes tickets by hand can still run the engine. Every other parse
 * failure and every readiness failure declines exactly as it does under
 * `require` — the mode widens intake, it does not widen tolerance for a broken
 * contract.
 *
 * Resolution order: the run's own override (the `start_lean_driver` tool's
 * `specIntake`) when given, then env (`PI_ENSEMBLE_LEAN_SPEC_INTAKE`) when set,
 * then `.pi/work.json` `lean.specIntake` (validated by `lean/config.ts` at load),
 * then `require`. An env value outside the two is an error naming the allowed
 * values, never a fallback: a typo'd knob that read as "the safe setting" would
 * be a silent behaviour change, in the direction where the run costs a model
 * call. The env is read at CALL time.
 */

import type { WorkConfig } from "./config.ts";

/** The two modes, in the order `--capabilities` publishes them. */
export const SPEC_INTAKE_VALUES = ["require", "derive"] as const;

export type SpecIntake = (typeof SPEC_INTAKE_VALUES)[number];

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

/** Validate one knob value: `undefined` means "this source said nothing" and lets the next
 * source decide; anything but the two names is refused. */
export function validateSpecIntake(
  value: unknown,
  where = "PI_ENSEMBLE_LEAN_SPEC_INTAKE",
): SpecIntake | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !SPEC_INTAKE_VALUES.includes(value as SpecIntake))
    throw refusal(where, value);
  return value as SpecIntake;
}

/**
 * The resolved mode: the run's override, else env when set, else the run's committed
 * config, else `require`. `config` is what `loadWorkConfig` returned for this run's base —
 * the loader already refused a value outside the two, so a read here cannot invent a mode
 * a file could not carry. Env before config means an operator's word beats a repo that
 * set `derive`; the override is a value, not an env write, so it arms this run only.
 */
export function resolveSpecIntake(config?: WorkConfig, override?: SpecIntake): SpecIntake {
  if (override !== undefined) return override;
  const env = validateSpecIntake(process.env.PI_ENSEMBLE_LEAN_SPEC_INTAKE);
  if (env !== undefined) return env;
  const fromConfig = config?.lean?.specIntake;
  return fromConfig ?? "require";
}

/**
 * Apply the `--spec-intake <mode>` verb flag for one headless run; returns the refusal
 * text, or `undefined` when the flag was absent or valid. Written to the env the switch
 * reads, and validated here rather than left to it, so a `--spec-intake derve` typo is
 * an argument error the host sees, not a run that declined every ticket. `process.env`
 * is process-wide, so the write happens as late as the parser allows (see the header).
 */
export function applySpecIntakeFlag(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!SPEC_INTAKE_VALUES.includes(value as SpecIntake))
    return `--spec-intake must be one of ${SPEC_INTAKE_VALUES.join(", ")}`;
  process.env.PI_ENSEMBLE_LEAN_SPEC_INTAKE = value;
  return undefined;
}
