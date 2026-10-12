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
import {
  devCommit,
  fixState,
  git,
  repoWithFile,
  singleState,
  tmpDir,
} from "./lib/adversarial-fix-fixtures.ts";
import type { DispatchResult } from "../src/types.ts";
import {
  namedPaths,
  pendingFixes,
  runAdversarialFixPass,
  survivorsOf,
} from "../src/work-driver-adversarial-fix.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { nextStep } from "../src/work-driver-context.ts";
import type { WorkState } from "../src/workflow-state.ts";

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

// F — a finding may name a file outside the declared paths: that file is
// allowed for the pass, so the pass completes.
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
      out.eventLog[out.eventLog.length - 1]?.kind === "adversarial-fix-applied",
      "F: a file named in the findings is allowed outside the declared paths",
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
    const st = fixState(dir, []);
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

// H — a named path is a whole path token: `data.txt` does not name `a.txt`.
{
  const named = namedPaths("data.txt: fix it; a.txt: and this", ["a.txt", "data.txt", "x.txt"]);
  assert(
    named.join(",") === "a.txt,data.txt",
    `H: only whole-token path names are widened (got ${named.join(",")})`,
  );
  assert(
    namedPaths("see data.txt.", ["a.txt"]).length === 0 &&
      namedPaths("see (a.txt).", ["a.txt"]).join() === "a.txt",
    "H: punctuation around a path token still matches, a longer name does not",
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

console.log(`\nexit ${exit}`);
process.exit(exit);
