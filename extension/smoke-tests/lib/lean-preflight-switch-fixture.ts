/**
 * smoke-tests/lib/lean-preflight-switch-fixture — the two switches of the runner
 * preflight's probe (#2202) judged as a truth table.
 *
 * A switch whose default is ON fails in exactly one direction and fails every
 * Python repo with it, so the four cells of each switch are worth more than the
 * behaviour case: the behaviour case is green whenever the switch is on, which is
 * how a switch whose off-arm reads the wrong variable, or whose "0" test matches
 * only the exact string, ships unnoticed. Each cell is read through the production
 * reader, and the reader is the only seam.
 *
 * `env` is a parameter and not `process.env`, for the reason every reader in this
 * repo has one: a case that mutates the ambient environment leaks the value into
 * whichever case runs after it, and the two files then disagree about what the
 * default is depending on order.
 *
 * The `specify` half of the same table — where the switch changes the outcome of a
 * whole run — lives in `test-lean-specify-preflight-py.ts`, which judges the child
 * contract through the `runSpecify` fixture rather than through a reader.
 */

import { leanPreflightProbeContainEnabled } from "../../src/lean/preflight-probe-switch.ts";

/** One cell of a switch's table: the value the environment carries, and the answer. */
export type Cell = readonly [label: string, value: string | undefined, want: boolean];

/** Every value a switch must answer for, with the answer the default-ON rule gives. */
export const CELLS: readonly Cell[] = [
  ["unset", undefined, true],
  ["''", "", true],
  ["'0'", "0", false],
  ["'1'", "1", true],
  ["'false'", "false", true],
  ["'NO'", "NO", true],
  ["' 0 '", " 0 ", true],
] as const;

/** Run every cell of one switch through its reader and report the failures. */
export function checkSwitch(opts: {
  name: string;
  read: (env: Record<string, string | undefined>) => boolean;
  key: string;
  assert: (cond: boolean, msg: string) => void;
}): { ok: boolean } {
  let ok = true;
  for (const [label, value, want] of CELLS) {
    const env: Record<string, string | undefined> = value === undefined ? {} : { [opts.key]: value };
    const got = opts.read(env);
    const cond = got === want;
    if (!cond) ok = false;
    opts.assert(
      cond,
      `${opts.name} ${label} → ${String(got)} (want ${String(want)})`,
    );
  }
  return { ok };
}

export const CONTAIN_KEY = "PI_ENSEMBLE_LEAN_PREFLIGHT_PROBE_CONTAIN";

export const READERS = {
  [CONTAIN_KEY]: leanPreflightProbeContainEnabled,
} as const;
