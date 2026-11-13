#!/usr/bin/env bun
/**
 * lean/state-outcome — the four head fields the verified handback records.
 *
 * `shippedHead`, `shippedVerified`, `unshippedHead` and `unshippedReason` are what
 * the rule saw when it moved origin's branch, and the handback comment prints them
 * beside the bytes it hands back. That makes them the most load-bearing fields on
 * the record: a run that never verified anything can still tell an operator "this
 * head is the one the gate certified", and nothing in the comment reads as less
 * trustworthy.
 *
 * So `assertRun` refuses them anywhere but on the reporting step, refuses a
 * non-boolean `shippedVerified` (a truthy string survives `if (...)` and prints an
 * unverified head as a certified one), and refuses a head that is not a full commit
 * sha — a field naming a head it cannot resolve is a record about nothing, not a
 * partial record.
 *
 * These are the same rule every other case in `test-lean-state-outcome.ts` pins,
 * lifted out because the group is the verified-handback feature's own and the
 * parent file had reached its size cap. The shared rig
 * (`forgedOutcomeField` / `tempDir` / the loader) is imported from there so the two
 * files cannot drift on what a forged record looks like.
 */

import { readFileSync } from "node:fs";
import { REPORTING_STATES } from "../src/lean/state-outcome.ts";
import {
  type LeanRun,
  REPORT_STATES,
  createRun,
  leanStateFile,
  loadRun,
  saveRun,
} from "../src/lean/state.ts";
import { makeAssert, tempDir } from "./lib/lean-engine-fixtures.ts";
import { CLOCK, STEP, forgedOutcomeField } from "./lib/lean-state-outcome-rig.ts";
import { fixedReviewLog } from "./lib/lean-verified-handback-fixture.ts";
import { repoWithFixHead } from "./lib/lean-verified-handback-repo.ts";
import { driveHandback, rewinder } from "./lib/lean-verified-handback-step.ts";

const { assert, failures } = makeAssert();

for (const [label, issue, step, expect] of [
  [
    // All four go on one non-handback step: the table checks each field
    // independently, and one record that carries all of them pins the whole group
    // at the step that may not carry any — the same forgery `posted` refuses in
    // the parent file, in the direction that matters most, because a `shippedHead`
    // on a `build` step reads as a certified head to every reader of the record.
    "head fields on a build step",
    64,
    {
      key: "64:build:0",
      state: "build",
      startedAt: CLOCK,
      endedAt: CLOCK,
      outcome: {
        kind: "ok",
        shippedHead: "c".repeat(40),
        shippedVerified: true,
        unshippedHead: "d".repeat(40),
        unshippedReason: "the lease refused the rewind",
      },
    },
    /is only recorded by a handback step/,
  ],
  [
    // A truthy string survives `if (outcome.shippedVerified)` and prints an
    // unverified head as one the gate certified, which is the exact claim the rule
    // exists to make trustworthy. The field is a boolean or the record is refused.
    "shippedVerified as a string on a handback step",
    65,
    {
      key: "65:handback:0",
      state: "handback",
      startedAt: CLOCK,
      endedAt: CLOCK,
      outcome: { kind: "done", shippedHead: "c".repeat(40), shippedVerified: "yes" },
    },
    /shippedVerified must be a boolean/,
  ],
  [
    // The head fields are the answer to a question about SPECIFIC bytes, so a
    // field naming a head that is not a commit is not a partial record — it is a
    // record about nothing. The loader takes a full sha or refuses.
    "shippedHead that is not a full sha",
    66,
    {
      key: "66:handback:0",
      state: "handback",
      startedAt: CLOCK,
      endedAt: CLOCK,
      outcome: { kind: "done", shippedHead: "abc123" },
    },
    /shippedHead must be a 40-hex commit sha/,
  ],
] as const) {
  const { dir, cleanup } = tempDir();
  try {
    forgedOutcomeField(dir, issue, step);
    let thrown: unknown;
    try {
      loadRun(dir, issue);
    } catch (err) {
      thrown = err;
    }
    const message = thrown instanceof Error ? thrown.message : String(thrown ?? "");
    assert(
      thrown !== undefined && expect.test(message),
      `${label}: loadRun refuses it naming the field (got: ${thrown === undefined ? "NO THROW" : message})`,
    );
    assert(
      message.includes(step.key),
      `${label}: and the refusal names the step key (got: ${message})`,
    );
  } finally {
    cleanup();
  }
}

