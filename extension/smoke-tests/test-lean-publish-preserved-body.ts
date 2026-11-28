#!/usr/bin/env bun
/**
 * #2668: the PR body names the criteria the run PRESERVED, through the real publish step.
 *
 * `publishBody` has taken a `preserved` option since the field landed, but the production caller never
 * supplied it, so a published PR never named a preserved criterion while the docs said it does. These
 * cases drive the REAL `publish` step over a real repo with a fake forge (lib/lean-publish-fixture.ts)
 * and read the body the step actually sent, so the assertion is about the wiring and not the renderer.
 *
 *   (1) a run whose newest decided specify preserved a criterion publishes a body naming it, with its
 *       frozen file, in a clause of its own;
 *   (2) a run that preserved nothing publishes the base body byte for byte;
 *   (3) with `PI_ENSEMBLE_LEAN_SPECIFY_PRESERVES=0` the body is the base body, preserved key or not;
 *   (4) an older specify's list does not stand when a newer decided specify has none.
 */

import type { Step } from "../src/lean/state.ts";
import { withEnv } from "./lib/env-scope.ts";
import { ROOTS, runPublish } from "./lib/lean-publish-fixture.ts";
import { sha } from "./lib/lean-verify-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const PRESERVED_TEST = "tests/AC4-guard.test.sh";
/** One of the files the publish fixture's own specify step froze. */
const OFF_TEST = "tests/AC2-bound.test.sh";

/**
 * The body without its preserved clause and without the shas each fixture repo mints for itself.
 *
/**
 * The body as a shape a second run can be compared with: its issue number, the shas each fixture repo
 * mints for itself, the preserved clause and the blank line that sets it off, all removed.
 *
 * A byte comparison across two `runPublish` calls cannot carry the issue number or the shas: every call
 * builds a fresh repo and the body prints `Closes #<n>`, `head:` and `base`. What a preserved record may
 * change at all is the clause and the blank line before it, so those go and every other line must be
 * identical.
 */
function stripped(body: string, issue: number): string {
  return body
    .split("\n")
    .map((l) => (l === `Closes #${String(issue)}` ? "Closes #<n>" : l))
    .filter((l) => l !== "" && !l.startsWith("- preserved:"))
    .filter((l) => !l.startsWith("- head: `") && !l.startsWith("- base `"))
    .join("\n");
}

/** A second `specify` record on the log, carrying (or not) a preserved list. */
function specifyStep(issue: number, preserved: string[] | undefined): Step {
  return {
    key: `${issue}:specify:1`,
    state: "specify",
    startedAt: 7,
    outcome: {
      kind: "ok",
      frozen: { [PRESERVED_TEST]: sha("#!/bin/sh\nexit 0\n") },
      tests: { AC4: [PRESERVED_TEST] },
      ...(preserved === undefined ? {} : { preserved }),
      reason: "froze 5 red test file(s) for 5 criterion/criteria",
    },
  } as unknown as Step;
}

/** The base body: the same run with no preserved list anywhere on its log. */
async function baseBody(issue: number, knob?: string): Promise<string> {
  let body = "";
  const run = async () => {
    body = (await runPublish({ issue, verify: { kind: "green" }, noPush: true })).body;
  };
  if (knob === undefined) await run();
  else await withEnv({ PI_ENSEMBLE_LEAN_SPECIFY_PRESERVES: knob }, run);
  return body;
}

// (1) + (2) + (3): the clause appears only for a run that preserved, and never otherwise.
{
  const base = await baseBody(501);
  assert(
    !base.includes("- preserved:"),
    `(2) a run that preserved nothing has no preserved line (${base
      .split("\n")
      .filter((l) => l.includes("preserv"))
      .join(" | ") || "none"})`,
  );

  const preserved = await runPublish({
    issue: 502,
    verify: { kind: "green" },
    noPush: true,
    extraSteps: [specifyStep(502, ["AC4"])],
  });
  assert(preserved.threw === undefined, `(1) the step ran (${preserved.threw?.message})`);
  assert(
    preserved.body.includes(
      `- preserved: preserved 1: AC4 (${PRESERVED_TEST}); each is frozen and must pass at head`,
    ),
    `(1) the published body names the preserved criterion and its file (${preserved.body
      .split("\n")
      .filter((l) => l.includes("preserv"))
      .join(" | ") || "NO PRESERVED LINE"})`,
  );
  assert(
    preserved.body.split("\n").filter((l) => l.startsWith("- preserved:")).length === 1,
    "(1) the clause is one line of its own",
  );
  // The clause must not sit flush against the bullet above it: markdown then reads the run's bullet
  // list as two lists, and the clause stops being part of the section it is in.
  assert(
    preserved.body.includes("adversary = model-b\n\n- preserved: preserved 1:"),
    "(1) a blank line separates the clause from the run's bullet list",
  );

  const off = await runPublish({
    issue: 503,
    verify: { kind: "green" },
    noPush: true,
    // The preserved file is a file the preserving specify froze, so the clause can name it: the fixture's
    // own specify records `tests/AC1-retry.test.sh` and `tests/AC2-bound.test.sh`.
    preserved: ["AC2"],
  });
  let offBody = "";
  await withEnv({ PI_ENSEMBLE_LEAN_SPECIFY_PRESERVES: "0" }, async () => {
    offBody = (
      await runPublish({
        issue: 504,
        verify: { kind: "green" },
        noPush: true,
        preserved: ["AC2"],
      })
    ).body;
  });
  assert(
    !offBody.includes("- preserved:"),
    `(3) with the switch off the body has no preserved line even when the record carries one (${offBody
      .split("\n")
      .filter((l) => l.includes("preserv"))
      .join(" | ") || "none"})`,
  );
  assert(
    off.body.includes(
      `- preserved: preserved 1: AC2 (${OFF_TEST}); each is frozen and must pass at head`,
    ),
    `(1) the clause reads its files from the preserving specify's own record (${off.body
      .split("\n")
      .filter((l) => l.includes("preserv"))
      .join(" | ") || "NO PRESERVED LINE"})`,
  );
  // The off arm must be the bytes a run that preserved nothing publishes. `base` is exactly that run
  // (its log has no `preserved` key), and the two bodies are compared with the two lines each fixture
  // repo mints for itself dropped — `head:` and `base` carry per-repo shas no run can reproduce.
  assert(
    stripped(offBody, 504) === stripped(base, 501),
    "(3) the off-arm body with a preserved record on the log is the body a run that preserved nothing publishes, byte for byte",
  );
  assert(
    stripped(off.body, 503) === stripped(base, 501),
    "(3) only the switch separates the two bodies: same log shape, the on arm adds the clause and nothing else",
  );
}

// (4) The newest decided specify decides the line, exactly as it decides the tests column.
{
  const stale = await runPublish({
    issue: 505,
    verify: { kind: "green" },
    noPush: true,
    extraSteps: [specifyStep(505, ["AC4"]), specifyStep(505, undefined)],
  });
  assert(
    !stale.body.includes("- preserved:"),
    `(4) a newer specify with no preserved list retires the older one's line (${stale.body
      .split("\n")
      .filter((l) => l.includes("preserv"))
      .join(" | ") || "none"})`,
  );
}

for (const dir of ROOTS) {
  try {
    (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
process.exit(exit);
