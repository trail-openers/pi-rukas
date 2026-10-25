#!/usr/bin/env bun
/**
 * #1820 round 3 — a handoff whose body the publish guard REFUSED.
 *
 * The refusal has to be visible and the park still has to arm the guard that
 * stops the next one:
 *
 *  - NO comment posted and no body file written — the refused bytes never reach a
 *    forge, and a file on disk would read as something the driver is about to post;
 *  - the `needs-human-attention` label IS applied. It carries no text — it is a
 *    name the forge already has — and it is the ONLY carrier the pre-loop
 *    repeat-park gate (`work-driver-attention.ts`) reads. A park that published
 *    nothing and carried no label left no trace, so `/work N` on the same
 *    unchanged issue re-ran the pipeline, refused again, and produced another
 *    handoff no human had been asked to look at;
 *  - the refusal's REASON reaches the headless result (`bodyRefusalReason`) and
 *    `/work-status`, as the matcher's category or denylist line — never the term,
 *    which is the private thing itself;
 *  - the judged bytes stay on the event, because on the host channel nothing is
 *    ever posted and `handoff.body` is the report's only carrier (#1743).
 *
 * The forge stub records what it was asked to do, and answers its own label
 * read-back: an assertion that a label was applied is a claim about the read the
 * driver makes, so a stub that always answered "no labels" could not pin it.
 *
 * Offline, synthetic hosts and terms only.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Forge } from "../src/forge.ts";
import { projectIssue } from "../src/headless/result.ts";
import type { DispatchResult } from "../src/types.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { runHandoff } from "../src/work-driver-handoff.ts";
import { renderTerminalStatus } from "../src/work-status.ts";
import { type WorkState, appendEvent, initialState } from "../src/workflow-state.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

/** The forge's own name for a PR/MR target (the `labelAdd` vocabulary). */
const PR_KIND = "pr";
const fakePi = { sendUserMessage: () => undefined } as unknown as ExtensionAPI;

function capped(issue: number, cap: string): WorkState {
  return appendEvent(initialState(issue, 1_000_000), {
    kind: "cap-hit",
    at: 1_000_400,
    cap,
    reviewRound: 0,
    nextStep: "handoff",
  } as Parameters<typeof appendEvent>[1]);
}

/**
 * A forge that records every call. Comment/label writes succeed; reads fail —
 * except the label read-back, which a `labelAdd` this cycle made actually
 * answers, because "the label is recorded applied" is a claim about that read.
 */
function recordingForge(): { forge: Forge; calls: string[]; bodies: string[] } {
  const calls: string[] = [];
  const bodies: string[] = [];
  /** Targets this forge had `needs-human-attention` added, keyed `kind:number`. */
  const labelled = new Set<string>();
  const forge = new Proxy(
    { forge: "github", host: "github.com", owner: "a", repo: "b" } as object,
    {
      get(target, prop) {
        if (prop in target) return (target as Record<string | symbol, unknown>)[prop];
        if (prop === "then") return undefined;
        return async (...args: unknown[]) => {
          calls.push(String(prop));
          if (prop === "issueComment") {
            bodies.push(String(args[1]));
            return `https://github.com/a/b/issues/${args[0]}#issuecomment-1`;
          }
          if (prop === "labelCreate" || prop === "labelAdd") {
            if (prop === "labelAdd") {
              const kind = String(args[0]);
              labelled.add(`${kind === "mr" ? PR_KIND : kind}:${String(args[1])}`);
            }
            return undefined;
          }
          if (prop === "issueView" || prop === "prView") {
            const kind = prop === "prView" ? PR_KIND : "issue";
            return labelled.has(`${kind}:${String(args[0])}`)
              ? { labels: [{ name: "needs-human-attention" }] }
              : { labels: [] };
          }
          throw new Error(`${String(prop)} unavailable`);
        };
      },
    },
  ) as Forge;
  return { forge, calls, bodies };
}

function mkCtx(dir: string, issue: number, forge: Forge): DriverContext {
  return {
    host: fakePi,
    repoRoot: dir,
    issue,
    forge,
    dispatchFn: async (): Promise<DispatchResult> => {
      throw new Error("ops dispatch failed (simulated)");
    },
  };
}

/**
 * A state whose handoff body carries `term`: a committed worktree under the
 * scratch root, and a dispatch whose label quotes the private term (the step
 * table is the term's carrier into the render, which is why the assertions that
 * claim "no term" scope themselves to the block they are about).
 */
function refusedState(state: WorkState, dir: string, term: string): WorkState {
  state.pipelineState.handoffSnapshot = {
    modifiedFiles: [],
    unstagedCount: 0,
    stagedCount: 0,
    branchExists: true,
    branchPushed: false,
    capturedAt: 1,
    committedWork: [
      {
        worktreeId: "default",
        path: `${dir}/.worktrees/issue-default`,
        headSha: "1111111111111111111111111111111111111111",
        ahead: 2,
      },
    ],
  };
  state.eventLog.push({
    kind: "dispatch-completed",
    at: 2,
    step: "develop",
    role: "developer",
    jobId: "j",
    label: `develop mentions ${term}`,
    ms: 1_000,
  } as WorkState["eventLog"][number]);
  return state;
}

