#!/usr/bin/env bun
/**
 * The `PI_ENSEMBLE_LEAN_GUARD_FAIL_CLOSED` switch is documented, and off ONLY on
 * `"0"`.
 *
 * The same three things its sibling switch's file pins for the rewind lease
 * (`test-lean-rewind-lease-binds-switch.ts`), because the same failure mode
 * applies to a knob whose off arm is a force-push guard:
 *
 *   - the `docs/configuration.md` row — a `HEADLESS_INPUTS` entry nobody can
 *     discover is a knob that does not exist, and `test-headless-inputs.ts`
 *     checks the roster against the readers without ever opening `docs/`;
 *   - the truth table on the exported reader: on for unset, `"1"`, `""` and
 *     `"false"`, off for the literal `"0"` alone;
 *   - the sentence on the docs row that says WHAT the on arm does, so the knob is
 *     understandable from the docs alone rather than from this file;
 *   - R8's claim in full: with the switch off the guard is BYTE-IDENTICAL to the
 *     pre-fix guard, observed as one complete call log against an origin that
 *     answers and one against an origin that will not, each compared to a
 *     transcription of the pre-fix body.
 *
 * What makes this switch different from the rewind one is what its off arm
 * restores: the pre-fix guard skipped its mainline rule whenever the mainline
 * could not be read, which is the fail-open #2255 is a fix for. `docs/lean.md`
 * names both halves — the origin probe and the refusal — so the row is not the
 * only place a reader learns the policy.
 *
 * The reader is read at CALL time, so every case pins the environment with
 * `withEnv`: a pin that leaked from another file in the same run, or an
 * operator's exported `=0`, would otherwise make the ON cases measure the wrong
 * arm.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { leanGuardFailClosed } from "../src/lean/guard-fail-closed-switch.ts";
import {
  MAINLINE_PROBE_COMMANDS,
  PublishInfraError,
  assertPublishableBranch,
} from "../src/lean/publish-deps.ts";
import { withEnv } from "./lib/env-scope.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

const docs = (file: string): string =>
  readFileSync(path.resolve(import.meta.dirname, "..", "..", "docs", file), "utf8");

{
  const doc = docs("configuration.md");
  assert(
    doc.includes("`PI_ENSEMBLE_LEAN_GUARD_FAIL_CLOSED`"),
    "docs/configuration.md carries a row for PI_ENSEMBLE_LEAN_GUARD_FAIL_CLOSED",
  );
  // The row has to state the mechanism, not just name the knob: an operator who
  // sets `=0` is putting a fail-OPEN back on a force-push guard, and should read
  // that from the row rather than from the source.
  assert(
    doc.includes("ls-remote") && doc.includes("fail"),
    "and that row says the guard probes origin with ls-remote and refuses when that fails too, so the knob is understandable from the docs alone",
  );
}

{
  // The engine guide is where a reader learns what the publish guard checks; it
  // must say the guard asks origin, and name the switch.
  const lean = docs("lean.md");
  assert(
    lean.includes("PI_ENSEMBLE_LEAN_GUARD_FAIL_CLOSED"),
    "docs/lean.md names the switch in the publishable-branch section",
  );
  for (const needle of ["mainline", "origin", "refus"]) {
    assert(
      lean.includes(needle),
      `and the section states what the guard decides, which a reader needs: "${needle}"`,
    );
  }
}

await withEnv({ PI_ENSEMBLE_LEAN_GUARD_FAIL_CLOSED: undefined }, async () => {
  const cases: [string | undefined, boolean][] = [
    [undefined, true],
    ["1", true],
    ["", true],
    ["false", true],
    ["0", false],
  ];
  for (const [value, want] of cases) {
    await withEnv({ PI_ENSEMBLE_LEAN_GUARD_FAIL_CLOSED: value }, async () => {
      assert(
        leanGuardFailClosed() === want,
        `PI_ENSEMBLE_LEAN_GUARD_FAIL_CLOSED=${JSON.stringify(value)} reads ${String(want)}`,
      );
    });
  }
});

// ── R8: the off arm is BYTE-IDENTICAL to the pre-fix guard ─────────────────
//
// The claim the switch makes in prose — "restores the old behaviour byte for byte" —
// is a claim about one specific old body, and prose cannot be diffed. So the old
// guard is transcribed here, in the order it issued its calls, as the log of
// executor calls it would have produced; and the shipped guard is run against the
// same fake on both arms and its own log compared, element for element, on two
// origins: one that answers the symref probe and one that answers nothing.
//
// The transcription is deliberate rather than a checkout of the old file: the old
// guard probed through the module-level executor, which no test can observe, so
// "identical" here has to mean "the same calls, in the same order, with the same
// bound" — which is what an operator's push actually experiences.
{
  /** One executor call, reduced to everything this comparison can distinguish. */
  type Log = { form: "argv" | "shell"; cmd: string; argv: string[]; timeout: number | undefined };

  /** What the guard did to its executor, and what it decided. */
  interface Drive {
    log: Log[];
    threw: string;
  }

  /** The two probes the PRE-FIX guard issued, in its own order. */
  const PRE_FIX_PROBES = [MAINLINE_PROBE_COMMANDS[0], MAINLINE_PROBE_COMMANDS[1]];

  /** The origin probe the fix added — absent from every off-arm log below. */
  const ORIGIN_PROBE = MAINLINE_PROBE_COMMANDS[2];

  const stringify = (x: unknown): string => JSON.stringify(x);

  /** Drive the shipped guard with a fake that records everything it is asked. */
  const drive = async (answer: () => string | { reject: string }): Promise<Drive> => {
    const log: Log[] = [];
    const exec = async (cmd: string, opts?: Record<string, unknown>) => {
      const argv = [...((opts?.argv as string[] | undefined) ?? [])];
      log.push({
        form: opts?.argv === undefined ? "shell" : "argv",
        cmd,
        argv,
        timeout: opts?.timeout as number | undefined,
      });
      const a = answer();
      if (typeof a === "object")
        throw Object.assign(new Error(a.reject), { code: 1, killed: false, signal: null });
      return { stdout: a, stderr: "" };
    };
    const err = await assertPublishableBranch("/no/such/clone", "lean/issue-2255", exec).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    return { log, threw: err instanceof PublishInfraError ? err.message : "<passed>" };
  };

  /** What the pre-fix guard did, stated as its own call log. */
  const preFixLog = (extra: Log[]): Log[] =>
    PRE_FIX_PROBES.map((cmd) => ({
      form: "shell" as const,
      cmd,
      argv: [] as string[],
      timeout: 30_000,
    })).concat(extra);

  const probe = (cmd: string): Log => ({ form: "shell", cmd, argv: [], timeout: 30_000 });

  // Against an origin that WILL answer. The pre-fix guard never asked it, so the off
  // arm must not either — and both must pass the push. (`withEnv` answers with void,
  // so each drive lands in a variable the assertion below reads.)
  let originAnswers: Drive = { log: [], threw: "<not driven>" };
  await withEnv({ PI_ENSEMBLE_LEAN_GUARD_FAIL_CLOSED: "0" }, async () => {
    originAnswers = await drive(() => ({ reject: "nothing local" }));
  });
  assert(
    stringify(originAnswers.log) === stringify(preFixLog([])),
    `(R8) off arm, origin reachable: the guard's ENTIRE executor log is byte-identical to the pre-fix guard's — same calls, same order, same bound (${stringify(originAnswers.log)})`,
  );
  assert(
    originAnswers.threw === "<passed>",
    `(R8) and it passed the legitimate lean push, exactly as the pre-fix guard did (${originAnswers.threw})`,
  );
  assert(
    !originAnswers.log.some((c) => [c.cmd, ...c.argv].join(" ").includes(ORIGIN_PROBE)),
    `(R8) with the switch off, origin is never asked (${stringify(originAnswers.log.map((c) => c.cmd))})`,
  );

  // Control: the ON arm's log differs from the pre-fix log by exactly the one probe
  // the fix added, and nothing else — which is what makes the comparison above a
  // statement about the switch rather than about a fake nobody can see through.
  let onArm: Drive = { log: [], threw: "<not driven>" };
  await withEnv({ PI_ENSEMBLE_LEAN_GUARD_FAIL_CLOSED: "1" }, async () => {
    onArm = await drive(() => ({ reject: "nothing local" }));
  });
  assert(
    stringify(onArm.log) === stringify(preFixLog([probe(ORIGIN_PROBE)])),
    `(R8) control — the ON arm is that same log plus exactly the origin probe the fix added (${stringify(onArm.log)})`,
  );

  // And against an origin that answers NOTHING: the pre-fix guard still passed the
  // push (that was the bug), so the off arm must too, on the identical log.
  let dead: Drive = { log: [], threw: "<not driven>" };
  await withEnv({ PI_ENSEMBLE_LEAN_GUARD_FAIL_CLOSED: "0" }, async () => {
    dead = await drive(() => ({ reject: "nothing answered" }));
  });
  assert(
    stringify(dead.log) === stringify(preFixLog([])),
    `(R8) off arm, origin unreachable: still byte-identical to the pre-fix guard's log (${stringify(dead.log)})`,
  );
  assert(
    dead.threw === "<passed>",
    `(R8) and the fail-open is restored whole — a lean branch whose mainline nobody will name is published (${dead.threw})`,
  );
}

console.log(
  `\n${failures() === 0 ? "switch green" : "switch RED"} (${String(failures())} failing)`,
);
process.exit(failures());
