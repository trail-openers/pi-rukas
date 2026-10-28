#!/usr/bin/env bun
/**
 * lean/engine + lean/command — the not-ready report is not memoized.
 *
 * The claim is the one the step log makes about a step it has already
 * "completed": a run that could not post its not-ready comment must say so, and
 * must still exit 11 rather than 10.
 *
 * Before the `report-failed` kind existed, the handler swallowed the throw into
 * `{kind:"done", reason:"comment not posted"}`. The step memoized, the next
 * drive ran nothing, and the persisted reason read as a clean not-ready verdict
 * — the documented "one comment per run" had silently become "at most zero, and
 * the file says it was posted".
 *
 * Every case is judged on CALL COUNTS and the bytes on disk, because a returned
 * object could claim all three properties while none of them held.
 */

import { runWorkLean } from "../src/lean/command.ts";
import { REPORT_FAILED, runLean } from "../src/lean/engine.ts";
import { postNotReady } from "../src/lean/io.ts";
import type { LeanRun, Outcome } from "../src/lean/state.ts";
import { loadRun } from "../src/lean/state.ts";
import { makeAssert, tempDir, ticking } from "./lib/lean-engine-fixtures.ts";
import { RULES, seedVerdict, writeState } from "./lib/lean-not-ready-fixtures.ts";

const { assert, failures } = makeAssert();

const verdictHandlers = (post: () => Outcome) => ({
  "not-ready": async () => post(),
});

/** The reporting step as it sits on disk, or undefined when there is none. */
function reportStep(run: LeanRun | undefined, issue: number) {
  return run?.steps.find((s) => s.state === "not-ready" && s.key === `${issue}:not-ready:0`);
}

// ── the report lands: one step, one outcome, memoized ─────────────────────

{
  const { dir, cleanup } = tempDir();
  try {
    let posts = 0;
    const clock = ticking();
    const handlers = verdictHandlers(() => {
      posts++;
      return { kind: "done" };
    });
    const first = await runLean({ repoRoot: dir, issue: 31, handlers, now: clock.now });
    assert(first.state === "not-ready", "a refused spec ends not-ready");
    assert(first.code === 11, "the verdict exits 11");
    assert(posts === 1, "the comment posted once");
    assert(
      first.run.result?.reason === RULES.join("; "),
      `the reason is the failed rules (got: ${first.run.result?.reason})`,
    );
    const again = await runLean({ repoRoot: dir, issue: 31, handlers, now: clock.now });
    assert(posts === 1, "a re-drive does not post twice — the step memoized");
    assert(again.code === 11, "and the re-drive is a free read of the verdict");
  } finally {
    cleanup();
  }
}

// ── the report fails: the step keeps NO outcome, so it stays owed ─────────

{
  const { dir, cleanup } = tempDir();
  try {
    let posts = 0;
    const clock = ticking();
    let failing = true;
    const handlers = verdictHandlers(() => {
      posts++;
      return failing
        ? { kind: REPORT_FAILED, reason: "simulated network drop" }
        : { kind: "done" };
    });
    const first = await runLean({ repoRoot: dir, issue: 33, handlers, now: clock.now });
    assert(first.state === "not-ready", "a failed post does not change the verdict");
    assert(first.code === 11, "nor the exit code — the run WAS refused, comment or not");
    assert(posts === 2, `the drive retried the post once (posts ${posts})`);
    assert(
      (first.run.result?.reason ?? "").includes("simulated network drop"),
      `the persisted reason says the comment never posted (got: ${first.run.result?.reason})`,
    );
    assert(
      (first.run.result?.reason ?? "").includes(RULES[0]),
      "and still names the rule the comment was meant to deliver",
    );
    const step = reportStep(loadRun(dir, 33), 33);
    assert(
      step?.deliveryError === "simulated network drop",
      `the step carries the delivery error (got: ${step?.deliveryError})`,
    );
    assert(step?.outcome === undefined, "and NO outcome — a step that never happened");
    assert(
      step?.endedAt === undefined,
      "no endedAt either, so the file cannot read as a finished step",
    );
  } finally {
    cleanup();
  }
}

// ── a run whose post failed is owed, and a later drive collects it ─────────

