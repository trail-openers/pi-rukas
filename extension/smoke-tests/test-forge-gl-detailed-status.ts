/**
 * test-forge-gl-detailed-status.ts — every value GitLab's own
 * `detailed_merge_status` enum can answer with, and what readiness it composes.
 *
 * The composition table in `forge-merge.ts` was written from GitHub's
 * vocabulary rather than GitLab's: it carried `can_be_merged`, `succeeding`,
 * `has_conflicts` and the eleven `blocked_by_*` names, which is not a subset of
 * what the API emits — it is disjoint from it. A ready MR therefore answered
 * `mergeable`, matched nothing, and the composition failed closed, so the pilot
 * team's green MR could not pass `ci` or `land`. A table that matches nothing is
 * only observable when every documented value is pinned, which is what the
 * table below does: one row per value GitLab documents, with the readiness that
 * value must compose, plus one value outside the set to keep the fail-closed arm
 * honest.
 *
 * The second block is the retry: a value that composes UNKNOWN must be WAITED by
 * `ci`'s poll and must not spend a build round, for every UNKNOWN value and not
 * only for the one (`checking`) the pre-fix code knew.
 *
 * Run: cd extension && bun run smoke-tests/test-forge-gl-detailed-status.ts
 */

import { composeGlReadiness } from "../src/forge.ts";
import { GL_STATUS_TO_READINESS } from "../src/forge-merge.ts";
import { checksRedReason } from "../src/lean/ci-tier.ts";
import type { HandlerCtx } from "../src/lean/engine.ts";
import { VerifyInfraError } from "../src/lean/verify-types.ts";
import { assert, check, forgeExitCode } from "./lib/forge-harness.ts";

/** One MR row with every cross-check field answered consistently-clean, so the
 *  only variable in a case is the status the forge reported. The builder does
 *  NOT answer `approvals_left` unless a case asks it to: the single-MR reply has
 *  never carried the key, so the exhaustive per-value table is driven by the
 *  shape the API really sends (the absent/null arms are pinned by
 *  `test-forge-gl-approvals-optional.ts`). */
const row = (status: string, over: Record<string, unknown> = {}) => ({
  detailed_merge_status: status,
  has_conflicts: false,
  blocking_discussions_resolved: true,
  state: "opened",
  ...over,
});

/**
 * GitLab's documented `detailed_merge_status` enum, each with what the
 * composition must do with it. The set is the documented list, not a sample of
 * it: an incomplete list here is the same defect the table had, only on the
 * test side.
 *
 * Four values name a cause a cross-check also reads, so the honest expectation
 * is what the row says, not what the word suggests. `conflict` with
 * `has_conflicts: true` and `not_open` with `state: "closed"` are a server
 * agreeing with itself and compose DIRTY; `discussions_not_resolved` and
 * `draft_status` are answered on their cross-check field — an MR whose
 * discussions ARE resolved is not blocked by them and composes by its status,
 * and one whose discussions are NOT is refused by the cross-check, which names
 * the field rather than returning a readiness. Those rows carry the field that
 * makes them meaningful (`conflictRows` below), and each of the four is asserted
 * BOTH ways — the agreeing row and the contradicting one — so no arm here is
 * satisfied by a fixture that quietly dodges the cross-check.
 */
const DOCUMENTED: ReadonlyArray<readonly [string, "CLEAN" | "DIRTY" | "UNKNOWN"]> = [
  ["mergeable", "CLEAN"],
  ["checking", "UNKNOWN"],
  ["unchecked", "UNKNOWN"],
  ["preparing", "UNKNOWN"],
  ["approvals_syncing", "UNKNOWN"],
  ["ci_still_running", "UNKNOWN"],
  ["ci_must_pass", "DIRTY"],
  ["commits_status", "DIRTY"],
  // `conflict` is only a consistent reply when the row also reports the
  // conflict, so it carries that field (see `conflictRows`).
  ["conflict", "DIRTY"],
  ["discussions_not_resolved", "DIRTY"],
  ["draft_status", "DIRTY"],
  ["jira_association_missing", "DIRTY"],
  ["locked_lfs_files", "DIRTY"],
  ["locked_paths", "DIRTY"],
  ["merge_request_blocked", "DIRTY"],
  ["merge_time", "DIRTY"],
  ["need_rebase", "DIRTY"],
  ["not_approved", "DIRTY"],
  // `not_open` is what GitLab reports for an MR that is not open, so the row
  // says so too — a `not_open` claiming `state: "opened"` is the contradiction
  // arm, tested separately below.
  ["not_open", "DIRTY"],
  ["requested_changes", "DIRTY"],
  ["security_policy_pipeline_check", "DIRTY"],
  ["security_policy_violations", "DIRTY"],
  ["status_checks_must_pass", "DIRTY"],
  ["title_regex", "DIRTY"],
];

