/**
 * lib/lean-publish-forge — the recording fake forge the `lean/publish` smoke
 * tests hand the step instead of a real adapter.
 *
 * Split out of `lean-publish-fixture.ts` (which was past the file-size cap) along
 * the seam the step itself already has: `PublishDeps.forge` is one lookup, and
 * this file is what that lookup returns. It records every call so a case asserts
 * on what the step ASKED rather than on a transcript, and it answers whatever
 * the case loaded into it — including the two shapes a real forge answers with and
 * a well-typed stub would not: a PR row whose `state` is not one of the union
 * members, and a `prDraft` that returned without changing anything.
 */
import type { NormalizedPullRequest } from "../../src/forge-types.ts";

/** A PR in the shape the forge adapter returns, with just the fields publish reads. */
export function fakePr(
  number: number,
  url: string,
  headRefName: string,
  isDraft?: boolean,
): NormalizedPullRequest {
  return {
    number,
    title: "t",
    body: "",
    state: "OPEN",
    url,
    headRefName,
    baseRefName: "main",
    author: undefined,
    mergeable: null,
    mergeStateStatus: null,
    isDraft,
    labels: [],
    createdAt: undefined,
    updatedAt: undefined,
  };
}

/**
 * A PR row whose `state` the fake reports outside the `PullRequestState` union —
 * the seam for `mapPrListReply`'s `state: ""` row (a forge that answered with one
 * bare number) and for an adapter that hands back `"open"`/`"Open"`. The publish
 * step's open-PR check must fail CLOSED on every value that is not CLOSED/MERGED.
 */
export function prWithState(
  number: number,
  url: string,
  headRefName: string,
  state: string,
): NormalizedPullRequest {
  return { ...fakePr(number, url, headRefName), state: state as NormalizedPullRequest["state"] };
}

/** What the fake forge recorded, so a case asserts on calls rather than vibes. */
export interface FakeForge {
  prListCalls: number;
  prCreateCalls: { title: string; head: string; body: string; draft?: boolean }[];
  /** Numbers the step asked the forge to put back to draft. */
  prDraftCalls: number[];
  /** Numbers the step asked to read (the list reply carries no `isDraft`). */
  prViewCalls: number[];
  /** Make `prView` reject — the forge cannot tell the step anything. */
  viewThrows: boolean;
  /** Make `prDraft` reject — the forge refuses to put a reused PR back to draft. */
  draftThrows: boolean;
  /**
   * What `prView` reports for each number after a `prDraft`, overriding the PR's
   * own `isDraft` — the seam for a forge that accepted the call and left the PR
   * ready. `undefined` (the default) reports the state the PR carries.
   */
  afterDraft?: Map<number, boolean | undefined>;
  prs: NormalizedPullRequest[];
  listThrows: boolean;
  prList: (opts?: { state?: string; sourceBranch?: string }) => Promise<NormalizedPullRequest[]>;
  prView: (number: number) => Promise<NormalizedPullRequest>;
  prDraft: (number: number) => Promise<void>;
  prCreate: (
    title: string,
    headBranch: string,
    body: string,
    opts?: { baseBranch?: string; draft?: boolean },
  ) => Promise<NormalizedPullRequest>;
}

/** The fake forge: it records, and it answers whatever the case loaded into it. */
export function fakeForge(
  over: Partial<Omit<FakeForge, "prList" | "prView" | "prDraft" | "prCreate">> = {},
): FakeForge {
  const f: FakeForge = {
    prListCalls: 0,
    prCreateCalls: [],
    prDraftCalls: [],
    prViewCalls: [],
    viewThrows: false,
    draftThrows: false,
    prs: [],
    listThrows: false,
    // Placeholders, assigned just below: the methods close over `f` itself, so
    // they cannot appear in the object literal that creates `f`.
    prList: async () => [],
    prView: async (n) => fakePr(n, "https://forge.example/none", "none"),
    prDraft: async () => {},
    prCreate: async () => fakePr(0, "https://forge.example/none", "none"),
    ...over,
  };
  f.prList = async () => {
    f.prListCalls++;
    if (f.listThrows) throw new Error("forge: prList could not reach the host");
    return f.prs;
  };
  f.prView = async (n: number) => {
    f.prViewCalls.push(n);
    if (f.viewThrows) throw new Error("forge: prView could not reach the host");
    const found = f.prs.find((pr) => pr.number === n);
    if (found === undefined) throw new Error(`forge: no PR #${n}`);
    // A PR the step has just asked to draft is reported as the case put there,
    // which is what makes "the forge accepted prDraft and left it ready" a
    // testable behaviour rather than an imagined one.
    if (f.prDraftCalls.includes(n) && f.afterDraft !== undefined && f.afterDraft.has(n))
      return { ...found, isDraft: f.afterDraft.get(n) };
    return found;
  };
  f.prDraft = async (n: number) => {
    f.prDraftCalls.push(n);
    if (f.draftThrows) throw new Error("forge: prDraft could not reach the host");
    // A successful re-draft is a STATE CHANGE the fake has to keep: the step
    // reads the PR back afterwards, and a fake still reporting it ready would
    // make every honest run look like the lie the read-back exists to catch.
    const found = f.prs.find((pr) => pr.number === n);
    if (found !== undefined) found.isDraft = true;
  };
  f.prCreate = async (
    title: string,
    headBranch: string,
    body: string,
    opts?: { draft?: boolean },
  ): Promise<NormalizedPullRequest> => {
    f.prCreateCalls.push({ title, head: headBranch, body, draft: opts?.draft });
    return fakePr(77, "https://forge.example/pull/77", headBranch);
  };
  return f;
}
