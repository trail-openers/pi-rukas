/**
 * adversarial-ledger-binding — #1360: bind an `adversarial_loop` TOOL review
 * to the range and content the reviewer actually judged.
 *
 * ## The defect
 *
 * `writeAdversarialLedgerEntry` records `workingTreePatchId(workCwd)` — the
 * working tree against `merge-base(HEAD, <remote>/<mainline>)` — and takes
 * `passed` from the loop verdict alone. The reviewed `base`/`head` never enter
 * the row's identity, so an approving `adversarial_loop` review of a narrowed
 * range (`base=HEAD~1`) satisfies the #912 merge guard for the WHOLE branch:
 * the row's patch id is the full-branch identity regardless of what was
 * actually reviewed. The regression escaped because every ledger test built
 * its row by hand and never drove the real writer on the tool path.
 *
 * ## The rule (tool-path rows only)
 *
 * A row written from the `adversarial_loop` tool may record `passed: true`
 * only when all four bindings hold:
 *
 *   - **range** — the resolved `base` SHA equals
 *     `merge-base(<reviewed head>, <remote>/<mainline>)`, resolved with the
 *     same helpers `workingTreePatchId` and `mergeIdentity` use. A narrower
 *     base (`HEAD~1`), a wider base, a base on a non-mainline branch or an
 *     omitted base all fail → `range-not-branch: …`. A ref or merge-base that
 *     cannot be resolved fails → `range-unverifiable: …`.
 *   - **head** — the head SHA the approving round resolved equals `workCwd`'s
 *     HEAD when the row is written. A caller that named an older head at loop
 *     entry is `head-not-current` (nothing moved); a HEAD that changed AFTER
 *     that round's dispatch is `head-moved`.
 *   - **captured ref** — the ref the capture resolved must STILL resolve to that
 *     HEAD at write time. The two head comparisons below both use
 *     `currentHeadSha`, so a capture taken under ref A and a write made while
 *     the checkout stands at ref B match each other whenever A and B happen to
 *     name the same commit (a detached checkout of the reviewed commit, a
 *     worktree switched onto it) — and the row's patch id would come from a
 *     tree the reviewer never saw.
 *   - **tree** — the working-tree patch id captured when the approving round's
 *     diff was read equals the id at write time. Edits made after the reviewer
 *     looked at the tree are `tree-changed`.
 *
 * ## Why it fails closed
 *
 * Any other failure — a check that throws, a capture that never ran — is
 * `range-unverifiable`, never a silent skip: skipping would leave an OLDER
 * passing row as the latest one, which is exactly how a narrowed review keeps
 * satisfying the guard.
 *
 * ## Provenance
 *
 * The discriminator is the branded marker `ToolPathProvenance` — the literal
 * `"adversarial-loop-tool"` (`adversarial-loop-params.ts`) — that the tool
 * entry point (`adversarial-tool.ts`) mints AFTER the raw params spread, so a
 * caller can neither set nor clear it. The `/work` driver path (`work-driver-adversarial-fanout.ts`:
 * a `diff` string + `getDiff`, `reportVerdict: "routed"`) never sets it, keeps
 * its existing identity, and keeps recording passing rows. Provenance is never
 * inferred from the presence of a `diff` string. The driver path also runs no
 * capture at all: every git read in this module is paid for only where the
 * answer is consulted.
 *
 * ## Known residual — the lens row is NOT bound by this change
 *
 * `writeLensLedgerEntry` (`lens-ledger.ts`, driven from `lens-review.ts`) records
 * the same whole-working-tree patch identity from a range the caller also names,
 * so the narrowed-range defect above exists on the lens side too. It is
 * deliberately OUT OF SCOPE here: this module's rule applies to the
 * `adversarial_loop` row only, `lens-review*.ts` and `lens-ledger.ts` are
 * untouched, and the `dispatch_lens_review` row stays unbound. Tracked
 * separately by PM as the follow-up; until it lands, the lens half of the #912
 * gate is as strong as it was before #1360.
 */

