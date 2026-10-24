#!/usr/bin/env bun
/**
 * #1137 — the plumb-report half of the develop fix pass, split out of
 * `test-work-driver-adversarial-fix-pass.ts` (AGENTS.md §12 file-size limit).
 *
 * What a fix pass says when it changes nothing: the named-path widening that
 * decides what the developer may touch, `plumbQuestion` as the single reader
 * both no-change park branches use (and the #1789 rule that a DRIVER-authored
 * report is never presented as a developer question), and `freshPlumbQuestion`'s
 * refusal to present a stale pass's question as this pass's.
 */

import { rmSync } from "node:fs";
import type { DispatchResult } from "../src/types.ts";
import {
  namedPaths,
  pendingFixes,
  plumbQuestion,
  runAdversarialFixPass,
} from "../src/work-driver-adversarial-fix.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import type { WorkState } from "../src/workflow-state.ts";
import { repoWithFile, twoWorkstreamState } from "./lib/adversarial-fix-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_ADVERSARIAL_EMPTY_SKIP = "0";
process.env.PI_ENSEMBLE_FORGE = "none";

// H — a named path is a whole path token: `lib/data.txt` does not name `lib/a.txt`.
{
  const named = namedPaths(
    "lib/data.txt: fix it; lib/a.txt: and this",
    ["lib/a.txt", "lib/data.txt", "lib/x.txt"],
    ["lib/a.txt"],
  );
  assert(
    named.join(",") === "lib/a.txt,lib/data.txt",
    `H: only whole-token path names are widened (got ${named.join(",")})`,
  );
  assert(
    namedPaths("see lib/data.txt.", ["lib/a.txt"], ["lib/a.txt"]).length === 0 &&
      namedPaths("see (lib/a.txt).", ["lib/a.txt"], ["lib/a.txt"]).join() === "lib/a.txt",
    "H: punctuation around a path token still matches, a longer name does not",
  );
}

// H2 — #1137: plumbQuestion is the single reader both no-change park branches
// use: the untrusted-text prefix, code fences stripped, capped at 300 chars
// with an ellipsis; null when no report carries the marker.
{
  const fenced = [
    {
      body: "[ensemble:plumb]\ncategory: scope-ambiguity\n```diff\nold\nnew\n```\nquestion: does docs own b.txt?",
    },
  ];
  const q = plumbQuestion(fenced);
  assert(
    q?.startsWith("developer question (untrusted text): ") && !q.includes("```"),
    `H2: the plumb body is prefixed, and code fences are stripped (got: ${q})`,
  );
  const long = [{ body: `[ensemble:plumb]\n${"x".repeat(400)}` }];
  const ql = plumbQuestion(long) ?? "";
  const bodyAfterPrefix = ql.slice("developer question (untrusted text): ".length);
  assert(
    ql.endsWith("…") && bodyAfterPrefix.length === 300,
    `H2: a long plumb body is capped at 300 chars with an ellipsis (body len ${bodyAfterPrefix.length})`,
  );
  assert(
    plumbQuestion([{ body: "an ordinary note with no marker" }]) === null,
    "H2: a report without the plumb marker returns null",
  );
  // #1789 — a DRIVER report is a disclosure the harness decided, never a
  // question to answer. The bound-kill conversion writes one whose text names a
  // kill cause, and any report whose body happens to carry a marker word must
  // not come back as "developer question" — that sends the operator to answer a
  // question nobody asked.
  assert(
    plumbQuestion([
      {
        role: "driver",
        body: "[ensemble:plumb] lens-fix killed at its bound (timeout) — partial fix",
      },
    ]) === null,
    "H2: a driver-authored report is never presented as a developer question",
  );
  assert(
    plumbQuestion([
      {
        role: "driver",
        body: "lens-fix killed at its bound (timeout) after committing 2 commit(s)",
      },
      { role: "developer", body: "[ensemble:plumb] question: should the fix also touch b.txt?" },
    ])?.includes("should the fix also touch b.txt") === true,
    "H2: a developer report after a driver report is still found",
  );
  assert(
    plumbQuestion([{ body: "[ensemble:plumb] question: unlabelled still reads" }]) !== null,
    "H2: a report with no role is judged on its body, as before",
  );
}