{
  // The shape a crash or a persistent outage leaves: the verdict on disk, the
  // reporting step marked and unrecorded. A later drive must ask the forge
  // again — this is what the finding was about — and must not stall forever.
  const { dir, cleanup } = tempDir();
  try {
    seedVerdict(dir, 35);
    const clock = ticking();
    const failed = await runLean({
      repoRoot: dir,
      issue: 35,
      handlers: verdictHandlers(() => ({ kind: REPORT_FAILED, reason: "outage" })),
      now: clock.now,
    });
    assert(failed.code === 11, "the drive that could not post still exits at the verdict");
    assert(reportStep(loadRun(dir, 35), 35)?.outcome === undefined, "step left owed");

    let reposts = 0;
    const recovered = await runLean({
      repoRoot: dir,
      issue: 35,
      handlers: verdictHandlers(() => {
        reposts++;
        return { kind: "done" };
      }),
      now: clock.now,
    });
    assert(reposts === 1, `the next drive re-posts the comment (calls ${reposts})`);
    assert(recovered.code === 11, "and the verdict is unchanged by the retry");
    assert(
      reportStep(loadRun(dir, 35), 35)?.outcome?.kind === "done",
      "the step that finally posted carries its outcome",
    );
  } finally {
    cleanup();
  }
}

// ── an outage that outlasts the retry terminates rather than spinning ──────

{
  const { dir, cleanup } = tempDir();
  try {
    seedVerdict(dir, 37);
    let posts = 0;
    const clock = ticking();
    // Bound below the default cap so a loop that never terminated would report
    // the cap rather than silently passing as "it ended".
    const r = await runLean({
      repoRoot: dir,
      issue: 37,
      handlers: verdictHandlers(() => {
        posts++;
        return { kind: REPORT_FAILED, reason: "still down" };
      }),
      now: clock.now,
      maxSteps: 8,
    });
    assert(posts === 2, `the post is attempted twice and then abandoned (posts ${posts})`);
    assert(r.state === "not-ready" && r.code === 11, "the run still ends at its verdict");
    assert(
      (r.run.result?.reason ?? "").includes("still down"),
      `and says it never reported (got: ${r.run.result?.reason})`,
    );
    const r2 = await runLean({
      repoRoot: dir,
      issue: 37,
      handlers: verdictHandlers(() => ({ kind: "done" })),
      now: clock.now,
    });
    assert(r2.code === 11, "a later drive reads the settled verdict and posts nothing new");
  } finally {
    cleanup();
  }
}

// ── a caller with no forge reporter still reports the finding ──────────────

{
  const { dir, cleanup } = tempDir();
  try {
    seedVerdict(dir, 39);
    const r = await runLean({ repoRoot: dir, issue: 39, handlers: {}, now: ticking().now });
    assert(r.state === "not-ready", "no reporter does not turn a spec refusal into a fault");
    assert(
      r.code === 11,
      `exit 11, not 10 — the finding is the run's, not the harness's (got ${r.code})`,
    );
    assert(
      (r.run.result?.reason ?? "").includes(RULES[0]),
      `and the reason still carries the rule (got: ${r.run.result?.reason})`,
    );
  } finally {
    cleanup();
  }
}

// ── the real command path, with the real io module's failure branch ────────

{
  const { dir, cleanup } = tempDir();
  try {
    let thrown = "";
    try {
      await postNotReady(dir, 1, RULES);
    } catch (err) {
      thrown = (err as Error).message;
    }
    assert(
      /no forge adapter/.test(thrown),
      `postNotReady throws for a repo with no remote (${thrown})`,
    );

    // The command path with nothing stubbed: `ready` judges a real issue body
    // fetched through the real seam, and `not-ready` meets the real failure.
    const { summary, result } = await runWorkLean(dir, 41);
    assert(
      result.state === "not-ready" && result.code === 11,
      `the command path reaches a verdict whatever the comment did (got ${result.state}/${result.code})`,
    );
    assert(
      /could not read the issue|no pi-spec v1 block/.test(summary),
      `the line names why the run was refused (got: ${summary.slice(0, 120)})`,
    );
    const stored = loadRun(dir, 41);
    assert(
      stored?.steps.some((s) => s.state === "not-ready") === true,
      "the reporting step exists on disk",
    );
  } finally {
    cleanup();
  }
}

// ── `report-failed` is not a verdict any other state may return ────────────

{
  // A handler that returns it from somewhere else is a handler bug, and the
  // table must refuse it as loudly as it refuses any unlisted kind — otherwise
  // a future handler could decline a verdict it owes by claiming a failed post.
  const { dir, cleanup } = tempDir();
  try {
    const r = await runLean({
      repoRoot: dir,
      issue: 43,
      handlers: { ready: async () => ({ kind: REPORT_FAILED, reason: "not allowed here" }) },
      now: ticking().now,
    });
    assert(r.state === "handed-back", "a stray report-failed is refused, not routed");
    assert(r.code === 10, "and the run that misbehaved exits as a driver fault");
    assert(
      (r.run.result?.reason ?? "").includes("no transition for ready"),
      `the reason names the unlisted pair (got: ${r.run.result?.reason})`,
    );
  } finally {
    cleanup();
  }
}

process.exit(failures());