import { execp } from "./exec.ts";
import { type IdentityBase, identityBase } from "./review-ledger-path.ts";
import type { LedgerEntry } from "./review-ledger.ts";
import { workingTreePatchId } from "./review-ledger.ts";
import { traceWarn } from "./trace.ts";
import type { VerifyExecFn } from "./work-driver-git.ts";

/** The detail prefixes a binding refusal may carry. The merge guard quotes the
 * row's detail verbatim, so the spec and the tests read these back. */
export const BINDING_REFUSAL_PREFIXES = [
  "range-not-branch",
  "range-unverifiable",
  "head-not-current",
  "head-moved",
  "tree-changed",
] as const;

/** How short a SHA renders in a detail line (the operator reads these). */
const SHORT = 8;

/** Why a tool-path row may not record a passing review. `detail` is what the
 * row stores and what the guard's refusal quotes. */
export interface BindingDecision {
  ok: boolean;
  detail?: string;
}

/** The range the review actually covered, as resolved SHAs. */
export interface ReviewedRange {
  reviewedBase?: string;
  reviewedHead?: string;
}

/** Everything captured about the range/content one round judged. */
export interface LedgerBinding extends ReviewedRange {
  /** The working-tree patch id when that round's diff was read. */
  reviewedTreePatchId?: string;
  /** The ref the round reviewed HEAD resolved from, as the caller named it
   * (`headAtCapture === currentHead` means the head was named `HEAD` — or left
   * out, which means the same thing — so a moved HEAD is `head-moved`, not
   * `head-not-current`). */
  reviewedHeadRef?: string;
  /** workCwd's HEAD at that same moment — the commit `reviewedTreePatchId`
   * describes. */
  headAtCapture?: string;
  /** Set when the capture itself could not complete — a check that cannot run
   * is never a pass. */
  bindingUnavailable?: string;
}

/** One of the refusal prefixes this module is allowed to emit — the same array
 * the merge guard's renderer and the tests read, so a refusal the guard does
 * not recognise as a binding refusal cannot be constructed. */
export type BindingRefusalPrefix = (typeof BINDING_REFUSAL_PREFIXES)[number];

/** The shape `identityBase` returns on failure. Declared so the discriminated
 * union below (and its narrowing) type-checks without re-declaring the return
 * type at two sites. */
type IdentityBaseFailure = { ok: false; reason: string };

/** Narrow an `identityBase` answer that a caller may have pre-resolved. Checks
 * the fields rather than an `ok` flag so a threaded `{remote, mainline}` and a
 * freshly resolved `{ok: true, remote, mainline}` take the same path. */
function isIdentityBase(value: IdentityBase | IdentityBaseFailure): value is IdentityBase {
  const candidate = value as Partial<IdentityBase>;
  return typeof candidate.remote === "string" && typeof candidate.mainline === "string";
}

/** Refuse a tool-path row, naming why. One shape for every refusal so the
 * detail the guard quotes is never built two different ways. */
function refuse(prefix: BindingRefusalPrefix, reason: string): BindingDecision {
  return { ok: false, detail: `${prefix}: ${reason}` };
}

/** `git rev-parse --verify --quiet <ref>^{commit}`, argv form (no shell
 * interpolation) and bounded like every other review git read. A leading dash
 * is refused up front — git would read it as an option. THROWS on a git
 * failure; callers turn a throw into `range-unverifiable`. */
