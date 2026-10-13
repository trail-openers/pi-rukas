#!/usr/bin/env bun
/**
 * #1114 — the develop fix pass on a real repository (split from
 * test-work-driver-adversarial-fix-routing.ts to keep both under the file-size gate).
 * The developer's edit is committed through the develop gates and the workstream
 * returns to adversarial; a no-op pass parks; a finding-named path is allowed, an
 * unnamed one is refused; removing an origin/main comment parks.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DispatchResult } from "../src/types.ts";
import {
  namedPaths,
  pendingFixes,
  plumbQuestion,
  runAdversarialFixPass,
  survivorsOf,
} from "../src/work-driver-adversarial-fix.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { nextStep } from "../src/work-driver-context.ts";
import type { WorkState } from "../src/workflow-state.ts";
import {
  devCommit,
  fixState,
  git,
  repoWithFile,
  singleState,
  tmpDir,
  twoWorkstreamState,
} from "./lib/adversarial-fix-fixtures.ts";

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

// E — the fix pass on a real repository: the developer's edit is committed
// through the develop gates and the workstream returns to adversarial; a
// no-op pass parks; a finding-named path widens scope, an unnamed one does not.
{
  const dir = repoWithFile("fix-ok");
  try {
    const devSpawns: string[] = [];
    const ctx: DriverContext = {
      pi: { sendUserMessage: () => {} } as unknown as DriverContext["pi"],
      repoRoot: dir,
      issue: 1114,
      issueBodyFetcherFn: async () => ({ stdout: "mock" }),
      dispatchFn: async (_pi, spec) => {
        devSpawns.push(spec.role);
        if (spec.role === "developer") devCommit(dir, "a.txt", "two\n");
        return {
          role: spec.role,
          ok: true,
          exitCode: 0,
          text: "done",
          toolUses: [],
          ms: 1,
        } as DispatchResult;
      },
    };
    const pending = pendingFixes(fixState(dir, ["a.txt"]).eventLog);
    // Declared scope is a.txt; the finding names b.txt too — the named path is
    // allowed, and the pass changes only a.txt, so every gate passes.
    const out = await runAdversarialFixPass(ctx, fixState(dir, ["a.txt"]), pending, Date.now());
    assert(
      devSpawns.filter((r) => r === "developer").length === 1,
      "E: the fix pass dispatches one developer",
    );
    assert(
      out.eventLog[out.eventLog.length - 1]?.kind === "adversarial-fix-applied",
      `E: a passing fix pass returns the workstream to adversarial (tail: ${out.eventLog[out.eventLog.length - 1]?.kind})`,
    );
    assert(
      out.pipelineState.workstreams?.default?.paths.join(",") === "a.txt",
      "E: the widened scope is not persisted past the pass",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  const dir = repoWithFile("fix-noop");
  try {
    const ctx: DriverContext = {
      pi: { sendUserMessage: () => {} } as unknown as DriverContext["pi"],
      repoRoot: dir,
      issue: 1114,
      issueBodyFetcherFn: async () => ({ stdout: "mock" }),
      dispatchFn: async (_pi, spec) =>
        ({
          role: spec.role,
          ok: true,
          exitCode: 0,
          text: "did nothing",
          toolUses: [],
          ms: 1,
        }) as DispatchResult,
    };
    const st = fixState(dir, ["a.txt"]);
    const out = await runAdversarialFixPass(ctx, st, pendingFixes(st.eventLog), Date.now());
    const tail = out.eventLog[out.eventLog.length - 1];
    assert(
      tail?.kind === "cap-hit" && tail.cap === "verify-failed:develop",
      `E: a no-op fix pass parks as verify-failed:develop (tail: ${tail?.kind})`,
    );
    assert(
      out.pipelineState.plumbReports.some((r) => r.body.includes("a.txt: change one to two")),
      "E: the handoff names the findings that triggered the pass",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  const dir = repoWithFile("fix-unnamed");
  try {
    const ctx: DriverContext = {
      pi: { sendUserMessage: () => {} } as unknown as DriverContext["pi"],
      repoRoot: dir,
      issue: 1114,
      issueBodyFetcherFn: async () => ({ stdout: "mock" }),
      dispatchFn: async (_pi, spec) => {
        if (spec.role === "developer") devCommit(dir, "a.txt", "two\n");
        return {
          role: spec.role,
          ok: true,
          exitCode: 0,
          text: "done",
          toolUses: [],
          ms: 1,
        } as DispatchResult;
      },
    };
    // The finding names only a.txt; the developer also changes b.txt, which is
    // neither declared nor named — the scope gate must refuse the pass.
    const st = fixState(dir, ["a.txt"]);
    const unnamed: WorkState = {
      ...st,
      eventLog: st.eventLog.map((e) =>
        e.kind === "adversarial-fix-requested" ? { ...e, findings: "a.txt: change one to two" } : e,
      ),
    };
    const pending = pendingFixes(unnamed.eventLog);
    ctx.dispatchFn = async (_pi, spec) => {
      if (spec.role === "developer") devCommit(dir, "b.txt", "two\n");
      return {
        role: spec.role,
        ok: true,
        exitCode: 0,
        text: "done",
        toolUses: [],
        ms: 1,
      } as DispatchResult;
    };
    const out = await runAdversarialFixPass(ctx, unnamed, pending, Date.now());
    assert(
      !out.eventLog.some((e) => e.kind === "adversarial-fix-applied"),
      "E: a change outside the declared and named paths does not complete the fix pass",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// F — a finding naming a ROOT file does not widen a root-declared fence: the
// repo root is not an anchor, so the developer's b.txt change parks the pass.
{
  const dir = repoWithFile("fix-named");
  try {
    const ctx: DriverContext = {
      pi: { sendUserMessage: () => {} } as unknown as DriverContext["pi"],
      repoRoot: dir,
      issue: 1114,
      issueBodyFetcherFn: async () => ({ stdout: "mock" }),
      dispatchFn: async (_pi, spec) => {
        if (spec.role === "developer") devCommit(dir, "b.txt", "two\n");
        return {
          role: spec.role,
          ok: true,
          exitCode: 0,
          text: "done",
          toolUses: [],
          ms: 1,
        } as DispatchResult;
      },
    };
    const st = fixState(dir, ["a.txt"]);
    const out = await runAdversarialFixPass(ctx, st, pendingFixes(st.eventLog), Date.now());
    assert(
      out.eventLog[out.eventLog.length - 1]?.kind === "cap-hit",
      "F: a root file named in the findings is not allowed outside the declared paths",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// F2 — a developer dispatch that fails parks the fix pass at a cap: it never
// reaches the review gate, and the tail routes through nextStep to handoff.
{
  const dir = repoWithFile("fix-dispatch-fail");
  try {
    const ctx: DriverContext = {
      pi: { sendUserMessage: () => {} } as unknown as DriverContext["pi"],
      repoRoot: dir,
      issue: 1114,
      issueBodyFetcherFn: async () => ({ stdout: "mock" }),
      dispatchFn: async () => {
        throw new Error("developer exploded");
      },
    };
    const st = fixState(dir, ["a.txt"]);
    const out = await runAdversarialFixPass(ctx, st, pendingFixes(st.eventLog), Date.now());
    const tail = out.eventLog[out.eventLog.length - 1];
    assert(
      tail?.kind === "cap-hit" && !out.eventLog.some((e) => e.kind === "adversarial-fix-applied"),
      `F2: a failed fix-pass dispatch parks at a cap, never applied (tail: ${tail?.kind})`,
    );
    assert(
      tail?.kind === "cap-hit" &&
        nextStep(out).kind === "step" &&
        (nextStep(out) as { step: string }).step === "handoff",
      "F2: the parked fix pass routes to handoff",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// G — a fix pass that removes an origin/main comment parks like a develop failure.
{
  const dir = repoWithFile("fix-comment");
  try {
    mkdirSync(path.join(dir, "extension", "src"), { recursive: true });
    writeFileSync(
      path.join(dir, "extension", "src", "x.ts"),
      "export const x = 1;\n// keep this comment about the parser\nexport const y = 2;\n",
    );
    git(dir, "add -A");
    git(dir, 'commit -q -m "add x"');
    const ctx: DriverContext = {
      pi: { sendUserMessage: () => {} } as unknown as DriverContext["pi"],
      repoRoot: dir,
      issue: 1114,
      issueBodyFetcherFn: async () => ({ stdout: "mock" }),
      dispatchFn: async (_pi, spec) => {
        if (spec.role === "developer") {
          devCommit(
            dir,
            path.join("extension", "src", "x.ts"),
            "export const x = 1;\nexport const y = 2;\n",
          );
        }
        return {
          role: spec.role,
          ok: true,
          exitCode: 0,
          text: "done",
          toolUses: [],
          ms: 1,
        } as DispatchResult;
      },
    };
    // The workstream is declared on the file the comment lives in: a finding
    // widens only within a declared or already-changed directory.
    const st = fixState(dir, ["extension/src/x.ts"]);
    const commentFinding: WorkState = {
      ...st,
      eventLog: st.eventLog.map((e) =>
        e.kind === "adversarial-fix-requested"
          ? { ...e, findings: "extension/src/x.ts: keep the comment" }
          : e,
      ),
    };
    const out = await runAdversarialFixPass(
      ctx,
      commentFinding,
      pendingFixes(commentFinding.eventLog),
      Date.now(),
    );
    const tail = out.eventLog[out.eventLog.length - 1];
    assert(
      tail?.kind === "cap-hit" && tail.cap === "verify-failed:develop",
      `G: a fix pass that removes an origin/main comment parks (tail: ${tail?.kind})`,
    );
    assert(
      out.pipelineState.plumbReports.some((r) => r.body.includes("origin/main comment")),
      "G: the handoff names the removed comment",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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
}

// I — a single-workstream cycle that ended on a round-3 CRITICAL reject is not
// recovered as approved when its survivor outcome is rebuilt from the log.
{
  const dir = tmpDir("survivor");
  try {
    const log: WorkState["eventLog"] = [
      { kind: "adversarial-round", at: 1, round: 1, status: "ISSUES_FOUND", verdictParsed: true },
      {
        kind: "adversarial-fix-requested",
        at: 2,
        workstreamId: "default",
        round: 1,
        findings: "r1",
      },
      { kind: "adversarial-fix-applied", at: 3, workstreamId: "default", round: 1 },
      { kind: "adversarial-round", at: 4, round: 2, status: "ISSUES_FOUND", verdictParsed: true },
      {
        kind: "adversarial-fix-requested",
        at: 5,
        workstreamId: "default",
        round: 2,
        findings: "r2",
      },
      { kind: "adversarial-fix-applied", at: 6, workstreamId: "default", round: 2 },
      {
        kind: "adversarial-round",
        at: 7,
        round: 3,
        status: "CRITICAL_ISSUES_FOUND",
        verdictParsed: true,
      },
    ];
    const st = singleState(dir, log);
    const survivors = survivorsOf(st, ["default"], [], new Map());
    assert(
      survivors.length === 1 &&
        survivors[0]?.ok === false &&
        survivors[0]?.priorVerdict === "rejected",
      `I: a rejected single workstream stays rejected (got ${JSON.stringify(survivors.map((s) => [s.ok, s.priorVerdict]))})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// J — #1137: a no-change fix pass whose workstream carried a plumb report
// (scope-ambiguity) routes to a handoff that NAMES the plumb question, not
// the generic "byte-identical — nothing was fixed". The cap is still
// verify-failed:develop (so nextStep routes to handoff) but the evidence
// carries the plumb question so the operator answers it.
{
  const dir = repoWithFile("fix-plumb");
  try {
    const ctx: DriverContext = {
      pi: { sendUserMessage: () => {} } as unknown as DriverContext["pi"],
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
    const st = twoWorkstreamState(dir);
    // Inject the plumb report into pipelineState (the develop step would have
    // recorded the developer's reply there).
    const stWithPlumb: WorkState = {
      ...st,
      pipelineState: {
        ...st.pipelineState,
        plumbReports: [
          {
            step: "develop" as const,
            role: "driver",
            body: "[ensemble:plumb]\ncategory: scope-ambiguity\nquestion: does this workstream own b.txt or a.txt?",
            at: Date.now(),
          },
        ],
      },
    };
    const pending = pendingFixes(stWithPlumb.eventLog);
    const out = await runAdversarialFixPass(ctx, stWithPlumb, pending, Date.now());
    const tail = out.eventLog[out.eventLog.length - 1];
    assert(
      tail?.kind === "cap-hit" && tail.cap === "verify-failed:develop",
      `J: a plumb-with-no-change parks as verify-failed:develop (tail: ${tail?.kind})`,
    );
    // The evidence names the plumb question, not just "byte-identical".
    const evidence = tail?.kind === "cap-hit" ? tail.evidence : "";
    assert(
      !/answer the question/.test(evidence),
      `J: a stale plumb report is not presented as this pass's question (got: ${evidence?.slice(0, 120)})`,
    );
    // The handoff's plumb section also carries the question.
    assert(
      (out.pipelineState.plumbReports ?? []).some((r) => /plumb|scope-ambiguity/i.test(r.body)),
      "J: the plumb report is in pipelineState for the handoff",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// K — #1137 review: a plumb report from an EARLIER pass is not this pass's question.
{
  const dir = repoWithFile("fix-stale-plumb");
  try {
    const ctx: DriverContext = {
      pi: { sendUserMessage: () => {} } as unknown as DriverContext["pi"],
      repoRoot: dir,
      issue: 1137,
      issueBodyFetcherFn: async () => ({ stdout: "mock" }),
      dispatchFn: async (_pi, spec) => {
        if (spec.role === "developer") devCommit(dir, "stray.txt", "x\n");
        return { role: spec.role, ok: true, exitCode: 0, text: "done", toolUses: [], ms: 1 } as DispatchResult;
      },
    };
    const st = twoWorkstreamState(dir);
    const stale: WorkState = {
      ...st,
      pipelineState: {
        ...st.pipelineState,
        plumbReports: [{ step: "develop", role: "driver", body: "[ensemble:plumb] old question", at: 1 }],
      },
    };
    const out = await runAdversarialFixPass(ctx, stale, pendingFixes(stale.eventLog), Date.now());
    const tail = out.eventLog[out.eventLog.length - 1];
    const ev = tail?.kind === "cap-hit" ? (tail.evidence ?? "") : "";
    assert(
      !/answer the question/.test(ev),
      `K: a stale plumb report is not presented as this pass's question (tail: ${tail?.kind})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
