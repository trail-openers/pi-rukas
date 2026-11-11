/**
 * The scripted Forge the handoff banner/idempotency suites share: a fake whose
 * comment list, label state, and per-method failure counts are all scripted, with
 * every call recorded. Kept out of the test files because three suites drive the
 * same fake and a second copy of it drifts.
 */

import type { Forge } from "../../src/forge.ts";

type Call = { method: string; args: unknown[] };

/** Stub methods for the Forge interface members not exercised by this test. */
const NOT_USED = async (): Promise<never> => {
  throw new Error("not used");
};

/**
 * Fake Forge with a scriptable comment list + mutable label state.
 * `labelAdd` flips `label` on (server-side side effect).
 * `labelAddFailures` / `issueCommentsFailures` script the first N calls to throw.
 *
 * #2173 — `prLabel` / `prLabelAddFailures` give the PR its OWN label state and
 * `prView` reads it back. A single boolean for both targets could not produce
 * issue-applied / PR-not, which is why no existing script ever exercised the
 * per-target fields the renderers read: the PR-only label failure is a
 * handoff-emitted shape the driver can write and no forge could forge.
 */
export function mkScriptedForge(opts: {
  comments?: { body: string; url?: string | null }[];
  label?: boolean;
  /** #2173 — the PR's initial label state (defaults to `label`). */
  prLabel?: boolean;
  labelAddFailures?: number;
  /** #2173 — script the first N PR-target `labelAdd` calls to throw. */
  prLabelAddFailures?: number;
  issueCommentsFailures?: number;
}): { forge: Forge; calls: Call[] } {
  const calls: Call[] = [];
  let label = opts.label === true;
  let prLabel = opts.prLabel ?? label;
  let labelAddAttempts = 0;
  let prLabelAddAttempts = 0;
  let issueCommentsAttempts = 0;
  const labelList = (on: boolean) =>
    on ? [{ name: "needs-human-attention", id: 1, color: "FFAA00", description: "" }] : [];
  const forge = {
    forge: "github" as const,
    host: "github.com",
    owner: "acme",
    repo: "widget",
    cwd: "/repo",
    issueView: async (n: number) => ({
      number: n,
      title: "t",
      body: "",
      state: "OPEN" as const,
      url: `https://github.com/acme/widget/issues/${n}`,
      author: "x",
      labels: labelList(label),
      createdAt: undefined,
      updatedAt: undefined,
    }),
    prView: async (n: number) => ({
      number: n,
      title: "t",
      body: "",
      state: "OPEN" as const,
      url: `https://github.com/acme/widget/pull/${n}`,
      author: "x",
      headRefName: "b",
      baseRefName: "main",
      mergeable: "TRUE" as const,
      mergeStateStatus: "CLEAN",
      labels: labelList(prLabel),
      createdAt: undefined,
      updatedAt: undefined,
    }),
    issueComment: async (n: number, body: string) => {
      calls.push({ method: "issueComment", args: [n, body] });
      return `https://github.com/acme/widget/issues/${n}#issuecomment-4242`;
    },
    prComment: async (n: number, body: string) => {
      calls.push({ method: "prComment", args: [n, body] });
      return `https://github.com/acme/widget/pull/${n}#issuecomment-4242`;
    },
    labelCreate: async (name: string, color: string) => {
      calls.push({ method: "labelCreate", args: [name, color] });
      return undefined;
    },
    labelAdd: async (target: "issue" | "mr", n: number, name: string) => {
      calls.push({ method: "labelAdd", args: [target, n, name] });
      if (target === "mr") {
        prLabelAddAttempts += 1;
        if (prLabelAddAttempts <= (opts.prLabelAddFailures ?? 0))
          throw new Error("simulated PR labelAdd hiccup");
        prLabel = true;
        return;
      }
      labelAddAttempts += 1;
      if (labelAddAttempts <= (opts.labelAddFailures ?? 0))
        throw new Error("simulated labelAdd hiccup");
      label = true;
    },
    labelRemove: async () => {},
    issueComments: async (n: number) => {
      issueCommentsAttempts += 1;
      calls.push({ method: "issueComments", args: [n] });
      if (issueCommentsAttempts <= (opts.issueCommentsFailures ?? 0))
        throw new Error("simulated read failure");
      return (opts.comments ?? []).map((c, i) => ({
        id: i + 1,
        body: c.body,
        url: c.url ?? `https://github.com/acme/widget/issues/${n}#issuecomment-${100 + i}`,
        createdAt: undefined,
      }));
    },
    prComments: NOT_USED,
    issueCreate: NOT_USED,
    issueEdit: NOT_USED,
    issueSearch: NOT_USED,
    prList: NOT_USED,
    prCreate: NOT_USED,
    prMerge: NOT_USED,
    prDiff: NOT_USED,
    prChecks: NOT_USED,
    ciWatch: NOT_USED,
    ciRun: NOT_USED,
    mergeReadiness: NOT_USED,
    repoSettings: NOT_USED,
  };
  return { forge, calls };
}
