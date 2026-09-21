#!/usr/bin/env bun
/**
 * #775 (workstream `label-verify`) — the handoff-emitted event builder
 * records HONEST label state.
 *
 * The `labelApplied` / `commentUrl` / `delivery` fields of the
 * handoff-emitted event must reflect what was actually verified, not what a
 * reply claimed and not a hard-coded default. This file covers the pure
 * builder/verification/parse seams:
 *
 *   1. `makeHandoffEmittedEvent` carries the `delivery` provenance field
 *      through to the event when given, and omits it (undefined) when not —
 *      readers treat an absent `delivery` as "unknown provenance".
 *   2. `verifyHandoffLabel` reads the label back through the forge's view
 *      seam (issueView/prView by target kind) and returns truth for a present
 *      label, false for an absent label, and false on ANY read error —
 *      never a false true.
 *   3. `parseHandoffOpsReply` parses the comment URL (shared-regex
 *      semantics) and the informational `label=applied` marker from the ops
 *      child's reply, tolerating malformed / missing markers.
 *
 * The `runHandoff` end-to-end cases (dispatch-verified / unverifiable /
 * fallback-established / no-forge last resort) live in
 * `test-work-driver-handoff-event-provenance.ts` (§12 file-size limit).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Forge } from "../src/forge.ts";
import {
  makeHandoffEmittedEvent,
  parseHandoffOpsReply,
  verifyHandoffLabel,
} from "../src/work-driver-handoff-post.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const fakePi = {
  sendUserMessage: () => undefined,
} as unknown as ExtensionAPI;
void fakePi;

/** A fake Forge with injectable label state per target + call recording. */
function mkFakeForge(opts: {
  issueLabels?: string[];
  prLabels?: string[];
  viewThrows?: boolean;
}): { forge: Forge; calls: { method: string; args: unknown[] }[] } {
  const calls: { method: string; args: unknown[] }[] = [];
  const forge = {
    forge: "github" as const,
    host: "github.com",
    owner: "acme",
    repo: "widget",
    cwd: "/repo",
    issueView: async (n: number) => {
      calls.push({ method: "issueView", args: [n] });
      if (opts.viewThrows) throw new Error("view failed (simulated)");
      return {
        number: n,
        title: "t",
        body: "",
        state: "OPEN" as const,
        url: `https://github.com/acme/widget/issues/${n}`,
        author: "x",
        labels: (opts.issueLabels ?? []).map((name) => ({
          name,
          id: 1,
          color: "FFAA00",
          description: "",
        })),
        createdAt: undefined,
        updatedAt: undefined,
      };
    },
    prView: async (n: number) => {
      calls.push({ method: "prView", args: [n] });
      if (opts.viewThrows) throw new Error("view failed (simulated)");
      return {
        number: n,
        title: "t",
        body: "",
        state: "OPEN" as const,
        url: `https://github.com/acme/widget/pull/${n}`,
        headRefName: "b",
        baseRefName: "main",
        author: "x",
        mergeable: "TRUE" as const,
        mergeStateStatus: "CLEAN",
        labels: (opts.prLabels ?? []).map((name) => ({
          name,
          id: 1,
          color: "FFAA00",
          description: "",
        })),
        createdAt: undefined,
        updatedAt: undefined,
      };
    },
    issueComment: async (n: number, body: string) => {
      calls.push({ method: "issueComment", args: [n, body.length > 0] });
      return `https://github.com/acme/widget/issues/${n}#issuecomment-4242`;
    },
    labelCreate: async (name: string, color: string) => {
      calls.push({ method: "labelCreate", args: [name, color] });
      return undefined;
    },
    labelAdd: async (target: "issue" | "mr", n: number, name: string) => {
      calls.push({ method: "labelAdd", args: [target, n, name] });
    },
    labelRemove: async () => {},
    issueCreate: async () => {
      throw new Error("not used");
    },
    issueEdit: async () => {
      throw new Error("not used");
    },
    issueSearch: async () => {
      throw new Error("not used");
    },
    prList: async () => {
      throw new Error("not used");
    },
    prCreate: async () => {
      throw new Error("not used");
    },
    prMerge: async () => {
      throw new Error("not used");
    },
    prDiff: async () => {
      throw new Error("not used");
    },
    prChecks: async () => {
      throw new Error("not used");
    },
    ciWatch: async () => {
      throw new Error("not used");
    },
    ciRun: async () => {
      throw new Error("not used");
    },
    mergeReadiness: async () => {
      throw new Error("not used");
    },
    repoSettings: async () => {
      throw new Error("not used");
    },
  } as unknown as Forge;
  return { forge, calls };
}

// ── 1. makeHandoffEmittedEvent — the `delivery` provenance field ──────────