/** The row overrides that make a value's reply the reply GitLab would actually
 *  send for it — and, for two of them, what the composition really does with it.
 *  A `not_open` row carries the state that caused it, and the state cross-check
 *  refuses that row naming `state` (asserted in the cross-checked block below);
 *  the exhaustive table therefore asks the question this file is about — does the
 *  value have a mapping, and does the composition name it — of the row whose
 *  fields do not themselves refuse it. `conflict` carries its conflict for the
 *  same documentary reason: it composes DIRTY either way. */
const ROW_OVERRIDES: Readonly<Record<string, Record<string, unknown>>> = {
  conflict: { has_conflicts: true },
  not_open: { state: "closed" },
};

/** Values whose documented row is refused by a cross-check before it can return a
 *  readiness: the exhaustive table pins their MAPPING, and the cross-checked block
 *  pins the refusal the composition actually makes for them. */
const REFUSED_BY_CROSS_CHECK = new Set(["not_open"]);

/** The row a documented value's case composes from. */
const rowFor = (status: string) => row(status, ROW_OVERRIDES[status] ?? {});

const UNKNOWN_VALUES = DOCUMENTED.filter(([, r]) => r === "UNKNOWN").map(([v]) => v);

/** The MR reply the fake forge answers with, carrying the head and the pipeline
 *  the step pins its jobs read to. */
const glMr = (head: string, status: string) => ({
  ...row(status),
  iid: 77,
  state: "opened",
  diff_refs: { base_sha: "a".repeat(40), head_sha: head, start_sha: "c".repeat(40) },
  open_pipeline: { id: 5001, status: "success" },
});

/** The poll drives ONE status per READ — the first read is what the forge says
 *  now, and `statusAt` says what it says on read N. The row the readiness
 *  composed from and the row the head/pipeline come from are ONE reply per read
 *  (that is what `lastMrRow` means in production), so the fake caches the row it
 *  composed and hands back that same row: a fake that answered the head from a
 *  different status than the readiness was composed from would be grading a
 *  retry the poll never made. */
function fakeGlForge(
  head: string,
  statusAt: (read: number) => string,
  reads: { mr: number },
  jobs: { name: string; state: string; blocking: boolean }[] = [
    { name: "build", state: "SUCCESS", blocking: true },
    { name: "test", state: "SUCCESS", blocking: true },
  ],
) {
  let rowOfLastRead: Record<string, unknown> | undefined;
  return {
    mergeReadiness: async () => {
      const rowRead = statusAt(reads.mr);
      reads.mr++;
      rowOfLastRead = row(rowRead);
      const composed = composeGlReadiness(rowOfLastRead);
      return { ok: true as const, readiness: composed.readiness, detail: composed.detail };
    },
    lastMrRow: () =>
      rowOfLastRead === undefined ? undefined : { ...glMr(head, ""), ...rowOfLastRead },
    glPipelineJobs: async () => ({
      rows: jobs,
      truncated: false,
      pipelineSha: head,
    }),
  };
}

/** Drive the step's forge wait over one MR row. `statusAt` is called with the
 *  read number, so a poll case says what the forge reports NOW rather than
 *  owning the reply object. */
