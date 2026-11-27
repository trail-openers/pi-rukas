import type { ContinuationOutcome } from "../../src/developer-session-continuation.ts";
/**
 * smoke-tests/lib/lean-build-reask-fixture — the two #2661 knobs the build fixture cannot hold
 * itself: the per-dispatch child act, and the seam slots a re-ask case injects.
 *
 * Split from `lib/lean-build-fixture.ts` for the 500-line gate (AGENTS.md §12), along the seam that
 * module already states — the fixture BUILDS the repo and drives the step, these are the two helpers
 * the re-ask cases add. `lean-build-fixture.ts` imports and re-exports them so a case imports one
 * module, exactly as the artifact/asserts splits do.
 *
 * HARD RULE for every #2661 case: the claim is about what the RESUMED CHILD was HANDED, so a case
 * records the argument the continuation leaf actually received — its session path, bound, prompt,
 * tree and fence — the way `test-lean-review-fixer-truncation-switch.ts` records the fixer wave's
 * continuation call. The leaf arrives here as `deps.continueSession`, the SAME dependency slot
 * production fills with `spawnDeveloperContinuationChild` (`buildDeps()`), so the step's real
 * dispatch path routes the ask and the recorder sees the real object. Assertions on a fixture seam
 * upstream of that literal cannot see a dropped key — which is how the #2660 grace shipped.
 */
import type { BuildDeps } from "../../src/lean/build.ts";

/** What one continuation call received, narrowed to what these cases assert. */
export interface ContinuationCall {
  transcriptPath: string;
  role: string;
  cwd: string;
  boundMs: number;
  prompt: string;
  writeFence?: { root?: string; repo?: string; scratch?: string };
  workCycleTrust?: boolean;
}

/** The sink a case reads back: every continuation call the step made, in order. */
export type ContinuationCalls = ContinuationCall[];

/** The answer a case gives the seam. `answered()`/`silent()` below are the two shapes it needs. */
export type ContinuationAnswer = ContinuationOutcome;

/** A continuation that did the work: text, its own cost, a clean stop. */
export function answered(
  over: Partial<Extract<ContinuationOutcome, { ok: true }>> = {},
): ContinuationAnswer {
  const base: Extract<ContinuationOutcome, { ok: true }> = {
    ok: true,
    text: "implemented",
    ms: 1000,
    usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.1, turns: 1 },
  };
  const merged = { ...base, ...over };
  return merged.ok === true ? merged : base;
}

/** A continuation that answered nothing — the seam's own failure outcome, still one that was tried. */
export function silent(): ContinuationAnswer {
  return { ok: false, reason: "no-answer" };
}

/**
 * The `deps` slot a re-ask case hands the fixture: a recording leaf plus the case's own acts.
 *
 * `acts` is what the nth CHILD (0-based) does in the tree at the instant it is still working, so a
 * case can state "the first turn wrote nothing, the resumed turn wrote the file" — the ordinary
 * `child` knob fires on the first dispatch only and cannot express that. `answers` answers each
 * continuation in order; the last entry repeats when the calls outnumber the answers, so a case that
 * expects one ask states one answer.
 */
/** The re-ask knobs a case hands {@link runBuild} as one bag, so the plain build fixture carries
 *  none of them: what each child does in the tree, and any build dep the case replaces (the
 *  resumed-child seam a recording leaf stands in for). */
export type ReaskOpts = {
  childActs?: (n: number, wt: string) => void;
  deps?: Partial<BuildDeps>;
};

export function reaskDeps(opts: {
  calls: ContinuationCalls;
  acts?: (n: number, wt: string) => void;
  answers?: ContinuationAnswer[];
  /** Watches the leaf's answer for a case that wants to fail it mid-ask. */
  onCall?: (call: ContinuationCall, n: number) => void;
}): Partial<BuildDeps> {
  const acts = opts.acts ?? (() => undefined);
  return {
    // The leaf stands in for production's `spawnDeveloperContinuationChild` in the SAME dependency
    // slot `buildDeps()` fills, so the step's real dispatch path makes the call.
    continueSession: async (args): Promise<ContinuationOutcome> => {
      opts.calls.push(args as unknown as ContinuationCall);
      opts.onCall?.(args as unknown as ContinuationCall, opts.calls.length - 1);
      // The tree the resumed child was HANDED is the tree its acts belong to — the case's `acts`
      // rule runs with the leaf's own `cwd`, so an ask aimed at the wrong tree writes the wrong
      // file and the case fails on the commit, not on a fixture assumption.
      acts(-1, args.cwd);
      const answers = opts.answers ?? [];
      if (answers.length === 0) return answered();
      return answers[Math.min(opts.calls.length - 1, answers.length - 1)] ?? answered();
    },
  };
}

/** The fixture's call site of the per-dispatch act rule: the resumed child's acts (index `-1`) and
 *  the dispatched children's (0-based) all run through the same case-owned predicate. */
export function reaskActs(acts: (n: number, wt: string) => void, n: number, wt: string): void {
  acts(n, wt);
}

/**
 * The child acts for one dispatch, and whether the "first child only" act is now spent.
 *
 * Here rather than in `lean-build-fixture.ts` because a re-ask case needs a first turn that acts
 * NOWHERE and a later turn that writes the file — only a per-index rule states that, and the plain
 * build fixture has no room for it inside its own size limit. `n` is the 0-based dispatch index; the
 * resumed continuation's acts run through {@link reaskActs} at index `-1`, so a case cannot have a
 * first child act where it said it acted nowhere.
 */
export function dispatchActs(
  bag: ReaskOpts | undefined,
  child: ((wt: string) => void) | undefined,
  dispatched: number,
  alreadyActed: boolean,
  spec: { cwd?: unknown },
  built: { worktree: string },
): boolean {
  const wt = (spec.cwd as string) ?? built.worktree;
  if (bag?.childActs !== undefined) {
    reaskActs(bag.childActs, dispatched - 1, wt);
    return true;
  }
  if (!alreadyActed) child?.(wt);
  return alreadyActed || child !== undefined;
}

/** The one bag a re-ask case hands {@link runBuild}: its recording leaf, and any per-dispatch acts.
 *  A wrapper so the option's own name reads as one thing rather than a nested object literal. */
export function bag(
  deps: Partial<BuildDeps>,
  childActs?: (n: number, wt: string) => void,
): ReaskOpts {
  return { deps, ...(childActs === undefined ? {} : { childActs }) };
}
