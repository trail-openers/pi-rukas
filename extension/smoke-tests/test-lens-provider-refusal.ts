#!/usr/bin/env bun
/**
 * #2261 — WHICH provider failure may end a lens lane, and which may not.
 *
 * The retry loop has a never-retried class, and #2261 added a member to it: a
 * provider that refused THIS prompt for its size. Re-spawning it is four
 * guaranteed failures and four bound-expenditures (measured on the reported
 * branch: 12 children, ~15 minutes, ~4 M input tokens) for one refusal — and the
 * operator read only `exit 1`, so the review looked like flaky infrastructure.
 *
 * The adversarial round-1 finding this file exists to keep fixed runs the other
 * way: the break must never be decided by the child's PROSE. The lens prompt
 * orders the reviewer to quote the diff, so `text` can carry diff-authored bytes —
 * a line of a reviewed file reading `"400 status code"` would otherwise cost a
 * transient lane three of its four attempts and blame the prompt size. And a 400
 * whose body says the metered plan is exhausted is a RATE refusal, which the retry
 * loop exists to ride out. So what ends a lane is the provider's own structured
 * refusal (`errorStop`) saying the PROMPT was too large — not the status code
 * alone, and not the model's words about it.
 *
 * Every case drives the REAL `runLensChild` with only the spawn recorder in place,
 * and reads the SPAWN COUNT as the evidence: 1 means never retried, 4 means the
 * full budget was spent.
 */

import { exec } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { installLensSkills, setStubSpawnAnswer, stubLensSpawn } from "./lib/lens-stub-spawn.ts";
import { isolateLedger } from "./lib/review-ledger-test-helpers.ts";

const spawnCalls = stubLensSpawn();

// Imported AFTER the mock, so the lens chain binds to the recorder.
const { runLensChild } = await import("../src/lens-review-child.ts");
const { LENS_ROSTER } = await import("../src/lens-roster.ts");
type RosterEntryName = (typeof LENS_ROSTER)[number];
const { incompleteLanes } = await import("../src/lens-review-incomplete.ts");
const { providerContextProblem } = await import("../src/lens-provider-cause.ts");

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const execp = promisify(exec);

/** A one-commit scratch repo: `runLensChild` wants a real cwd to spawn in. */
async function mkRepo(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const run = (cmd: string) => execp(cmd, { cwd: dir });
  await run("git init -q -b main");
  await run("git config user.email t@t");
  await run("git config user.name T");
  writeFileSync(path.join(dir, "base.txt"), "hello\n");
  await run("git add -A");
  await run("git commit -q -m base");
}

/** What the recorder answers while a case is not driving it. */
const OK = (): Record<string, unknown> => ({
  ok: true,
  text: "Checked the inlined diff; nothing in my lane.",
  toolUses: [],
  ms: 10,
  exitCode: 0,
});

/** A failed child, with or without the provider's structured refusal. */
function failed(text: string, errorStop?: { reason: string; message: string }): Record<string, unknown> {
  return {
    ok: false,
    text,
    toolUses: [],
    ms: 600,
    exitCode: 1,
    ...(errorStop ? { errorStop } : {}),
  };
}

const root = mkdtempSync(path.join(os.tmpdir(), "lens-provider-"));
const skills = path.join(root, "skills");
installLensSkills(skills);
const releaseLedger = isolateLedger();
const savedSkills = process.env.PI_ENSEMBLE_SKILLS_DIR;

let providerAnswer: () => Record<string, unknown> = OK;
setStubSpawnAnswer((spec) => ({ role: spec.role, ...providerAnswer() }));

