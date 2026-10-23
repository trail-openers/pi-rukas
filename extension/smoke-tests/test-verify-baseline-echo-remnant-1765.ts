#!/usr/bin/env bun
/**
 * #1765 lens round 3 — the two rules a base-health claim is judged by, split
 * out of `test-verify-baseline-attribution.ts` for the AGENTS.md §12 500-line
 * cap (that file grew past it when the round's cases landed).
 *
 * 18 — the WRAPPER-RESIDUAL whitelist. The old rule was a punctuation class, so
 * a child that printed `----` (a table rule, a separator a script emits) as its
 * ONLY line under the executor's echo read as "nothing but the harness" and the
 * probe called the base GREEN. Only the literal residuals the executor really
 * produces may be excused, and the exact wrapper spelling still must be, or
 * every shell-wrapped gate reads as a red base.
 *
 * 19 — a `timedOut` that is PRESENT but not exactly `true` makes the record
 * UNUSABLE rather than being coerced or quietly dropped. A record whose arm
 * cannot be read must re-probe: trusting it would let the develop gate name a
 * test (plain red) or a bound (killed) from a field it could not parse.
 *
 * Offline: temp git repos, no dispatch, no spawn.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type HostBudget, __setHostBudget } from "../src/host-resources.ts";
import { applyBaseHealthProbe } from "../src/work-driver-verify-base-health.ts";
import { isWrapperRemnant } from "../src/work-driver-verify-echo.ts";
import { matchingVerdict } from "../src/workflow-state-schema-base-health.ts";
import { CMD, GREEN_GATE, branchState } from "./lib/base-health-probe-fixture.ts";
import { realExec } from "./lib/restore-start-ref-fixtures.ts";
import { redGateFixture } from "./lib/verify-baseline-probe-harness.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

__setHostBudget({ verifyConcurrency: 0 } as HostBudget);

// The positives are the residuals `stripCmdEcho` actually leaves behind for the
// invocations `execp` can be handed — verified against the real executor: a
// double-quoted inner command is stripped whole (residual empty, so it needs no
// whitelist entry), a single-quoted one strands the bare wrapper (`sh -c`), and
// the JSON-echoed nested form `/bin/sh -c "sh -c \"sh gate.sh\""` strips its
// escaped inner whole and leaves the OUTER wrapper bare. A whole-run quoted
// wrapper like `'sh -c'` or `"bash -c"` is NOT something stripping ever produces
// (the wrapper and its quotes go together with the command), so it is in the
// negative list: the whitelist is what stripping makes, not what looks like a
// wrapper.
for (const notRemnant of [
  "----",
  "--",
  "-c",
  "c",
  "sh",
  "bash",
  "/bin/sh",
  "FAILED",
  "'sh -c'",
  '"bash -c"',
  'sh -c ""',
  '"sh -c \\"\\""',
  'sh -c "',
] as const) {
  assert(
    isWrapperRemnant(notRemnant) === false,
    `wrapper remnant: ${JSON.stringify(notRemnant)} is NOT harness punctuation`,
  );
}
for (const remnant of [
  "sh -c",
  "bash -c",
  "/bin/sh -c",
  "/bin/bash -c",
  "  sh -c  ",
  "  /bin/bash -c  ",
] as const) {
  assert(
    isWrapperRemnant(remnant) === true,
    `wrapper remnant: the executor's own ${JSON.stringify(remnant)} IS a remnant`,
  );
}

// The escaped-echo case the previous round broke, end to end: the executor's own
// rejection for a doubly-wrapped invocation must read as the harness alone (the
// base is `unknown`, not red) while the same echo over a line the gate printed
// stays a red base. The wrapper here is the nested spelling: outer
// `/bin/sh -c "…"` with the shell's escaped inner quotes.
{
  const escRoot = mkdtempSync(path.join(tmpdir(), "pi-base-esc-"));
  const escFixtures = [
    {
      name: "nested escaped echo alone",
      stdout: `Command failed: /bin/sh -c "sh -c \\"${CMD}\\""`,
      want: "unknown",
    },
    {
      name: "nested escaped echo plus a real failure",
      stdout: `Command failed: /bin/sh -c "sh -c \\"${CMD}\\""\n✗ tests/test-red.ts: expected 1, got 2`,
      want: "red",
    },
    {
      name: "separator line under the echo is gate output",
      stdout: `Command failed: ${CMD}\n----`,
      want: "red",
    },
  ] as const;
  for (const c of escFixtures) {
    const f = await redGateFixture(escRoot, `esc-${c.name}`, GREEN_GATE, { "notes.md": "x\n" });
    const out = await applyBaseHealthProbe(
      async (command, o) => {
        const line = o?.argv ? [command, ...o.argv].join(" ") : command;
        if (!line.startsWith("git ") && existsSync(`${o?.cwd ?? ""}/gate.sh`)) {
          throw Object.assign(new Error(c.stdout.split("\n")[0] ?? ""), {
            stdout: c.stdout,
            stderr: "",
            code: 1,
          });
        }
        return await realExec(command, o);
      },
      { host: {}, repoRoot: f.repo, issue: 1765 } as never,
      branchState(f.baseSha),
      CMD,
    );
    assert(
      out.verdict?.status === c.want,
      `escaped echo (${c.name}): ${c.want} (got ${out.verdict?.status} — ${out.verdict?.reason ?? "no reason"})`,
    );
    assert(
      c.want === "red" ? out.park !== undefined : out.park === undefined,
      `escaped echo (${c.name}): ${c.want === "red" ? "the gate's own line still parks" : "the harness alone never parks"}`,
    );
  }
  rmSync(escRoot, { recursive: true, force: true });
}

// ── 19 — a `timedOut` that is present but not exactly true makes the record
// UNUSABLE rather than being coerced or dropped.
{
  const key = { baseSha: "b".repeat(40), command: CMD, tierBoundMs: 60000 };
  const base = { status: "red", ...key };
  for (const bad of ["true", 1, 0, "", null, {}, []] as const) {
    assert(
      matchingVerdict({ ...base, timedOut: bad }, key) === undefined,
      `usableVerdict: timedOut=${JSON.stringify(bad)} is not a verdict — the record re-probes`,
    );
  }
  assert(
    matchingVerdict({ ...base, timedOut: true }, key)?.timedOut === true,
    "usableVerdict: the one admissible timedOut is true, and it survives",
  );
  assert(
    matchingVerdict(base, key)?.status === "red" &&
      !("timedOut" in (matchingVerdict(base, key) ?? {})),
    "usableVerdict: an ABSENT timedOut is still the plain red (re-probing those would tax every green)",
  );
  // The green arm obeys the same rule: a green whose record cannot be read is no
  // green, and a green is the one verdict that spares a later cycle its suite run.
  assert(
    matchingVerdict({ ...base, status: "green", timedOut: "yes" }, key) === undefined,
    "usableVerdict: a green with a malformed timedOut is not trusted either",
  );
}

process.exit(exit);