async function revParse(cwd: string, ref: string, execFn: VerifyExecFn): Promise<string> {
  if (ref.startsWith("-")) throw new Error(`ref "${ref}" is rejected: leading '-'`);
  const { stdout } = await execFn("git", {
    cwd,
    argv: ["-C", cwd, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    maxBuffer: 8 * 1024,
    timeout: 30_000,
  });
  return stdout.trim();
}

/** `git merge-base <a> <b>` (argv form). THROWS on a git failure; an empty
 * answer means the two histories share no ancestor. */
async function mergeBaseOf(
  cwd: string,
  a: string,
  b: string,
  execFn: VerifyExecFn,
): Promise<string> {
  const { stdout } = await execFn("git", {
    cwd,
    argv: ["-C", cwd, "merge-base", a, b],
    maxBuffer: 8 * 1024,
    timeout: 30_000,
  });
  return stdout.trim();
}

/**
 * The range check: the resolved base SHA must equal
 * `merge-base(<reviewed head>, <remote>/<mainline>)` — the base
 * `workingTreePatchId` takes the row's patch id against, so a passing tool
 * row's identity is provably the diff the reviewer read.
 *
 * It is the REVIEWED head in that merge-base, not the worktree's current HEAD
 * (`workingTreePatchId` itself uses `HEAD`). When the two differ the row's
 * identity is computed against a range nobody reviewed, so no verdict can be
 * attributed to it and the row is refused — which is exactly the narrowing this
 * issue is about: a caller who passes `base=HEAD~1` for a two-commit branch
 * cannot satisfy the gate whatever else matches, because the base they name is
 * not the base the identity came from.
 *
 * `mainline` is the identity base (`identityBase`, review-ledger-path.ts — the
 * same `{remote, mainline}` pair `workingTreePatchId` takes the patch id
 * against), resolved by the CALLER once and threaded in. Resolving it here
 * instead would give the range check and the patch id two separate answers to
 * "which ref is the mainline", and a `trunk`/`develop` repo is where that
 * disagreement would show up.
 *
 * Resolves refs and the merge-base only; it never reads a diff, so it adds no
 * size limit. Every failure is a refusal with a named reason.
 */
export async function reviewRangeDecision(
  cwd: string,
  baseRef: string | undefined,
  headRef: string,
  mainline: IdentityBase,
  execFn: VerifyExecFn = execp,
): Promise<BindingDecision & ReviewedRange> {
  if (!baseRef || !baseRef.trim()) {
    return refuse("range-not-branch", "no base was reviewed, so the branch range was not reviewed");
  }
  const mainlineRef = `${mainline.remote}/${mainline.mainline}`;
  let resolvedBase = "";
  let resolvedHead = "";
  let mergeBase = "";
  try {
    resolvedBase = await revParse(cwd, baseRef, execFn);
    resolvedHead = await revParse(cwd, headRef, execFn);
    if (!resolvedBase || !resolvedHead) {
      const missing = resolvedBase ? headRef : baseRef;
      return refuse("range-unverifiable", `${missing} does not resolve to a commit`);
    }
    mergeBase = await mergeBaseOf(cwd, mainlineRef, resolvedBase, execFn);
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 120);
    return refuse("range-unverifiable", `git could not compute the branch range (${msg})`);
  }
  if (!mergeBase) {
    return refuse(
      "range-unverifiable",
      `no merge-base between ${resolvedBase.slice(0, SHORT)} and ${mainlineRef}`,
    );
  }
  if (mergeBase !== resolvedBase) {
    return refuse(
      "range-not-branch",
      `reviewed ${resolvedBase.slice(0, SHORT)}..${resolvedHead.slice(0, SHORT)}, ` +
        `branch range is ${mergeBase.slice(0, SHORT)}..${resolvedHead.slice(0, SHORT)}`,
    );
  }
  return { ok: true, reviewedBase: resolvedBase, reviewedHead: resolvedHead };
}

