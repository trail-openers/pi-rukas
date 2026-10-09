#!/usr/bin/env bun
/**
 * #952 — the onSteer seam for lens children.
 *
 * Before #952, lens children had no onSteer, which made the driver's token
 * budget and loop-detector caps inert (createCapSession only builds a
 * TokenBudgetTracker when onSteer is present). This test proves:
 *
 *  1. The spawn options include onSteer.
 *  2. A steer reaches the fake stdin as the {type:"steer", message} RPC envelope.
 *  3. After stdin is "closed" (destroyed=true), the steer is a no-op (no throw).
 *
 * The mock follows the pattern in test-lens-skill-wiring.ts: mock.module
 * installed before the lens-review import, a module-level responder variable.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock } from "bun:test";
import { isolateLedger } from "./lib/review-ledger-test-helpers.ts";

// #1069 — isolate before any src import: the real runLensReview write must
// land in a temp file, not the main clone's .git (worktree common dir).
isolateLedger();

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
function eq(actual: unknown, expected: unknown, msg: string): boolean {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`✓ ${msg}`);
    return true;
  }
  console.error(`✗ ${msg}\n    actual:   ${a}\n    expected: ${e}`);
  exit = 1;
  return false;
}

/** Records lines written to it; can be marked "closed". */
class FakeStdin {
  lines: string[] = [];
  destroyed = false;
  writable = true;
  writableEnded = false;
  write(data: string, cb?: () => void) {
    if (this.destroyed) {
      cb?.();
      return true;
    }
    this.lines.push(data);
    cb?.();
    return true;
  }
}

type Responder = (
  spec: { prompt: string },
  opts: {
    onStdin?: (stdin: unknown) => void;
    onSteer?: (message: string, source?: string) => void;
  },
) => unknown;

let spawnResponder: Responder = () => ({
  role: "code-review-specialist",
  ok: true,
  text: "Checked the diff; clean.",
  toolUses: [],
  ms: 10,
  exitCode: 0,
});

// The mock records every spawn call. For the steer-reaches-stdin case,
// `lastFakeStdin` is set so the test can inspect what was written.
const spawnCalls: Array<{
  prompt: string;
  hasOnStdin: boolean;
  hasOnSteer: boolean;
  onSteer?: (message: string, source?: string) => void;
  fakeStdin?: FakeStdin;
}> = [];

mock.module(new URL("../src/spawn.ts", import.meta.url).href, () => ({
  makeRunId: () => "run-952",
  spawnSpecialist: async (
    spec: { prompt: string },
    opts?: {
      onStdin?: (stdin: unknown) => void;
      onSteer?: (message: string, source?: string) => void;
    },
  ) => {
    const fake = new FakeStdin();
    spawnCalls.push({
      prompt: spec.prompt,
      hasOnStdin: !!opts?.onStdin,
      hasOnSteer: !!opts?.onSteer,
      onSteer: opts?.onSteer,
      fakeStdin: fake,
    });
    if (opts?.onStdin) {
      opts.onStdin(fake as unknown as import("node:stream").Writable);
    }
    return spawnResponder(spec, opts ?? {});
  },
}));

// The lens modules must be imported AFTER the mock is installed.
const { runLensReview } = await import("../src/lens-review.ts");
const { LENS_ROSTER } = await import("../src/lens-roster.ts");

function fixtureSkillsDir(name: string): { dir: string; cleanup: () => void } {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), `lens952-${name}-`)), "skills");
  mkdirSync(dir, { recursive: true });
  let prec = 10;
  for (const s of LENS_ROSTER) {
    const skillDir = path.join(dir, s.skill);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      path.join(skillDir, "SKILL.md"),
      `---\nname: ${s.skill}\nprecedence: ${prec}\n---\n`,
    );
    prec += 10;
  }
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}

// --------------------------------------------------------------- the seam

{
  const { dir, cleanup } = fixtureSkillsDir("seam");
  const prior = process.env.PI_ENSEMBLE_SKILLS_DIR;
  process.env.PI_ENSEMBLE_SKILLS_DIR = dir;
  try {
    spawnCalls.length = 0;
    spawnResponder = () => ({
      role: "code-review-specialist",
      ok: true,
      text: "Clean from this lens's perspective.",
      toolUses: [],
      ms: 10,
      exitCode: 0,
    });
    const summary = await runLensReview({ diff: "diff --git a/a b/a" });
    eq(summary.lenses.length, LENS_ROSTER.length, "#952: all lenses ran");

    // 1. Every spawn call had onSteer.
    for (const call of spawnCalls) {
      assert(call.hasOnSteer, `#952: spawn call has onSteer (prompt: …${call.prompt.slice(-40)})`);
    }
    assert(
      spawnCalls.every((c) => c.hasOnStdin),
      "#952: every spawn call has onStdin",
    );

    // 2. A steer reaches the fake stdin as the RPC envelope.
    const anyCall = spawnCalls.find((c) => c.onSteer && c.fakeStdin);
    assert(!!anyCall, "#952: at least one onSteer with a fake stdin was captured");
    if (anyCall) {
      anyCall.onSteer!("budget warning: 7M/8M tokens", "driver-budget");
      const fake = anyCall.fakeStdin!;
      assert(
        fake.lines.length === 1,
        `#952: exactly one line written to stdin (got ${fake.lines.length})`,
      );
      if (fake.lines.length === 1) {
        const parsed = JSON.parse(fake.lines[0]);
        eq(parsed.type, "steer", "#952: RPC envelope type is 'steer'");
        eq(parsed.message, "budget warning: 7M/8M tokens", "#952: message matches");
      }

      // 3. After stdin closes, the steer is a no-op (no throw).
      fake.destroyed = true;
      let threw = false;
      try {
        anyCall.onSteer!("post-exit steer", "driver-budget");
      } catch {
        threw = true;
      }
      assert(!threw, "#952: steer after stdin close does not throw");
      eq(fake.lines.length, 1, "#952: no additional line written after close");
    }
  } finally {
    if (prior === undefined) delete process.env.PI_ENSEMBLE_SKILLS_DIR;
    else process.env.PI_ENSEMBLE_SKILLS_DIR = prior;
    cleanup();
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
