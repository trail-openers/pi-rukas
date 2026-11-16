#!/usr/bin/env bun
/**
 * #2284 — with `PI_ENSEMBLE_FORGE_READ_OFF_GUARD=0`, a `none` read is the read the
 * pre-fix broker served.
 *
 * The escape hatch is only honest if its off arm is the OLD behaviour, not merely a
 * behaviour that happens to pass. So this compares the reply fields and the
 * RECORDED COMMAND LIST of one proved `issue_view` under `PI_ENSEMBLE_FORGE=none`
 * against a committed pre-fix call log
 * (`fixtures/forge-read/off-arm-prefix-calls.json`) captured from the broker at
 * 2c06e69f7a — the commit that shipped the broker with no `PI_ENSEMBLE_FORGE` read
 * in it — driven through the same harness this file uses.
 *
 * What is compared, and what is not:
 *
 *   - `type`/`ok`/`output`/`reason` exactly, and the recorder's `calls` and `opts`
 *     arrays exactly — the command strings AND the exec options each was issued
 *     with, since a read that reached the same verdict through different commands
 *     is not the same behaviour;
 *   - NOT the reply's `mac`/`nonce`/`echo`: those carry fresh random nonces per
 *     call, so the fixture omits them and the harness strips them.
 *
 * The control is the on arm of the same request in the same process: the guard ON
 * must refuse and record nothing, which is what makes the record above a property
 * of the switch rather than of the fixture.
 *
 * Red-first note: this file's OFF arm is the arm a pre-fix tree reproduces, so the
 * assertion that fails against an unpatched broker is the broker's missing `execFn`
 * option (the harness cannot even hand it a recorder), and the assertion that fails
 * against a broker whose off arm drifted is the record comparison.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { forgeReadOffGuardEnabled } from "../src/forge-read-off-switch.ts";
import { OFF_ARM_REQUEST, driveProvedRead, offArmExec } from "./lib/forge-read-off-arm.ts";
import { withEnv } from "./lib/env-scope.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

const FIXTURE = path.resolve(
  import.meta.dirname,
  "fixtures",
  "forge-read",
  "off-arm-prefix-calls.json",
);

interface PrefixRecord {
  request: { verb: string; number: number };
  reply: { type?: unknown; ok?: unknown; output?: unknown; reason?: unknown };
  calls: string[];
  opts: Array<Record<string, unknown> | undefined>;
}

/** Read once; its absence is a failure, never a skip. */
function record(): { want?: PrefixRecord; problem?: string } {
  try {
    return { want: JSON.parse(readFileSync(FIXTURE, "utf8")) as PrefixRecord };
  } catch (err) {
    return { problem: (err as Error).message };
  }
}

const { want, problem } = record();
assert(
  want !== undefined,
  `(fixture) the pre-fix call log is present at ${FIXTURE} (${problem ?? "read"})`,
);

// ── the off arm: guard=0 + forge=none is the pre-fix broker
{
  const exec = offArmExec();
  let run: Awaited<ReturnType<typeof driveProvedRead>> | undefined;
  let threw: Error | undefined;
  await withEnv(
    { PI_ENSEMBLE_FORGE: "none", PI_ENSEMBLE_FORGE_READ_OFF_GUARD: "0" },
    async () => {
      try {
        run = await driveProvedRead({ execFn: exec.fn }, OFF_ARM_REQUEST);
      } catch (err) {
        threw = err as Error;
      }
    },
  );
  assert(
    threw === undefined,
    `(off) the broker accepted the harness's recorder and served the read (${
      threw?.message ?? "clean"
    })`,
  );
  assert(
    forgeReadOffGuardEnabled() === false,
    "(off) and this arm ran with the guard off",
  );
  if (run !== undefined && want !== undefined) {
    assert(
      JSON.stringify(run.fields) === JSON.stringify(want.reply),
      `(off) the reply fields are the pre-fix reply, field by field\n    captured: ${JSON.stringify(
        want.reply,
      )}\n    run:     ${JSON.stringify(run.fields)}`,
    );
    assert(
      run.fields.ok === true && run.fields.reason === undefined,
      `(off) which is a SERVED read, not a refusal (${JSON.stringify(run.fields)})`,
    );
    assert(
      JSON.stringify(run.calls) === JSON.stringify(want.calls),
      `(off) the recorded command list is the pre-fix list, in order\n    captured: ${JSON.stringify(
        want.calls,
      )}\n    run:     ${JSON.stringify(run.calls)}`,
    );
    assert(
      JSON.stringify(run.opts) === JSON.stringify(want.opts),
      `(off) and each command was issued with the pre-fix exec options\n    captured: ${JSON.stringify(
        want.opts,
      )}\n    run:     ${JSON.stringify(run.opts)}`,
    );
    // Non-vacuity: an empty captured list would make the two comparisons above
    // pass on a broker that ran nothing at all.
    assert(
      want.calls.length >= 2 &&
        want.calls.some((c) => c.startsWith("gh ")) &&
        want.calls.some((c) => c.startsWith("git config --get remote.")),
      "(off) and the record is a real pre-fix trace: a remote read AND a gh call",
    );
  }
}

// ── the control: the same request with the guard unset refuses and records nothing
{
  const exec = offArmExec();
  let run: Awaited<ReturnType<typeof driveProvedRead>> | undefined;
  await withEnv(
    { PI_ENSEMBLE_FORGE: "none", PI_ENSEMBLE_FORGE_READ_OFF_GUARD: undefined },
    async () => {
      run = await driveProvedRead({ execFn: exec.fn }, OFF_ARM_REQUEST);
    },
  );
  assert(
    run?.fields.ok === false &&
      run.fields.reason === "the forge is off: PI_ENSEMBLE_FORGE=none",
    `(on) the same request with the guard unset is refused by name (${JSON.stringify(run?.fields)})`,
  );
  assert(
    run !== undefined && run.calls.length === 0,
    `(on) and the parent issued nothing (${JSON.stringify(run?.calls)})`,
  );
  assert(
    JSON.stringify(run?.fields) !== JSON.stringify(want?.reply ?? {}),
    "(on) so the pre-fix record above is a property of the switch, not of this fixture",
  );
}

console.log(
  `\n${failures() === 0 ? "off arm green" : "off arm RED"} (${String(failures())} failing)`,
);
process.exit(failures());