/**
 * Which head refusal a mismatch is. A caller that NAMED an explicit head —
 * anything other than `HEAD`, a mainline ref, or an omitted head, all of which
 * mean "the current tip" — and got a commit that is not the worktree HEAD never
 * had the tip under review: nothing moved, the review simply was not of it
 * (`head-not-current`). Everything else — a review of `HEAD` whose worktree HEAD
 * has since changed — is `head-moved`.
 *
 * The name is read as written (empty/`HEAD` = tip), deliberately without
 * resolving it first: resolving `headRef` again is what produced the compared
 * SHA in the first place, and asking "did the tip move?" of a ref that already
 * resolved to the tip would be the wrong question — that case never reaches
 * this function, since the two SHAs match.
 *
 * "The tip" is spelled from the RESOLVED mainline, not from a hardcoded
 * `main`/`master`: on a `trunk`- or `develop`-based repo a caller who names the
 * mainline by name (or as `<remote>/<mainline>`) means the current tip exactly
 * as much as one who writes `HEAD`, and calling that `head-not-current` would
 * refuse a review of the tip.
 */
function headPrefix(
  reviewedHeadRef: string | undefined,
  mainline: IdentityBase,
): BindingRefusalPrefix {
  return namedHeadIsTip(reviewedHeadRef, mainline) ? "head-moved" : "head-not-current";
}

/** Whether a ref the caller named is one of the ways of saying "the commit I am
 * standing on": `HEAD`, the mainline, or `<remote>/<mainline>` on a repo whose
 * mainline is not `main`/`master`. #1360 lens 2: the writer used to string-match
 * `main`/`master` here, so on a `trunk` or `develop` repo a tip-named head was
 * refused `head-not-current` for a review that WAS of the tip.
 *
 * Exported because the WRITER decides which head the binding compares against and
 * has to make the same call from the same rule — two copies would drift, and the
 * drift is a refusal an honest review cannot explain. `headPrefix` above is the
 * only other reader, and it is in this file. */
export function namedHeadIsTip(
  named: string | undefined,
  mainline: IdentityBase | undefined,
): boolean {
  if (named === undefined || named === "HEAD" || named === "") return true;
  if (!mainline) return false;
  return named === mainline.mainline || named === `${mainline.remote}/${mainline.mainline}`;
}

/**
 * Decide the `passed` boolean and `detail` for a tool-path adversarial row.
 *
 * Fail-closed: any check that cannot complete refuses the row with
 * `range-unverifiable`, and the caller still writes it — a silent skip would
 * leave an older passing row as the latest one.
 */
