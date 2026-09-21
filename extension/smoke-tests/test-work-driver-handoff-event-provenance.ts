#!/usr/bin/env bun
/**
 * #775 (workstream `label-verify`) — end-to-end: `runHandoff` records
 * HONEST label state in the handoff-emitted event (the delivery-provenance
 * half of the #775 label-verification workstream).
 *
 * The pure builder seams (makeHandoffEmittedEvent / verifyHandoffLabel /
 * parseHandoffOpsReply) are covered in
 * `test-work-driver-handoff-event-builder.ts`; this file drives
 * `runHandoff` with a fake Forge + injected dispatchFn and asserts the
 * handoff-emitted event's `labelApplied` / `commentUrl` / `delivery` fields
 * reflect what was actually established:
 *
 *   a. an ops reply whose label the driver can VERIFY through the forge
 *      records `labelApplied: true` + `delivery: "dispatch"` (never the
 *      hard-coded false of the #775 bug);
 *   b. an ops reply whose claim the driver CANNOT verify (the label is not
 *      on the target and the fallback cannot establish it) records
 *      `labelApplied: false` — honest, never a false true;
 *   c. a failed dispatch records the FALLBACK's verified outcome +
 *      `delivery: "fallback"`;
 *   d. a failed dispatch with NO forge (true last resort) records both
 *      negative with no provenance.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Forge } from "../src/forge.ts";
import type { DispatchResult } from "../src/types.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { runHandoff } from "../src/work-driver-handoff.ts";
import { appendEvent, initialState } from "../src/workflow-state.ts";

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

function cappedState(issue: number) {
  const s = initialState(issue, 1_000_000);
  return appendEvent(s, {
    kind: "cap-hit",
    at: 1_000_400,
    cap: "step-failed:explore",
    reviewRound: 0,
    nextStep: "handoff",
  });
}

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

// 4a. Ops reply confirms the label AND the driver can verify it through the
// forge (the label IS on the target) → labelApplied: true, delivery: "dispatch".
{
  const dir = mkdtempSync(path.join(tmpdir(), "issue775-verify-"));
  try {
    const { forge } = mkFakeForge({ issueLabels: ["needs-human-attention"] });
    const ctx: DriverContext = {
      pi: fakePi,
      repoRoot: dir,
      issue: 626,
      dispatchFn: async () => ({
        role: "ops",
        ok: true,
        text: "posted and labelled.\nHANDOFF-RESULT: comment=https://github.com/acme/widget/issues/626#issuecomment-999 label=applied",
        toolUses: [],
        ms: 10,
        exitCode: 0,
        transcriptPath: "/tmp/stub.json",
      }),
      forge,
    };
    const next = await runHandoff(ctx, cappedState(626), Date.now());
    const emitted = next.eventLog.find((e) => e.kind === "handoff-emitted");
    assert(
      emitted?.kind === "handoff-emitted" && emitted.labelApplied === true,
      "runHandoff: a verified label records labelApplied: true (not the hard-coded false)",
    );
    assert(
      emitted?.kind === "handoff-emitted" && emitted.delivery === "dispatch",
      "runHandoff: state established by the dispatch records delivery: 'dispatch'",
    );
    assert(
      emitted?.kind === "handoff-emitted" &&
        emitted.commentUrl === "https://github.com/acme/widget/issues/626#issuecomment-999",
      "runHandoff: commentUrl is parsed from the ops reply",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 4b. Ops reply claims the label but the forge read shows it is NOT on the
// target (and the fallback label-add leaves it still unverifiable: the view
// throws) → labelApplied: false. Honest recording, never a false true.
{
  const dir = mkdtempSync(path.join(tmpdir(), "issue775-honest-"));
  try {
    // issueView: label absent on EVERY read — including the post-fallback
    // verification read. The dispatch's claim is unverifiable and the
    // fallback's label add throws, so the label is genuinely unestablished.
    const { forge } = mkFakeForge({ issueLabels: [] });
    let issueViewCalls = 0;
    (forge as unknown as { labelAdd: unknown }).labelAdd = async () => {
      throw new Error("label add failed (simulated)");
    };
    (forge as unknown as { issueView: unknown }).issueView = async (n: number) => {
      issueViewCalls += 1;
      if (issueViewCalls >= 2) throw new Error("view failed (simulated)");
      return {
        number: n,
        title: "t",
        body: "",
        state: "OPEN" as const,
        url: `https://github.com/acme/widget/issues/${n}`,
        author: "x",
        labels: [],
        createdAt: undefined,
        updatedAt: undefined,
      };
    };
    const ctx: DriverContext = {
      pi: fakePi,
      repoRoot: dir,
      issue: 626,
      dispatchFn: async () => ({
        role: "ops",
        ok: true,
        text: "Label applied.\nHANDOFF-RESULT: comment=https://github.com/acme/widget/issues/626#issuecomment-999 label=applied",
        toolUses: [],
        ms: 10,
        exitCode: 0,
        transcriptPath: "/tmp/stub.json",
      }),
      forge,
    };
    const next = await runHandoff(ctx, cappedState(626), Date.now());
    const emitted = next.eventLog.find((e) => e.kind === "handoff-emitted");
    assert(
      emitted?.kind === "handoff-emitted" && emitted.labelApplied === false,
      "runHandoff: an UNVERIFIED label records labelApplied: false (the reply's claim is not trusted)",
    );
    assert(
      emitted?.kind === "handoff-emitted" &&
        (emitted.delivery === undefined || emitted.delivery === "dispatch"),
      "runHandoff: the unverifiable label gains NO provenance of its own (delivery, if present, is the comment's — the label state is false and the banner still fires)",
    );
    assert(
      emitted?.kind === "handoff-emitted" &&
        emitted.commentUrl === "https://github.com/acme/widget/issues/626#issuecomment-999",
      "runHandoff: the comment URL is still recorded (independent of the label state)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 4c. Dispatch fails → the in-process fallback applies the label; the
// fallback's labelApplied IS the verified read-back (the fake flips the
// label on when labelAdd is called) → labelApplied: true, delivery: "fallback".
{
  const dir = mkdtempSync(path.join(tmpdir(), "issue775-fallback-"));
  try {
    let issueLabelPresent = false;
    const calls: { method: string; args: unknown[] }[] = [];
    const forge = {
      forge: "github" as const,
      host: "github.com",
      owner: "acme",
      repo: "widget",
      cwd: "/repo",
      issueView: async () => ({
        number: 626,
        title: "t",
        body: "",
        state: "OPEN" as const,
        url: "https://github.com/acme/widget/issues/626",
        author: "x",
        labels: issueLabelPresent
          ? [{ name: "needs-human-attention", id: 1, color: "FFAA00", description: "" }]
          : [],
        createdAt: undefined,
        updatedAt: undefined,
      }),
      prView: async () => {
        throw new Error("not used");
      },
      issueComment: async (n: number, body: string) => {
        calls.push({ method: "issueComment", args: [n, body.length > 0] });
        return `https://github.com/acme/widget/issues/${n}#issuecomment-4242`;
      },
      labelCreate: async () => undefined,
      labelAdd: async () => {
        issueLabelPresent = true; // the server-side side effect
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
    const ctx: DriverContext = {
      pi: fakePi,
      repoRoot: dir,
      issue: 626,
      dispatchFn: async (): Promise<DispatchResult> => {
        throw new Error("ops dispatch failed (simulated)");
      },
      forge,
    };
    const next = await runHandoff(ctx, cappedState(626), Date.now());
    const emitted = next.eventLog.find((e) => e.kind === "handoff-emitted");
    assert(
      emitted?.kind === "handoff-emitted" && emitted.labelApplied === true,
      "runHandoff: a dispatch failure + successful fallback records the fallback's VERIFIED labelApplied: true",
    );
    assert(
      emitted?.kind === "handoff-emitted" && emitted.delivery === "fallback",
      "runHandoff: fallback-established state records delivery: 'fallback'",
    );
    assert(
      emitted?.kind === "handoff-emitted" &&
        emitted.commentUrl === "https://github.com/acme/widget/issues/626#issuecomment-4242",
      "runHandoff: fallback-posted comment URL is recorded on the event",
    );
    assert(
      calls.some((c) => c.method === "issueComment"),
      "runHandoff: the fallback posted the comment via the forge (the dispatch never did)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 4d. Dispatch fails AND no forge (the true last resort) → both fields are
// honestly false/undefined; delivery is absent.
{
  const dir = mkdtempSync(path.join(tmpdir(), "issue775-none-"));
  try {
    const ctx: DriverContext = {
      pi: fakePi,
      repoRoot: dir,
      issue: 626,
      dispatchFn: async (): Promise<DispatchResult> => {
        throw new Error("ops dispatch failed (simulated)");
      },
      forge: undefined,
    };
    // No forge resolvable in-process either (PI_ENSEMBLE_FORGE=none).
    process.env.PI_ENSEMBLE_FORGE = "none";
    try {
      const next = await runHandoff(ctx, cappedState(626), Date.now());
      const emitted = next.eventLog.find((e) => e.kind === "handoff-emitted");
      assert(
        emitted?.kind === "handoff-emitted" && emitted.labelApplied === false,
        "runHandoff: no dispatch success + no forge → labelApplied: false (honest, not forced)",
      );
      assert(
        emitted?.kind === "handoff-emitted" && emitted.commentUrl === undefined,
        "runHandoff: no dispatch success + no forge → commentUrl undefined",
      );
      assert(
        emitted?.kind === "handoff-emitted" &&
          (!("delivery" in emitted) || emitted.delivery === undefined),
        "runHandoff: nothing established → no delivery provenance (true last resort)",
      );
    } finally {
      delete process.env.PI_ENSEMBLE_FORGE;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);

