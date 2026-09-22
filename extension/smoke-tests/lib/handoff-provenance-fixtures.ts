/**
 * Shared fixtures for the `runHandoff` delivery-provenance smoke tests
 * (#775 label-verify + #798 dual-target handoff labelling).
 *
 * `mkFakeForge` / `cappedState` used to live only in
 * `test-work-driver-handoff-event-provenance.ts`; the #798 dual-target cases
 * were split out to `test-work-driver-handoff-dual-target.ts` (§12 file-size
 * split) and import them from here so a single fixture cannot drift.
 *
 * Intentionally NOT named `test-*.ts` — CI's smoke-tests glob must not
 * self-execute this (same shape as `lib/glab-arch-check.ts`); coverage
 * comes through the two test files that import it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Forge } from "../../src/forge.ts";
import { appendEvent, initialState } from "../../src/workflow-state.ts";

export const fakePi = {
  sendUserMessage: () => undefined,
} as unknown as ExtensionAPI;

export function cappedState(issue: number, prNumber?: number) {
  const s = initialState(issue, 1_000_000);
  if (prNumber !== undefined) s.pipelineState.prNumber = prNumber;
  return appendEvent(s, {
    kind: "cap-hit",
    at: 1_000_400,
    cap: "step-failed:explore",
    reviewRound: 0,
    nextStep: "handoff",
  });
}

/** A fake Forge with injectable label state per target + call recording. */
export function mkFakeForge(opts: {
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
    issueComments: async (): Promise<never> => {
      throw new Error("not used in this test");
    },
    prComments: async (): Promise<never> => {
      throw new Error("not used in this test");
    },
    prComment: async (): Promise<never> => {
      throw new Error("not used in this test");
    },
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