async function pollOnce(
  head: string,
  statusAt: (read: number) => string,
  jobs?: { name: string; state: string; blocking: boolean }[],
) {
  const reads = { mr: 0 };
  const slept: number[] = [];
  // The clock MOVES only on a sleep the poll itself took (see
  // `lib/lean-ci-recorder.ts`): a sleep that did not advance it would let the
  // bound never expire and this case would spin instead of failing.
  let clock = 0;
  const deps = {
    exec: async () => ({ stdout: "" }),
    now: () => clock,
    sleep: async (ms: number) => {
      slept.push(ms);
      clock += ms;
    },
    waitTimeoutMs: 30_000,
  };
  // A WAIT that never ends must fail as an expired wait, and only as that: an
  // assertion here that ran without this arm would spin on a poll that slept
  // forever rather than returning the verdict the case asked for.
  const spinGuard = setTimeout(() => {
    throw new Error("the poll never stopped waiting");
  }, 30_000);
  const ctx = { repoRoot: "/repo", run: {}, now: () => clock } as unknown as HandlerCtx;
  const outcome = { kind: "green" as string, reason: "" };
  try {
    const reason = await checksRedReason(
      deps,
      ctx,
      "/repo",
      77,
      head,
      30,
      true,
      fakeGlForge(head, (n) => statusAt(n), reads, jobs),
    );
    if (reason !== undefined) {
      outcome.kind = "red";
      outcome.reason = reason;
    }
  } catch (err) {
    clearTimeout(spinGuard);
    return { threw: err as Error, slept, reads };
  }
  clearTimeout(spinGuard);
  return { outcome, slept, reads };
}