try {
  process.env.PI_ENSEMBLE_SKILLS_DIR = skills;
  const dir = path.join(root, "repo");
  await mkRepo(dir);
  const lens = LENS_ROSTER[0] as RosterEntryName;

  /** One lens child under `shape`; the answer is how many times it spawned. */
  async function spawnsFor(shape: () => Record<string, unknown>): Promise<number> {
    spawnCalls.length = 0;
    providerAnswer = shape;
    await runLensChild({
      lens,
      runId: "run-2261-provider",
      skillsDir: skills,
      context: "ctx",
      roster: [],
      opts: { diff: "diff --git a/a b/a\n+x", cwd: dir },
      bumpBatch: () => {},
    } as never);
    providerAnswer = OK;
    return spawnCalls.filter((c) => c.role === "code-review-specialist").length;
  }

  // ── (1) THE REFUSAL ITSELF: named, and not retried.
  {
    spawnCalls.length = 0;
    providerAnswer = () =>
      failed("", {
        reason: "error",
        message:
          '400 status code (no body): {"error":{"message":"This model\'s maximum context length is 8192 tokens"}}',
      });
    const result = await runLensChild({
      lens,
      runId: "run-2261",
      skillsDir: skills,
      context: "ctx",
      roster: [],
      opts: { diff: "diff --git a/a b/a\n+x", cwd: dir },
      bumpBatch: () => {},
    } as never);
    providerAnswer = OK;
    const spawns = spawnCalls.filter((c) => c.role === "code-review-specialist").length;
    assert(
      result.blocked === true,
      `(1) the context-length lens is blocked (got blocked=${String(result.blocked)})`,
    );
    assert(
      providerContextProblem(result.parseError ?? "") !== undefined,
      `(1) its row names the provider context-length refusal rather than a bare exit code (got: ${String(result.parseError)})`,
    );
    assert(
      spawns === 1,
      `(1) a context-length refusal is NOT retried — one spawn, not four (got ${String(spawns)})`,
    );
    const lanes = incompleteLanes([result]);
    assert(
      lanes.some((l) => providerContextProblem(l) !== undefined),
      `(1) the lane reason names it too (got: ${JSON.stringify(lanes)})`,
    );
  }

  // ── (2) WHAT MUST NOT END A LANE (adversarial round 1, finding 1).
  // Each shape below must spend the FULL retry budget: one attempt would mean a
  // transient lane was charged a provider refusal it never received.

  // (2a) Diff-authored bytes: the model quoted a line of the diff that happens to
  // read like a 400. There is no `errorStop` — nothing refused the request.
  const authored = await spawnsFor(() =>
    failed(
      'const msg = "400 status code (no body): transient upstream proxy hiccup";\n' +
        "Nothing in my lane.",
    ),
  );
  assert(
    authored > 1,
    `(2a) a 400 that appears only in the child's PROSE (diff text the reviewer quoted) does not break the retry loop (got ${String(authored)} spawn${authored === 1 ? ", not retried" : ", retried"})`,
  );

  // (2b) A real 400 that says nothing about size — a metered-plan / rate refusal.
  // The wording avoids the size vocabulary deliberately: "input tokens" and "too
  // many tokens" ARE size refusals, so this says what a rate refusal says.
  const rateLimited = await spawnsFor(() =>
    failed("", {
      reason: "error",
      message:
        '400 status code (no body): {"error":{"message":"Metered plan quota exhausted, retry in 60s"}}',
    }),
  );
  assert(
    rateLimited > 1,
    `(2b) a transient provider 400 that says nothing about context length keeps its retries (got ${String(rateLimited)} spawn${rateLimited === 1 ? ", not retried" : ", retried"})`,
  );

  // (2c) Context vocabulary in the child's PROSE, with no structured refusal: the
  // model talked about context, the provider never refused anything.
  const notARefusal = await spawnsFor(() =>
    failed("maximum context length was never reached here"),
  );
  assert(
    notARefusal > 1,
    `(2c) context vocabulary in prose alone is not a refusal (${String(notARefusal)} spawns)`,
  );

  // (2d) A size refusal that arrives WITHOUT the status line is still terminal: a
  // provider that says "maximum context length" in its own error is not saying
  // anything else, and re-spawning that prompt is four guaranteed failures.
  const bareSizeRefusal = await spawnsFor(() =>
    failed("", {
      reason: "error",
      message: "This model's maximum context length is 8192 tokens; your prompt is longer.",
    }),
  );
  assert(
    bareSizeRefusal === 1,
    `(2d) a context-length refusal with no 400 on the line is still not retried (got ${String(bareSizeRefusal)} spawns)`,
  );

  // (2e) The converse of (2a): a 400 the provider raised for a bad request that has
  // nothing to do with size, arriving in the structured channel, still keeps its
  // retries — it is the size vocabulary that makes a refusal terminal, not the
  // status code.
  const otherRefusal = await spawnsFor(() =>
    failed("", { reason: "error", message: "400 Bad Request: unsupported image modality" }),
  );
  assert(
    otherRefusal > 1,
    `(2e) a 400 refusal that says nothing about size keeps its retries (got ${String(otherRefusal)} spawns)`,
  );
} finally {
  if (savedSkills === undefined) delete process.env.PI_ENSEMBLE_SKILLS_DIR;
  else process.env.PI_ENSEMBLE_SKILLS_DIR = savedSkills;
  releaseLedger();
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