{
  const ev = makeHandoffEmittedEvent({
    at: 1,
    commentUrl: "https://github.com/acme/widget/issues/626#issuecomment-1",
    labelApplied: true,
    handoffBodyPath: "/scratch/handoff-comment.md",
    consolidated: false,
    delivery: "dispatch",
  });
  assert(ev.delivery === "dispatch", "delivery: 'dispatch' is carried through to the event");
  assert(ev.labelApplied === true, "labelApplied: true is carried through verbatim");

  const evNoDelivery = makeHandoffEmittedEvent({
    at: 1,
    commentUrl: undefined,
    labelApplied: false,
    handoffBodyPath: "/scratch/handoff-comment.md",
    consolidated: false,
  });
  assert(
    !("delivery" in evNoDelivery) || evNoDelivery.delivery === undefined,
    "delivery is absent (not a false value) when not provided",
  );
  assert(
    evNoDelivery.labelApplied === false,
    "labelApplied: false is carried through verbatim (never forced true)",
  );

  const evFallback = makeHandoffEmittedEvent({
    at: 1,
    commentUrl: "https://github.com/acme/widget/issues/626#issuecomment-2",
    labelApplied: true,
    handoffBodyPath: "/scratch/handoff-comment.md",
    consolidated: true,
    consolidatedBranch: "feature/issue-626-x",
    consolidatedWorkstreams: ["default"],
    delivery: "fallback",
  });
  assert(evFallback.delivery === "fallback", "delivery: 'fallback' is carried through");
  assert(evFallback.consolidated === true, "consolidation fields still ride alongside delivery");
}

// ── 2. verifyHandoffLabel — read-back through the forge view seam ─────────

{
  const present = mkFakeForge({ issueLabels: ["needs-human-attention", "other"] });
  assert(
    (await verifyHandoffLabel(present.forge, "issue", 626)) === true,
    "verifyHandoffLabel: true when the label is present on the issue (issueView)",
  );

  const prPresent = mkFakeForge({ prLabels: ["needs-human-attention"] });
  assert(
    (await verifyHandoffLabel(prPresent.forge, "pr", 7)) === true,
    "verifyHandoffLabel: true when the label is present on the PR (prView)",
  );

  const absent = mkFakeForge({ issueLabels: ["some-other-label"] });
  assert(
    (await verifyHandoffLabel(absent.forge, "issue", 626)) === false,
    "verifyHandoffLabel: false when the label is absent (never a false true)",
  );

  const failing = mkFakeForge({ viewThrows: true });
  assert(
    (await verifyHandoffLabel(failing.forge, "issue", 626)) === false,
    "verifyHandoffLabel: false on a view read error (unverifiable ≠ applied)",
  );
  assert(
    (await verifyHandoffLabel(failing.forge, "pr", 7)) === false,
    "verifyHandoffLabel: false on a PR view read error",
  );
}

// ── 3. parseHandoffOpsReply — URL + informational marker ───────────────────

{
  const r1 = parseHandoffOpsReply(
    "posted it.\nHANDOFF-RESULT: comment=https://github.com/acme/widget/issues/626#issuecomment-999 label=applied",
  );
  assert(
    r1.commentUrl === "https://github.com/acme/widget/issues/626#issuecomment-999",
    "parseHandoffOpsReply: parses the comment URL from the reply",
  );
  assert(r1.labelConfirmed === true, "parseHandoffOpsReply: label=applied marker is recognized");

  const r2 = parseHandoffOpsReply("posted. https://github.com/acme/widget/issues/626#issuecomment-1");
  assert(
    r2.commentUrl === "https://github.com/acme/widget/issues/626#issuecomment-1",
    "parseHandoffOpsReply: URL parsed even without the marker (back-compat replies)",
  );
  assert(r2.labelConfirmed === false, "parseHandoffOpsReply: no marker → labelConfirmed false");

  const r3 = parseHandoffOpsReply("HANDOFF-RESULT: comment=none label=not-applied");
  assert(r3.commentUrl === undefined, "parseHandoffOpsReply: no URL in the reply → undefined");
  assert(
    r3.labelConfirmed === false,
    "parseHandoffOpsReply: label=not-applied → labelConfirmed false",
  );

  const r4 = parseHandoffOpsReply(undefined);
  assert(
    r4.commentUrl === undefined && r4.labelConfirmed === false,
    "parseHandoffOpsReply: empty reply → both negative",
  );

  const r5 = parseHandoffOpsReply(
    "earlier https://github.com/acme/widget/issues/626#issuecomment-1 later https://github.com/acme/widget/issues/626#issuecomment-2",
  );
  assert(
    r5.commentUrl === "https://github.com/acme/widget/issues/626#issuecomment-1",
    "parseHandoffOpsReply: the shared regex's first-match semantics are preserved (last-match-wins applies to the marker, not the URL)",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
