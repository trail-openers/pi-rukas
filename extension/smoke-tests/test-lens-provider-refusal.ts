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

  // (2d) A size refusal that arrives with NO status line at all is NOT terminal.
  // A bare sentence is exactly the shape the round-2 finding turns on: the same
  // words — "too many tokens" — arrive from a 429, and a provider that says
  // nothing about the status gives the loop no way to tell a refusal of the
  // prompt from a refusal of the minute. The discriminator the module documents
  // is the status, so a 400-bearing refusal is terminal (2h) and a status-less
  // one keeps its attempts.
  const statusless = await spawnsFor(() =>
    failed("", {
      reason: "error",
      message:
        '{"error":{"message":"This model\'s maximum context length is 8192 tokens; your prompt is longer."}}',
    }),
  );
  assert(
    statusless > 1,
    `(2d) a size refusal with no status line keeps its retries rather than trusting the wording alone (got ${String(statusless)} spawn${statusless === 1 ? ", not retried" : ", retried"})`,
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

  // (2f) …and the lane does not LIE about it. A rate refusal that keeps its retries
  // must not also be stamped with the context-length cause, which is the story the
  // operator acts on ("your prompt is too large" vs. "the endpoint was busy") — and
  // which also decides whether a half-written review is kept or discarded
  // (`failedLensRow` drops the evidence of a child it believes was refused).
  {
    spawnCalls.length = 0;
    providerAnswer = () =>
      failed("", {
        reason: "error",
        message: "429 Too Many Requests: too many tokens, retry in 30s",
      });
    const rateResult = await runLensChild({
      lens,
      runId: "run-2261-rate",
      skillsDir: skills,
      context: "ctx",
      roster: [],
      opts: { diff: "diff --git a/a b/a\n+x", cwd: dir },
      bumpBatch: () => {},
    } as never);
    providerAnswer = OK;
    assert(
      providerContextProblem(rateResult.parseError ?? "") === undefined,
      `(2f) a rate refusal's lane does not name the provider context-length limit (got: ${String(rateResult.parseError)})`,
    );
  }

  // (2g) The terminal class is decided by UNAMBIGUOUS size wording only, and any
  // rate wording vetoes it. Each body below says "too many tokens" (or a token
  // count) alongside a rate signal, so a lane must spend its full budget on every
  // one of them. The 400-bearing quota forms are the sharp cases: the status alone
  // reads as terminal, and only the rate guard stops it.
  for (const [label, message] of [
    ["429 too many tokens", "429 Too Many Requests: too many tokens, retry in 30s"],
    [
      "429 tokens per minute",
      '429 status code (no body): {"error":{"message":"Rate limit reached: too many tokens per minute"}}',
    ],
    [
      "429 mixed wording",
      "429 Too Many Requests: too many tokens in this prompt or too many requests, reduce tokens per request",
    ],
    [
      "400 quota + input tokens",
      "400 Bad Request: input tokens exceeded your current quota, please upgrade your plan",
    ],
    ["400 rate limit", "400 Bad Request: rate limit exceeded, slow down and retry"],
    [
      "400 throttle + too many tokens",
      "400 status code (no body): too many tokens — request throttled, retry later",
    ],
    // The forms the rate guard cannot catch by wording: no "rate limit", no 429,
    // no "retry in" — just a bare token count the provider refused. A token count
    // is exactly as ambiguous as "too many tokens", so TERMINAL_PATTERNS excludes
    // it and the lane keeps its attempts.
    ["400 bare token count", "400 Bad Request: 250000 tokens exceeds the 200000 allowed"],
    [
      "400 input-token limit",
      '400 status code (no body): {"error":{"message":"You exceeded your current limit of 200000 input tokens"}}',
    ],
    ["400 reduce the tokens", "400 Bad Request: reduce the tokens in this request"],
  ] as const) {
    const rateSpawns = await spawnsFor(() => failed("", { reason: "error", message }));
    assert(
      rateSpawns > 1,
      `(2g) a rate refusal worded with size vocabulary (${label}) keeps its retries (got ${String(rateSpawns)} spawn${rateSpawns === 1 ? ", not retried" : ", retried"})`,
    );
  }

  // (2h) A genuine context-length refusal still ends the lane when it carries its
  // 400 — the discrimination must not have quietly thrown the fix away with the
  // over-broad vocabulary. Both the 400-bearing and the bare forms are terminal.
  const terminalWithStatus = await spawnsFor(() =>
    failed("", {
      reason: "error",
      message:
        '400 status code (no body): {"error":{"message":"This model\'s maximum context length is 8192 tokens"}}',
    }),
  );
  assert(
    terminalWithStatus === 1,
    `(2h) a 400 refusal that says the model's context length is still never retried (got ${String(terminalWithStatus)} spawns)`,
  );
  const terminalPromptTooLong = await spawnsFor(() =>
    failed("", {
      reason: "error",
      message: "400 Bad Request: prompt is too long for the model's context window",
    }),
  );
  assert(
    terminalPromptTooLong === 1,
    `(2h) and so is a 400 that says the prompt is too long (got ${String(terminalPromptTooLong)} spawns)`,
  );
} finally {
  if (savedSkills === undefined) delete process.env.PI_ENSEMBLE_SKILLS_DIR;
  else process.env.PI_ENSEMBLE_SKILLS_DIR = savedSkills;
  releaseLedger();
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