export async function decideToolPathRow(opts: {
  workCwd: string;
  baseRef?: string;
  headRef?: string;
  binding: LedgerBinding;
  /** The row's write-time working-tree patch id. */
  currentTreePatchId: string;
  /** The row's write-time HEAD SHA ("" when unresolvable). */
  currentHeadSha: string;
  /** #1360 — set ONLY when the caller's `head` names a ref that does not
   * resolve to the checkout's tip: the review is of some other commit, and the
   * head check must refuse it `head-not-current` rather than forgiving it as "the
   * HEAD simply moved". Absent means the caller named the tip (`HEAD`, the
   * mainline, or nothing), so a mismatch there is a moved HEAD. The WRITER
   * decides this by resolving the named ref and comparing — not by string
   * matching the name, which is what made a `trunk`/`develop` repo read a
   * tip-named head as a moved one. */
  namedHeadSha?: string;
  /** The ref the caller named, for the refusal's wording. */
  namedHeadRef?: string;
  /** OPTIONAL only because a direct caller (or a test) may leave it out; every
   * production writer resolves it once via `identityBase` and threads it in,
   * because it is the SAME pair the patch id was taken against. Absent, this
   * function resolves it itself — one extra pair of git reads, same answer. */
  mainline?: IdentityBase;
  execFn?: VerifyExecFn;
}): Promise<BindingDecision & ReviewedRange> {
  const execFn = opts.execFn ?? execp;
  const { binding } = opts;
  const headRef = opts.headRef ?? "HEAD";
  if (binding.bindingUnavailable) {
    return refuse("range-unverifiable", binding.bindingUnavailable);
  }
  if (!opts.currentHeadSha) {
    return refuse(
      "range-unverifiable",
      "workCwd's HEAD could not be resolved, so the reviewed head cannot be bound",
    );
  }
  // Threaded in by the writer (the same pair its patch id came from); resolved
  // here only for a direct caller that did not thread it.
  let mainline: IdentityBase;
  if (opts.mainline) {
    mainline = opts.mainline;
  } else {
    const resolved = await identityBase(execFn, opts.workCwd);
    if (!isIdentityBase(resolved)) return refuse("range-unverifiable", resolved.reason);
    mainline = resolved;
  }
  const range = await reviewRangeDecision(opts.workCwd, opts.baseRef, headRef, mainline, execFn);
  if (!range.ok) return range;
  // The compared head is the commit the row's identity was taken from — the
  // worktree's own HEAD at capture time — never whatever ref the caller named.
  // Comparing the caller's ref instead would let a review of an older commit
  // match its own stale capture and pass on an identity it never covered.
  if (!binding.headAtCapture) {
    return refuse("range-unverifiable", "the reviewed head was never resolved");
  }
  // A caller that named a ref resolving somewhere other than the checkout's tip
  // reviewed a different commit; that is a refusal its own argument caused, and
  // it is refused whatever the capture says, because a capture taken against that
  // older commit would otherwise match itself and pass on an identity covering
  // nothing the merge is about to ship.
  if (opts.namedHeadSha !== undefined && binding.headAtCapture !== opts.namedHeadSha) {
    return refuse(
      "head-not-current",
      `reviewed ${binding.headAtCapture}, ${opts.namedHeadRef ?? "the named head"} is ${opts.namedHeadSha}`,
    );
  }
  if (binding.headAtCapture !== opts.currentHeadSha) {
    return refuse(
      headPrefix(binding.reviewedHeadRef, mainline),
      `reviewed ${binding.headAtCapture}, workCwd at ${opts.currentHeadSha}`,
    );
  }
  // #1360 round 3 — the write must re-resolve the SAME ref the capture resolved.
  // The two checks above both compare against `currentHeadSha`, so a capture
  // taken under ref A and a write made while the checkout stands at ref B pass
  // each other whenever A and B happen to name the same commit — a detached
  // checkout of the reviewed commit, or a worktree switched to it while the
  // branch moved on. The row's patch id would then be taken from a tree the
  // reviewer never saw. `reviewedHeadRef` is only recorded when the range check
  // resolved a head, so its absence is the never-captured case, not this one.
  if (binding.reviewedHeadRef !== undefined) {
    let capturedRefSha = "";
    try {
      capturedRefSha = await revParse(opts.workCwd, binding.reviewedHeadRef, execFn);
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).slice(0, 120);
      return refuse(
        "range-unverifiable",
        `the captured head ref ${binding.reviewedHeadRef} could not be re-resolved (${msg})`,
      );
    }
    // A capture that resolved one of the tip's spellings can only have resolved
    // the tip itself — which is exactly the SHA the two comparisons above just
    // confirmed equals `currentHeadSha`. Re-reading the ref would ask whether
    // `<remote>/<mainline>` still names the local tip, and a branch ahead of its
    // own remote ref (unpushed, or pushed between the round and the write) is a
    // review OF the tip, not a stale capture. So the spelling is accepted on the
    // rule that produced it (`namedHeadIsTip`), not on a second git read; a ref
    // that is not a tip-spelling is still re-resolved and still refused.
    if (
      !namedHeadIsTip(binding.reviewedHeadRef, mainline) &&
      capturedRefSha !== opts.currentHeadSha
    ) {
      return refuse(
        "head-not-current",
        `the captured head ref ${binding.reviewedHeadRef} is ${capturedRefSha || "unresolvable"}, workCwd is ${opts.currentHeadSha}`,
      );
    }
  }
  if (!binding.reviewedTreePatchId) {
    return refuse("range-unverifiable", "the reviewed working-tree identity was never captured");
  }
  if (binding.reviewedTreePatchId !== opts.currentTreePatchId) {
    return refuse(
      "tree-changed",
      `reviewed ${binding.reviewedTreePatchId}, now ${opts.currentTreePatchId}`,
    );
  }
  // Both stored SHAs are the ones THIS function resolved and compared, never
  // the capture's own (#1360 lens 3): a capture is what a round recorded, this
  // decision is what the module confirmed. Echoing `binding.reviewedHead` (or
  // `.reviewedBase`) would let a capture that named a different commit — stale,
  // truncated, or simply another round's — land on the row as though the range
  // check had vouched for it. The head that survived the comparison above is
  // `currentHeadSha`; the base that survived is the merge-base `range` computed.
  return { ok: true, reviewedBase: range.reviewedBase, reviewedHead: opts.currentHeadSha };
}

