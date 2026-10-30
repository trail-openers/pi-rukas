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
  /**
   * What `prView` reports for a number the step REUSED, overriding the row the
   * `prList` reply carries. Models the split the real CLI has: `gh pr list
   * --json` does not carry `isDraft`, `gh pr view --json …,isDraft,…` does.
   */
  viewIsDraft?: Map<number, boolean>;
  /** Numbers the step asked to read (the list reply carries no `isDraft`). */
  prViewCalls: number[];
  /** Make `prView` reject — the forge cannot tell the step anything. */
  viewThrows: boolean;
  /**
   * Make `prView` reject for these numbers only. The read-back after a `prDraft`
   * goes through the same `prView` as the first read, so a case that wants the
   * FORGE to answer once and then go dark on the confirmation has to be able to
   * fail just the second call — which is what the read-back's error text exists
   * to report.
   */
  viewThrowsFor?: number[];
  /** Make `prDraft` reject — the forge refuses to put a reused PR back to draft. */
  draftThrows: boolean;
  /**
   * What `prView` reports for each number after a `prDraft`, overriding the PR's
   * own `isDraft` — the seam for a forge that accepted the call and left the PR
   * ready. `undefined` (the default) reports the state the PR carries.
   */
  afterDraft?: Map<number, boolean | undefined>;
  /**
   * What `prView` reports for a number the step has just CREATED, overriding
   * what `prCreate` returned — the seam for `gh pr create --json`, which carries
   * no `isDraft`: a forge that made a draft and reports it ready (or reports
   * nothing) becomes a testable behaviour rather than an imagined one.
   */
  afterCreate?: Map<number, boolean | undefined>;
  prs: NormalizedPullRequest[];
  /**
   * The PRs `prCreate` made: readable by `prView`, invisible to `prList`, so a
   * create case cannot turn into a reuse case by the fake listing its own output.
   */
  created: NormalizedPullRequest[];
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
    viewIsDraft: undefined,
    viewThrows: false,
    viewThrowsFor: undefined,
    draftThrows: false,
    prs: [],
    created: [],
    listThrows: false,
    afterCreate: undefined,
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
    if (f.viewThrows || f.viewThrowsFor?.includes(n))
      throw new Error("forge: prView could not reach the host");
    // `gh pr list --json` carries no `isDraft`; `gh pr view --json …,isDraft,…`
    // is the only reply that does. So a reused PR whose state the list row does
    // not carry gets it from the SEED (`viewIsDraft`), and the state itself then
    // lives on the forge's row like any other: a `prDraft` flips it, and the
    // step's read-back afterwards sees the flip rather than a stale answer.
    // `afterCreate`/`afterDraft` are the lies layered on top — "made a draft and
    // reports it ready", "accepted prDraft and left it ready".
    const seed =
      f.prDraftCalls.length === 0 && f.viewIsDraft?.has(n) === true
        ? f.viewIsDraft.get(n)
        : undefined;
    if (seed !== undefined) {
      const row = f.prs.find((pr) => pr.number === n) ?? f.created.find((pr) => pr.number === n);
      if (row !== undefined) row.isDraft = seed;
    }
    const answer = (pr: NormalizedPullRequest): NormalizedPullRequest =>
      f.prDraftCalls.includes(n) && f.afterDraft !== undefined && f.afterDraft.has(n)
        ? { ...pr, isDraft: f.afterDraft.get(n) }
        : f.afterCreate?.has(n) === true
          ? { ...pr, isDraft: f.afterCreate.get(n) }
          : pr;
    const reusable = f.prs.find((pr) => pr.number === n);
    if (reusable !== undefined) return answer(reusable);
    const made = f.created.find((pr) => pr.number === n);
    if (made === undefined) throw new Error(`forge: no PR #${n}`);
    return answer(made);
  };
  f.prDraft = async (n: number) => {
    f.prDraftCalls.push(n);
    if (f.draftThrows) throw new Error("forge: prDraft could not reach the host");
    // A successful re-draft is a STATE CHANGE the fake has to keep: the step
    // reads the PR back afterwards, and a fake still reporting it ready would
    // make every honest run look like the lie the read-back exists to catch.
    const kept = f.prs.find((pr) => pr.number === n) ?? f.created.find((pr) => pr.number === n);
    if (kept !== undefined) kept.isDraft = true;
  };
  f.prCreate = async (
    title: string,
    headBranch: string,
    body: string,
    opts?: { draft?: boolean },
  ): Promise<NormalizedPullRequest> => {
    f.prCreateCalls.push({ title, head: headBranch, body, draft: opts?.draft });
    // The step's `draft` argument is a real state change, so the row the fake
    // keeps carries it: `gh pr create --draft` makes a draft, and `prView` must
    // then report one. `afterCreate` lets a case override the ANSWER and make
    // the forge report the opposite of what it was asked (`isDraft: false` over
    // a requested draft) — the lie the step's read-back exists to catch.
    const created = fakePr(77, "https://forge.example/pull/77", headBranch, opts?.draft === true);
    f.created.push(created);
    // What `prCreate` HANDS BACK carries no `isDraft` at all, because that is
    // what the real adapter returns: `gh pr create` issues
    // `--json number,title,state,url` and `isDraft` is absent from that reply
    // (only `gh pr view --json …,isDraft,…` carries it). So the create reply is
    // not an answer to "is it a draft" — a step that records the state must ask
    // `prView`, which is the only reply that can tell it.
    // The row stays OUT of `prs` on purpose: a step that found a PR on the
    // branch would REUSE it instead of creating one, and every create case would
    // silently become a reuse case.
    const { isDraft: _none, ...asCreated } = created;
    return asCreated as NormalizedPullRequest;
  };
  return f;
}