/**
 * The four fields survive a RESUME, on the step that legitimately owns them.
 *
 * A record the loader refuses is only half the rule; the other half is that the
 * fields the rule DOES write are still there after a reload, because the handback
 * step's comment is rebuilt from the loaded record. A field `buildOutcome` forgot
 * to copy is silently gone from every resumed run, and a resumed handback that lost
 * `shippedVerified` reads as an unverified head beside a branch it moved back to
 * the verified one — the two halves of the record disagreeing with each other.
 */
{
  const { dir, cleanup } = tempDir();
  try {
    const verified = "e".repeat(40);
    const leftBehind = "f".repeat(40);
    const reason = "origin still holds ffffffff — the lease refused the rewind";
    forgedOutcomeField(dir, 70, {
      key: "70:handback:0",
      state: "handback",
      startedAt: CLOCK,
      endedAt: CLOCK,
      outcome: STEP(70, "handback", 0, "done").outcome,
    });
    // The head fields are written beside the record the parent file's own resume
    // case builds, so the reload exercised here is the shape the step really saves.
    forgedOutcomeField(dir, 71, {
      key: "71:handback:0",
      state: "handback",
      startedAt: CLOCK,
      endedAt: CLOCK,
      outcome: {
        kind: "done",
        shippedHead: verified,
        shippedVerified: true,
        unshippedHead: leftBehind,
        unshippedReason: reason,
      },
    });
    assert(loadRun(dir, 70) !== undefined, "a handback without the head fields still loads");
    const heads = loadRun(dir, 71)?.steps.at(-1)?.outcome;
    assert(
      heads?.shippedHead === verified && heads.shippedVerified === true,
      `a resumed handback keeps the head it shipped and its verified claim (got ${JSON.stringify([heads?.shippedHead, heads?.shippedVerified])})`,
    );
    assert(
      heads?.unshippedHead === leftBehind && heads.unshippedReason === reason,
      `and the head it left behind with the reason why (got ${JSON.stringify([heads?.unshippedHead, heads?.unshippedReason])})`,
    );
  } finally {
    cleanup();
  }
}

/**
 * What the step actually SAVES, read out of the state file it wrote.
 *
 * The other half of the ownership rule. The four head fields are the record's head
 * facts, and each is owned, shaped and rebuilt field by field; a key `Outcome` does
 * not declare is a claim no validator ever judged. The handback's render decision —
 * "the rule spoke for this handback" — is one such key: it belongs to the comment, not
 * to the record. `buildOutcome` would drop it on reload, so its whole life is the
 * window between the handler and the file, and the only reader that can see it is the
 * saved bytes. Driven through the REAL step with the rule on and the rewind landed, so
 * the outcome has head fields to carry and a render decision to leak — a hand-written
 * outcome would pin the fixture rather than the handler.
 */
{
  const repo = repoWithFixHead();
  const steps = await fixedReviewLog(repo.baseSha);
  const { dir, cleanup } = tempDir();
  try {
    // The rewind and the origin read run in the FIXTURE's clone (they are git calls),
    // while the record is saved into `dir`, which is what `saveRun`/`leanStateFile`
    // address. The two repos are separate on purpose: the state file's home is the
    // thing under test here, not the clone.
    const { outcome } = await driveHandback(steps, repo.repoRoot, rewinder(repo.repoRoot));
    assert(
      outcome.shippedHead !== undefined && outcome.shippedVerified === true,
      `the driven handback recorded its head fields (got ${JSON.stringify([outcome.shippedHead, outcome.shippedVerified])})`,
    );
    const issue = 72;
    const run: LeanRun = {
      ...createRun({
        issue,
        version: "test",
        models: {},
        baseSha: "a".repeat(40),
        branch: "lean/issue-72",
      }),
      state: "handback",
      steps: [
        {
          key: `${String(issue)}:handback:0`,
          state: "handback",
          startedAt: CLOCK,
          endedAt: CLOCK,
          outcome,
        },
      ],
    };
    saveRun(dir, run);
    const saved = JSON.parse(readFileSync(leanStateFile(dir, issue), "utf8")) as {
      steps: { outcome?: Record<string, unknown> }[];
    };
    const keys = Object.keys(saved.steps.at(-1)?.outcome ?? {}).sort();
    assert(
      !keys.includes("speaks"),
      `the saved handback outcome carries no render-decision key (got ${JSON.stringify(keys)})`,
    );
    const back = loadRun(dir, issue)?.steps.at(-1)?.outcome;
    assert(
      back?.shippedHead === outcome.shippedHead && back?.shippedVerified === true,
      `and the owned head fields still survive the reload (got ${JSON.stringify([back?.shippedHead, back?.shippedVerified])})`,
    );
  } finally {
    cleanup();
  }
}

/**
 * The ownership table's report-state list is the engine's, or the table is not.
 *
 * Copied rather than imported because `state-outcome.ts` sits inside the load cycle
 * `state.ts` creates; this is the only thing keeping the copy honest, so the fields
 * owned "by a handback step" mean the same states the engine treats as reports.
 */
assert(
  JSON.stringify(REPORTING_STATES) === JSON.stringify(REPORT_STATES),
  `the ownership table's REPORTING_STATES equals state.ts's REPORT_STATES (got ${JSON.stringify([REPORTING_STATES, REPORT_STATES])})`,
);

process.exit(failures());