async function main() {
  /** The message a composition refuses with, or `undefined` when it answered. */
  const throwsWith = (mr: Record<string, unknown>) => {
    try {
      composeGlReadiness(mr);
      return undefined;
    } catch (e) {
      return (e as Error).message;
    }
  };
  // ── The documented enum, one case per value ─────────────────────────────
  console.log("detailed_merge_status -> readiness (documented set):");
  for (const [status, expected] of DOCUMENTED) {
    await check(`  ${status} → ${expected}`, () => {
      const msg = throwsWith(rowFor(status));
      if (REFUSED_BY_CROSS_CHECK.has(status)) {
        // The honest expectation for this value is the refusal the code really
        // makes, naming the field that caused it — not a returned readiness.
        assert(msg !== undefined, `${status} should be refused by its cross-check`);
        assert(msg!.includes("state"), `must name the field: ${msg}`);
        return;
      }
      assert(msg === undefined, `should not throw: ${msg}`);
      const composed = composeGlReadiness(rowFor(status));
      assert(composed.readiness === expected, `got ${composed.readiness}, want ${expected}`);
      // The detail must name the value: a refusal that only says DIRTY tells
      // nobody which rule of the project's own blocked the merge.
      assert(
        composed.detail.includes(status),
        `detail does not name the value: ${composed.detail}`,
      );
      // The cross-checks the row DOES answer appear in the detail; `approvals_left`
      // is not one of them any more (the single-MR reply does not carry it), so a
      // `approvals_left=` fragment here is a value nobody sent.
      assert(
        composed.detail.includes("has_conflicts=") &&
          composed.detail.includes("blocking_discussions_resolved=") &&
          !composed.detail.includes("approvals_left"),
        `detail: ${composed.detail}`,
      );
    });
  }
  // The mapping itself is what the fail-closed arm cannot tell a lie about: a
  // value the table never named reaches the unmapped throw instead of a
  // readiness, so each value is also asked of the table alone.
  await check("  every documented value carries a mapping of its own", () => {
    for (const [status, expected] of DOCUMENTED) {
      const mapped = (GL_STATUS_TO_READINESS as Record<string, string>)[status];
      assert(mapped === expected, `${status}: table says ${String(mapped)}, want ${expected}`);
    }
  });

  // ── The four values whose cause a cross-check also reads ───────────────
  // The code's real behaviour is directional, and the cases say so rather than
  // asserting a word: a row whose field AGREES with its status composes DIRTY
  // with the value named; a row whose field DISAGREES fails closed naming the
  // FIELD. GitLab sends the agreeing shape — an MR blocked by unresolved
  // discussions answers `discussions_not_resolved` with the flag false, a closed
  // MR answers `not_open` with `state: closed`, a conflicted MR answers
  // `conflict` with `has_conflicts: true` — so those three are pinned as throws
  // naming their field, which is the actionable word in the handoff. `draft_status`
  // is the one the base already exercised for the other field (approvals), and its
  // state arm is the row the base could not answer at all.
  console.log("cross-checked causes:");
  // (a) the rows whose field reports a block: the cross-check refuses them and
  // names the FIELD, which is the actionable word in a handoff. These are the
  // shapes GitLab actually sends for those two values.
  for (const [status, field, agreeing] of [
    [
      "discussions_not_resolved",
      "blocking_discussions_resolved",
      { blocking_discussions_resolved: false },
    ],
    ["not_open", "state", { state: "closed" }],
  ] as const) {
    await check(`  ${status} with ${field} blocking fails closed naming the field`, () => {
      const msg = throwsWith(row(status, agreeing));
      assert(msg !== undefined, "should have failed closed");
      assert(msg!.includes(field), `must name ${field}: ${msg}`);
    });
  }
  // (b) a blocked status is never softened by a field that reports no such
  // block: the forge said the MR cannot merge, and a cross-check that could
  // overrule that would be a cross-check able to green-light a merge.
  await check("  conflict with has_conflicts false composes DIRTY naming the status", () => {
    const composed = composeGlReadiness(row("conflict", { has_conflicts: false }));
    assert(composed.readiness === "DIRTY", `got ${composed.readiness}`);
    assert(composed.detail.includes("conflict"), `detail: ${composed.detail}`);
  });
  await check("  draft_status composes DIRTY naming the status", () => {
    const composed = composeGlReadiness(row("draft_status"));
    assert(composed.readiness === "DIRTY", `got ${composed.readiness}`);
    assert(composed.detail.includes("draft_status"), `detail: ${composed.detail}`);
  });
  await check("  discussions_not_resolved with the flag true composes DIRTY", () => {
    const composed = composeGlReadiness(
      row("discussions_not_resolved", { blocking_discussions_resolved: true }),
    );
    assert(composed.readiness === "DIRTY", `got ${composed.readiness}`);
    assert(composed.detail.includes("discussions_not_resolved"), `detail: ${composed.detail}`);
  });
  await check("  not_open with state opened composes DIRTY naming the status", () => {
    const composed = composeGlReadiness(row("not_open", { state: "opened" }));
    assert(composed.readiness === "DIRTY", `got ${composed.readiness}`);
    assert(composed.detail.includes("not_open"), `detail: ${composed.detail}`);
  });
  // (c) the cross-check that is not a contradiction arm: outstanding approvals
  // force a refusal whatever the status claimed, because a CLEAN with approvals
  // outstanding is the merge this project must never make.
  await check("  approvals_left forces a refusal naming the field", () => {
    const msg = throwsWith(row("mergeable", { approvals_left: 2 }));
    assert(msg !== undefined && msg.includes("approvals_left"), `wrong: ${msg}`);
  });
  // The absent/null arms — the shape `glab mr view` really answers with, across
  // the mapped statuses — are the subject of `test-forge-gl-approvals-optional.ts`;
  // what stays here is the cross-check the composition still owes a number.

  // ── `mergeable` with consistent cross-checks is a real CLEAN ────────────
  console.log("mergeable composes CLEAN:");
  await check("  mergeable + no conflicts + discussions resolved + approvals 0", () => {
    const composed = composeGlReadiness(row("mergeable"));
    assert(composed.readiness === "CLEAN", `got ${composed.readiness}`);
  });
  await check("  and the cross-checks still refuse a mergeable that contradicts them", () => {
    let threw: string | undefined;
    try {
      composeGlReadiness(row("mergeable", { has_conflicts: true }));
    } catch (e) {
      threw = (e as Error).message;
    }
    assert(threw !== undefined && threw.includes("has_conflicts"), `wrong: ${threw}`);
    threw = undefined;
    try {
      composeGlReadiness(row("mergeable", { blocking_discussions_resolved: false }));
    } catch (e) {
      threw = (e as Error).message;
    }
    assert(
      threw !== undefined && threw.includes("blocking_discussions_resolved"),
      `wrong: ${threw}`,
    );
    threw = undefined;
    try {
      composeGlReadiness(row("mergeable", { approvals_left: 2 }));
    } catch (e) {
      threw = (e as Error).message;
    }
    assert(threw !== undefined && threw.includes("approvals_left"), `wrong: ${threw}`);
    threw = undefined;
    try {
      composeGlReadiness(row("mergeable", { state: "merged" }));
    } catch (e) {
      threw = (e as Error).message;
    }
    assert(threw !== undefined && threw.includes("state"), `wrong: ${threw}`);
  });

  // ── A value outside the documented set still fails closed, naming it ────
  console.log("undocumented value fails closed:");
  await check('  "foo_bar" throws and names itself', () => {
    let threw: string | undefined;
    try {
      composeGlReadiness(row("foo_bar"));
    } catch (e) {
      threw = (e as Error).message;
    }
    assert(threw !== undefined, "should have thrown");
    assert(threw!.includes("unmapped"), `wrong: ${threw}`);
    assert(threw!.includes("foo_bar"), `must name the value: ${threw}`);
  });

  // ── Every UNKNOWN value is the retryable one, not only `checking` ───────
  console.log("every UNKNOWN value is retried by the ci poll:");
  const HEAD = "b".repeat(40);
  for (const status of UNKNOWN_VALUES) {
    await check(`  ${status} is waited, then green`, async () => {
      const r = await pollOnce(HEAD, (n) => (n === 0 ? status : "mergeable"));
      assert(r.threw === undefined, `threw: ${r.threw?.message}`);
      assert(
        r.outcome?.kind === "green",
        `want green, got ${JSON.stringify(r.outcome ?? r.threw?.message)}`,
      );
      assert(
        r.slept.length === 1 && r.slept[0] === 60_000,
        `one wait of a minute between the two MR reads (${JSON.stringify(r.slept)})`,
      );
      assert(r.reads.mr === 2, `the MR was read ${String(r.reads.mr)} times, want 2`);
    });
  }
  // The bound is the poll's own and applies to every UNKNOWN value: a status
  // that never becomes CLEAN hands the run back rather than spinning forever.
  // The forge is deliberately unchanging here — a case that let it resolve
  // would exit the wait through the green arm and never test the bound.
  await check("  an UNKNOWN that never resolves hits the wait bound, naming the value", async () => {
    const r = await pollOnce(HEAD, () => "ci_still_running");
    assert(r.threw instanceof VerifyInfraError, `want infra throw, got ${String(r.threw)}`);
    assert(
      (r.threw?.message ?? "").includes("still pending"),
      `the throw must read as an expired wait: ${r.threw?.message}`,
    );
    // The wait was earned by the READINESS, not by a job row, so the reason
    // quotes the readiness value the poll is still waiting on — the shape the
    // operator sees in the handoff is
    // `… still pending after N min: readiness ci_still_running (…)`.
    assert(
      (r.threw?.message ?? "").includes("readiness ci_still_running"),
      `the expired wait must name the readiness value it waited on: ${r.threw?.message}`,
    );
  });
  // DIRTY is a verdict, not a wait: it is red with the composition's own detail,
  // on the FIRST read — a poll that slept before grading it would be waiting on
  // a forge that had already said no.
  await check("  a DIRTY status is red naming the value, and never waits", async () => {
    const r = await pollOnce(HEAD, () => "not_approved");
    assert(r.threw === undefined, `threw: ${r.threw?.message}`);
    assert(r.outcome?.kind === "red", `want red, got ${JSON.stringify(r.outcome)}`);
    assert(
      (r.outcome?.reason ?? "").includes("not_approved"),
      `the red names the value: ${r.outcome?.reason}`,
    );
    assert(r.slept.length === 0, `a red must not wait (${JSON.stringify(r.slept)})`);
  });
  // A red job row outranks an UNKNOWN readiness: the rows are evidence about
  // THIS commit and they have already said "failed", while the readiness is only
  // the forge not having finished deciding. A step that waited out its budget on
  // the readiness would spend the whole `ci` window on a build that is already
  // red, then hand back instead of routing a fix round.
  await check("  a red job is red at once even while the readiness is UNKNOWN", async () => {
    const r = await pollOnce(HEAD, () => "ci_still_running", [
      { name: "build", state: "SUCCESS", blocking: true },
      { name: "test", state: "FAILED", blocking: true },
    ]);
    assert(r.threw === undefined, `threw: ${r.threw?.message}`);
    assert(r.outcome?.kind === "red", `want red, got ${JSON.stringify(r.outcome)}`);
    assert((r.outcome?.reason ?? "").includes("test"), `names the job: ${r.outcome?.reason}`);
    assert(r.slept.length === 0, `a red row must not wait out the budget (${JSON.stringify(r.slept)})`);
    assert(r.reads.mr === 1, `one read, not a poll (${String(r.reads.mr)})`);
  });

  forgeExitCode("All GitLab detailed_merge_status tests passed.");
}

main().catch((e) => {
  console.error("unhandled:", e);
  process.exit(1);
});