const dir = mkdtempSync(path.join(tmpdir(), "handoff-refused-"));
const conf = mkdtempSync(path.join(tmpdir(), "handoff-refused-conf-"));
const termFile = path.join(conf, "denylist");
// Synthetic term, assembled from fragments: the test asserts the refusal never
// prints it, which needs the literal in the denylist AND out of this file's text.
const term = ["example", "private", "host"].join("-");
writeFileSync(termFile, `# synthetic\n${term}\n`, "utf8");
const savedDenylist = process.env.PI_ENSEMBLE_PUBLIC_DENYLIST;
const savedChannel = process.env.PI_ENSEMBLE_HANDOFF_CHANNEL;
process.env.PI_ENSEMBLE_PUBLIC_DENYLIST = termFile;
delete process.env.PI_ENSEMBLE_HANDOFF_CHANNEL;

try {
  // ── 1. The forge channel, an ISSUE target: label applied, nothing posted.
  const { forge, calls, bodies } = recordingForge();
  const next = await runHandoff(
    mkCtx(dir, 507, forge),
    refusedState(capped(507, "verify-failed:develop"), dir, term),
    Date.now(),
  );
  const posts = calls.filter((c) => /issueComment$|prComment$/.test(c));
  assert(
    posts.length === 0 && bodies.length === 0,
    `refused: no comment posted (saw: ${posts.join(",") || "none"})`,
  );
  assert(
    calls.filter((c) => c === "labelAdd").length > 0,
    `refused: needs-human-attention IS applied — the repeat-park guard reads it (saw: ${calls.join(",")})`,
  );
  const ev = next.eventLog.find((e) => e.kind === "handoff-emitted");
  assert(
    ev?.kind === "handoff-emitted" && ev.bodyRefusal !== undefined && !ev.commentUrl,
    "refused: the event records the refusal and no comment URL",
  );
  assert(
    ev?.kind === "handoff-emitted" && typeof ev.body === "string" && ev.body.length > 0,
    "refused: the judged bytes are still carried (the host channel's only carrier)",
  );

  // ── 2. The headless result: no body, and a reason that is not the term.
  const r = projectIssue(next, "state.json");
  assert(
    r.handoff?.bodyError === "refused" && r.handoff.body === undefined,
    "refused: the result publishes no body and says why rather than printing an empty one",
  );
  const reason = r.handoff?.bodyRefusalReason ?? "";
  assert(
    reason.length > 0 && !reason.includes(term),
    `refused: the reason is the matcher's category/line and never the term (got ${JSON.stringify(reason.slice(0, 120))})`,
  );

  // ── 3. /work-status names the refusal, not a generic post failure.
  // The step-durations table carries the term (it prints the dispatch label), so
  // the claim scopes to the GitHub handoff block it is about.
  const status = renderTerminalStatus(next, dir);
  const handoffBlock = status.slice(status.indexOf("GitHub handoff:"));
  const handoffOnly = handoffBlock.split("Step durations:")[0] ?? handoffBlock;
  assert(
    status.includes("GitHub handoff:") &&
      handoffOnly.includes("handoff comment refused by the publish guard:") &&
      !handoffOnly.includes(term),
    "refused: /work-status names the refusal instead of a generic post failure, without the term",
  );
  assert(
    handoffOnly.includes("the body file was not written"),
    "refused: the operator is told the body file does not exist, rather than left to guess",
  );
  assert(
    handoffOnly.includes("needs-human-attention"),
    "refused: /work-status shows the label that arms the repeat-park guard",
  );

  // ── 4. A PR target: the comment target's label is the one the refused comment
  // would have carried, and "both targets or nothing" still holds (#1219).
  const state508 = capped(508, "verify-failed:develop");
  state508.pipelineState.prNumber = 60;
  const { forge: forge508, calls: calls508 } = recordingForge();
  const next508 = await runHandoff(
    mkCtx(dir, 508, forge508),
    refusedState(state508, dir, term),
    Date.now(),
  );
  assert(
    calls508.filter((c) => /issueComment$|prComment$/.test(c)).length === 0,
    "refused (PR target): still no comment posted",
  );
  const ev508 = next508.eventLog.find((e) => e.kind === "handoff-emitted");
  assert(
    ev508?.kind === "handoff-emitted" &&
      ev508.bodyRefusal !== undefined &&
      ev508.labelApplied === true,
    `refused (PR target): the label is recorded applied on both targets (got ${JSON.stringify({ label: ev508?.kind === "handoff-emitted" ? ev508.labelApplied : "none", issue: ev508?.kind === "handoff-emitted" ? ev508.issueLabelApplied : "none", pr: ev508?.kind === "handoff-emitted" ? ev508.prLabelApplied : "none" })})`,
  );
  assert(
    next508.pipelineState.status === "handoff",
    "refused (PR target): the cycle still ends in handoff",
  );
} finally {
  if (savedDenylist === undefined) delete process.env.PI_ENSEMBLE_PUBLIC_DENYLIST;
  else process.env.PI_ENSEMBLE_PUBLIC_DENYLIST = savedDenylist;
  if (savedChannel === undefined) delete process.env.PI_ENSEMBLE_HANDOFF_CHANNEL;
  else process.env.PI_ENSEMBLE_HANDOFF_CHANNEL = savedChannel;
  rmSync(dir, { recursive: true, force: true });
  rmSync(conf, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
