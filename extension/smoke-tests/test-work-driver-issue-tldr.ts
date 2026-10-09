#!/usr/bin/env bun
/**
 * #1006 — editIssueTldrs: the merged-step TL;DR issue-body edit.
 *
 * Tests the forge seam (issueView + issueEdit) with a scripted fake forge:
 *   (a) a normal edit: TLDR is prepended to the issue body
 *   (b) idempotency: a body that already has a TLDR heading is NOT edited
 *   (c) a failed issueEdit does NOT throw (the caller records it as a note)
 *   (d) no normalisedSpec → no edit (empty-string contract)
 *   (e) multiple active issues → each is edited
 */

import type { Forge } from "../src/forge.ts";
import type { NormalizedIssue } from "../src/forge-types.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { editIssueTldrs } from "../src/work-driver-merged-tldr.ts";
import type { WorkState } from "../src/workflow-state.ts";
import { initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** Build a fake forge that records calls and returns scripted responses. */
function makeFakeForge(
  initialBodies: Record<number, string>,
  opts?: { failEditFor?: Set<number> },
): { forge: Forge; calls: Array<{ op: string; issue: number; body?: string }> } {
  const bodies = new Map<number, string>(Object.entries(initialBodies).map(([k, v]) => [
    Number(k),
    v,
  ]));
  const calls: Array<{ op: string; issue: number; body?: string }> = [];

  const forge: Forge = {
    forge: "github" as const,
    host: "github.com",
    owner: "acme",
    repo: "widget",
    cwd: "/tmp/fake",
    issueView: async (n) => {
      calls.push({ op: "issueView", issue: n });
      const body = bodies.get(n);
      if (body === undefined) throw new Error(`issue #${n} not found`);
      return {
        number: n,
        title: `Issue #${n}`,
        body,
        state: "OPEN" as const,
        url: `https://github.com/acme/widget/issues/${n}`,
        author: undefined,
        labels: [],
        createdAt: undefined,
        updatedAt: undefined,
      };
    },
    issueEdit: async (n, body) => {
      calls.push({ op: "issueEdit", issue: n, body });
      if (opts?.failEditFor?.has(n)) {
        throw new Error(`simulated issueEdit failure for #${n}`);
      }
      bodies.set(n, body);
      return {
        number: n,
        title: `Issue #${n}`,
        body,
        state: "OPEN" as const,
        url: `https://github.com/acme/widget/issues/${n}`,
        author: undefined,
        labels: [],
        createdAt: undefined,
        updatedAt: undefined,
      };
    },
    // All other forge methods are stubs (not exercised by this test).
    issueCreate: async () => {
      throw new Error("not used");
    },
    issueComment: async () => "",
    issueComments: async () => [],
    issueSearch: async () => [],
    prView: async () => {
      throw new Error("not used");
    },
    prList: async () => [],
    prCreate: async () => {
      throw new Error("not used");
    },
    prMerge: async () => "",
    prDiff: async () => "",
    prChecks: async () => [],
    prComments: async () => [],
    prComment: async () => "",
    ciWatch: async () => ({ ok: true as const, run: undefined, terminal: true, timedOut: false }),
    ciRun: async () => {
      throw new Error("not used");
    },
    mergeReadiness: async () => ({
      ok: true as const,
      readiness: {
        mergeable: "TRUE" as const,
        blocking: [],
        checks: [],
      },
    }),
    labelCreate: async () => undefined,
    labelAdd: async () => {},
    labelRemove: async () => {},
    repoSettings: async () => {
      throw new Error("not used");
    },
  } as unknown as Forge;

  return { forge, calls };
}

/** Build a WorkState with a normalisedSpec and active issues. */
function mkState(
  issue: number,
  activeIssues: number[],
  spec?: {
    intent: string;
    deliverables: Array<{ id: string; description: string; paths: string[] }>;
  },
): WorkState {
  const s = initialState(issue, 1_000_000);
  return {
    ...s,
    issues: activeIssues,
    pipelineState: {
      ...s.pipelineState,
      activeIssues,
      ...(spec
        ? {
            normalisedSpec: {
              intent: spec.intent,
              deliverables: spec.deliverables,
              acceptanceCriteria: [],
              outOfScope: [],
              assumptions: [],
              openQuestions: [],
              evidence: [],
              verdict: "proceed" as const,
              rationale: "test",
            },
          }
        : {}),
    },
  } as WorkState;
}

// ---------------------------------------------------------------------------
// (a) Normal edit: TLDR is prepended to the issue body
// ---------------------------------------------------------------------------
{
  const body = "## Context\n\nThe original issue body.";
  const { forge, calls } = makeFakeForge({ 100: body });
  const state = mkState(100, [100], {
    intent: "Add a TL;DR section to PR bodies.",
    deliverables: [{ id: "d1", description: "A tldrSectionOf helper", paths: [] }],
  });

  const notes = await editIssueTldrs(forge, state);
  assert(notes.length === 0, "(a) no error notes on success");
  const editCalls = calls.filter((c) => c.op === "issueEdit");
  assert(editCalls.length === 1, "(a) exactly one issueEdit call");
  assert(
    editCalls[0]?.body?.startsWith("## TL;DR"),
    "(a) the edited body starts with the ## TL;DR heading",
  );
  assert(
    editCalls[0]?.body?.includes("The original issue body."),
    "(a) the original body text is preserved",
  );
}

// ---------------------------------------------------------------------------
// (b) Idempotency: body already has a TLDR heading → no edit
// ---------------------------------------------------------------------------
{
  const body = "## TL;DR\n\nExisting summary.\n\n## Context\n\nBody.";
  const { forge, calls } = makeFakeForge({ 101: body });
  const state = mkState(101, [101], {
    intent: "Add a TL;DR section.",
    deliverables: [{ id: "d1", description: "A helper", paths: [] }],
  });

  const notes = await editIssueTldrs(forge, state);
  assert(notes.length === 0, "(b) no error notes");
  const editCalls = calls.filter((c) => c.op === "issueEdit");
  assert(editCalls.length === 0, "(b) no issueEdit call when TLDR already present (idempotent)");
}

// ---------------------------------------------------------------------------
// (c) Failed issueEdit → note recorded, no throw
// ---------------------------------------------------------------------------
{
  const body = "## Context\n\nBody.";
  const { forge, calls } = makeFakeForge({ 102: body }, { failEditFor: new Set([102]) });
  const state = mkState(102, [102], {
    intent: "Add a TL;DR section.",
    deliverables: [{ id: "d1", description: "A helper", paths: [] }],
  });

  let notes: string[] = [];
  try {
    notes = await editIssueTldrs(forge, state);
  } catch (e) {
    assert(false, `(c) editIssueTldrs threw: ${(e as Error).message}`);
  }
  assert(notes.length === 1, "(c) exactly one error note recorded");
  assert(
    notes[0]?.includes("#102"),
    "(c) the note names the failed issue #102",
  );
}

// ---------------------------------------------------------------------------
// (d) No normalisedSpec → no edit (empty-string contract)
// ---------------------------------------------------------------------------
{
  const body = "## Context\n\nBody.";
  const { forge, calls } = makeFakeForge({ 103: body });
  const state = mkState(103, [103]); // no spec

  const notes = await editIssueTldrs(forge, state);
  assert(notes.length === 0, "(d) no error notes");
  const editCalls = calls.filter((c) => c.op === "issueEdit");
  assert(editCalls.length === 0, "(d) no issueEdit call when spec is absent");
  const viewCalls = calls.filter((c) => c.op === "issueView");
  assert(viewCalls.length === 0, "(d) no issueView call when spec is absent (short-circuited)");
}

// ---------------------------------------------------------------------------
// (e) Multiple active issues → each is edited
// ---------------------------------------------------------------------------
{
  const { forge, calls } = makeFakeForge({
    104: "## Context\n\nBody for #104.",
    105: "## Context\n\nBody for #105.",
  });
  const state = mkState(104, [104, 105], {
    intent: "Add a TL;DR section.",
    deliverables: [{ id: "d1", description: "A helper", paths: [] }],
  });

  const notes = await editIssueTldrs(forge, state);
  assert(notes.length === 0, "(e) no error notes");
  const editCalls = calls.filter((c) => c.op === "issueEdit");
  assert(editCalls.length === 2, "(e) exactly two issueEdit calls (one per active issue)");
  assert(
    editCalls.some((c) => c.issue === 104),
    "(e) issue #104 was edited",
  );
  assert(
    editCalls.some((c) => c.issue === 105),
    "(e) issue #105 was edited",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