/** The #1360 identifiability fields a tool-path row stores. Empty for a row
 * not written from the tool path — the driver's rows keep their existing shape. */
export function toolPathFields(
  binding: LedgerBinding,
  fromToolPath: boolean,
): Pick<LedgerEntry, "reviewedBase" | "reviewedHead"> {
  if (!fromToolPath) return {};
  const fields: Pick<LedgerEntry, "reviewedBase" | "reviewedHead"> = {};
  if (binding.reviewedBase) fields.reviewedBase = binding.reviewedBase;
  if (binding.reviewedHead) fields.reviewedHead = binding.reviewedHead;
  return fields;
}

/**
 * Capture the bindings for one round: the range check plus the working-tree
 * identity at the moment the round's diff was read, and the HEAD that identity
 * describes.
 *
 * Every git read here is best-effort for the CAPTURE — a throw records
 * `bindingUnavailable` rather than failing the loop, because the reviewer's own
 * diff read is what a round actually needs. The fail-closed rule lives in the
 * DECISION (`decideToolPathRow`), where a missing capture is a refusal.
 *
 * Callers gate on provenance: only the tool path consults the result, so only
 * the tool path calls this. On the driver path it is not "taken and thrown
 * away" — it is never called, and the loop spends no git subprocess on it.
 */
export async function captureBinding(
  cwd: string,
  baseRef: string | undefined,
  headRef: string | undefined,
  execFn: VerifyExecFn = execp,
): Promise<LedgerBinding> {
  try {
    const head = headRef ?? "HEAD";
    const base = await identityBase(execFn, cwd);
    if (!base.ok) return { bindingUnavailable: base.reason };
    const range = await reviewRangeDecision(cwd, baseRef, head, base, execFn);
    const [headOfTree, computed] = await Promise.all([
      // The TIP, always — never the ref the caller named. `workingTreePatchId`
      // takes the row's identity from the worktree's own HEAD, so the captured
      // head must be the same commit or the write-time comparison would
      // compare the identity against a commit it was never taken from: a
      // caller who named an older head explicitly would then look like a
      // matching review and pass on a diff nobody read.
      revParse(cwd, "HEAD", execFn),
      workingTreePatchId(execFn, cwd),
    ]);
    return {
      ...(range.reviewedBase ? { reviewedBase: range.reviewedBase } : {}),
      ...(range.reviewedHead ? { reviewedHead: range.reviewedHead } : {}),
      ...(computed.patchId ? { reviewedTreePatchId: computed.patchId } : {}),
      reviewedHeadRef: head,
      ...(headOfTree ? { headAtCapture: headOfTree } : {}),
      ...(!computed.patchId
        ? {
            bindingUnavailable:
              computed.warning ?? "the working-tree patch id could not be computed",
          }
        : {}),
    };
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 120);
    traceWarn(`adversarial: ledger binding capture failed: ${msg}`);
    return { bindingUnavailable: `the range/head capture threw (${msg})` };
  }
}