// J — #1137: a no-change fix pass whose developer replied with a plumb
// question (scope-ambiguity) routes to a handoff that NAMES the question, not
// the generic "byte-identical — nothing was fixed". The cap is
// fix-pass-park (#1349; it routes to handoff) but the evidence
// carries the plumb question so the operator answers it.
{
  const dir = repoWithFile("fix-plumb");
  try {
    const ctx: DriverContext = {
      host: { sendUserMessage: () => {} } as unknown as DriverContext["host"],
      repoRoot: dir,
      issue: 1137,
      issueBodyFetcherFn: async () => ({ stdout: "mock" }),
      dispatchFn: async (_pi, spec) =>
        ({
          role: spec.role,
          ok: true,
          exitCode: 0,
          // The developer returns a plumb report (scope-ambiguity) and changes nothing.
          text: "[ensemble:plumb]\ncategory: scope-ambiguity\nquestion: does this workstream own b.txt or a.txt?",
          toolUses: [],
          ms: 1,
        }) as DispatchResult,
    };
    // No prior plumb report: the fix developer's reply is the only source.
    const st = twoWorkstreamState(dir);
    const pending = pendingFixes(st.eventLog);
    const out = await runAdversarialFixPass(ctx, st, pending, Date.now());
    const tail = out.eventLog[out.eventLog.length - 1];
    assert(
      tail?.kind === "cap-hit" && tail.cap === "fix-pass-park",
      `J: a plumb-with-no-change parks as fix-pass-park (tail: ${tail?.kind})`,
    );
    // The evidence names the plumb question, not just "byte-identical".
    const evidence = tail?.kind === "cap-hit" ? (tail.evidence ?? "") : "";
    assert(
      /answer the question/.test(evidence) &&
        evidence.includes("does this workstream own b.txt or a.txt?"),
      `J: the evidence names the developer's plumb question (got: ${evidence.slice(0, 160)})`,
    );
    // The handoff's plumb section also carries the reply.
    assert(
      (out.pipelineState.plumbReports ?? []).some((r) =>
        r.body.includes("does this workstream own b.txt or a.txt?"),
      ),
      "J: the developer's reply is recorded as a plumb report for the handoff",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// K — #1137 review: a plumb report from an EARLIER pass is not this pass's question.
{
  // No-change pass: the developer answers "done" and commits nothing, so the
  // stale report is the only plumb candidate a route could present.
  const dir = repoWithFile("fix-stale-plumb");
  try {
    const ctx: DriverContext = {
      host: { sendUserMessage: () => {} } as unknown as DriverContext["host"],
      repoRoot: dir,
      issue: 1137,
      issueBodyFetcherFn: async () => ({ stdout: "mock" }),
      dispatchFn: async (_pi, spec) =>
        ({
          role: spec.role,
          ok: true,
          exitCode: 0,
          text: "done",
          toolUses: [],
          ms: 1,
        }) as DispatchResult,
    };
    const st = twoWorkstreamState(dir);
    const stale: WorkState = {
      ...st,
      pipelineState: {
        ...st.pipelineState,
        plumbReports: [
          { step: "develop", role: "driver", body: "[ensemble:plumb] old question", at: 1 },
        ],
      },
    };
    const out = await runAdversarialFixPass(ctx, stale, pendingFixes(stale.eventLog), Date.now());
    const tail = out.eventLog[out.eventLog.length - 1];
    const ev = tail?.kind === "cap-hit" ? (tail.evidence ?? "") : "";
    assert(
      tail?.kind === "cap-hit" && !/answer the question/.test(ev),
      `K: a stale plumb report is not presented as this pass's question (tail: ${tail?.kind})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
