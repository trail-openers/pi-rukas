/**
 * work-driver-handoff-subject — #810: derive a consolidation commit subject
 * that describes the CHANGE, not the driver's housekeeping step.
 *
 * When a cycle parks, the handoff consolidates its workstream work onto the
 * feature branch. If the operator later recovers that branch and it holds
 * exactly one commit, GitHub's squash-merge uses that commit's message — not
 * the PR title — so the driver's subject becomes the permanent record of the
 * change. release-please derives the version bump and the changelog from that
 * subject, so a `fix:` that landed as `chore(handoff): …` produces no bump and
 * no changelog entry (the #810 incident: PR #801).
 *
 * The fix is at the source: the consolidation commit carries a subject derived
 * from the ISSUE itself. The issue's conventional-commit type and scope are
 * the only reliable signal of what kind of change shipped — `NormalisedSpec`
 * holds neither a type nor the title (it holds an intent, a verdict, and the
 * deliverables), so the derivation parses the conventional prefix off the
 * issue's OWN title (the same shape the PR title carries) and falls back to
 * an honest `chore` when the type is genuinely unclear.
 *
 * #818 extends this single shared parser to the commit-pr path: the PR and
 * commit title are derived through the SAME `deriveConsolidationSubject`
 * (never a second parser, so consolidation and commit-pr cannot disagree),
 * and the plan-driver prefixes it emits (`Bug:`, `EPIC:`, `research:`, …)
 * map to the conventional type the change actually ships — `Bug:` → `fix`,
 * not `chore`.
 */

/** The conventional-commit types release-please actually bumps for. */
const BUMP_TYPES = new Set(["feat", "fix", "perf", "refactor", "docs", "build"]);

/**
 * The FULL conventional-commit type vocabulary (#818): every type the
 * driver's own commit convention (AGENTS.md §9) produces. A title carrying
 * ANY of these prefixes keeps its type verbatim — `chore: X` is no longer
 * collapsed and a `docs:` change is no longer relabelled, so the derived
 * subject cannot misdescribe the change. The plan-driver prefixes below map
 * into the same vocabulary.
 */
const CONVENTIONAL_TYPES = new Set([
  "feat",
  "fix",
  "perf",
  "refactor",
  "docs",
  "build",
  "style",
  "test",
  "ci",
  "chore",
  "revert",
]);

/**
 * The plan-driver prefixes that are NOT conventional types (the TITLE_PREFIX
 * map in plan-types.ts) and what kind of change each one actually ships
 * (#818): a `Bug:` that lands as `chore:` produces no version bump and no
 * changelog entry — the #818 incident, where #771/#809 landed as
 * `implement issue #N` instead of a `fix:`. Research/spikes stay honest
 * `chore` — mapping them to a bump type would manufacture bumps for
 * exploratory work.
 */
const PLAN_DRIVER_PREFIXES: Record<string, string> = {
  bug: "fix",
  feature: "feat",
  epic: "feat",
  research: "chore",
  spike: "chore",
};

/**
 * The conventional-commit prefix at the START of an issue title.
 *
 * Matches the shape AGENTS.md §9 requires for commit subjects —
 * `type:`, `type!:` and `type(scope):` — so `fix(work): restore …` in a
 * title maps to `fix`/`work` and `feat: add …` maps to `feat`. A title that
 * does not begin with a recognized prefix (a typo, a question, prose)
 * returns `{ type: null, raw: title }` so the caller falls back to an
 * honest `chore` rather than inventing a `fix:` to satisfy release-please.
 *
 * #818 — the prefix set now also recognises the plan-driver prefixes
 * (`Bug:`, `Feature:`, `EPIC:`, `research:`, `spike:`, case-insensitive),
 * returned as their bare lowercase name; the type MAPPING for those
 * happens in `deriveConsolidationSubject` (PLAN_DRIVER_PREFIXES), so this
 * parser stays a pure extractor.
 *
 * The trailing `!` is captured as a separate `breaking` flag so the caller
 * can (a) decide the bump type by the BARE type (`feat` is bumping even in
 * `feat!`) and (b) re-attach the marker to the subject it emits — a derived
 * subject must not drop a breaking marker the issue declares, and one is
 * never ADDED (see `deriveConsolidationSubject`).
 */
export function parseConventionalTitle(title: string): {
  type: string | null;
  scope: string | undefined;
  description: string;
  breaking: boolean;
  raw: string;
} {
  // `type` is the BARE lowercase prefix when the title begins with a
  // conventional type or a known plan-driver prefix; anything else (a
  // `spike:`-ish typo, a question, prose) returns `{ type: null, raw }`.
  const m = title.match(
    /^(feat|fix|perf|refactor|docs|build|style|test|ci|chore|revert|bug|feature|epic|research|spike)(!)?(\(([^)]*)\))?:\s*(.+)$/i,
  );
  if (!m) {
    return { type: null, scope: undefined, description: "", breaking: false, raw: title.trim() };
  }
  const type = m[1]?.toLowerCase() ?? null;
  const scope = m[4]?.trim() || undefined;
  const description = (m[5] ?? "").trim();
  return { type, scope, description, breaking: m[2] === "!", raw: title.trim() };
}

/**
 * Derive the consolidation/commit-pr commit subject from the issue title.
 *
 * Rules (each maps to an acceptance criterion / edge case in #810/#818):
 *
 *  - **Real work only.** The caller invokes this only when real change is
 *    present (a non-empty staged diff). A no-op consolidation produces no
 *    commit at all, so this never fires for "parked before producing a
 *    change" — that path keeps no subject and no mislabelling.
 *  - **Type.** A conventional type passes through as itself — #818 extends
 *    #810's bump-only set to the FULL vocabulary, so `chore: X` / `docs: Y`
 *    / `test: Z` keep their declared type instead of being collapsed to
 *    `chore(work): …`. A plan-driver prefix maps to the type the change
 *    actually ships: `Bug:` → `fix` (a bug fix that lands as `chore:`
 *    produces no release-please bump — the #818 incident), `Feature:` /
 *    `EPIC:` → `feat`, `research:` / `spike:` → `chore`. A genuinely
 *    unknown prefix falls back to `chore` — the honest default.
 *  - **Scope.** An alphabetic scope from the title is kept as-is. When the
 *    title has no scope, the driver supplies `work` (the cycle's own
 *    subsystem) so the subject matches the `type(scope):` shape the rest of
 *    the project uses. An issue number can never land in the scope position:
 *    the scope is either the one parsed from a `type(scope):` title or the
 *    literal `work` — a bare `#N` in the scope slot is structurally
 *    impossible (AGENTS.md §9).
 *  - **Description.** The title's conventional description is used. When the
 *    title has no conventional prefix, the title itself is the description
 *    (a question-titled issue reads sensibly as a description), which is why
 *    a `Bug: …` / `feat: …`-free title still produces a readable subject.
 *  - **Breaking markers.** Only a `!` already present in the title survives;
 *    none is ever added, so a derived subject cannot accidentally declare a
 *    breaking change.
 *
 * @param title the issue's title (fetched verbatim; may be empty or malformed)
 * @returns the subject for `git commit -m <subject>` — a `type(scope): description`
 */
export function deriveConsolidationSubject(title: string): string | undefined {
  // Nothing to describe — a caller that reaches this with an empty title has
  // no usable subject and keeps the old `chore(handoff):` line rather than
  // emitting a bare `type(scope):`.
  if (!title || !title.trim()) return undefined;
  const parsed = parseConventionalTitle(title);

  // Honest default: no recognizable type → `chore`. A conventional type
  // passes through as itself (#818 — including the non-bumping `chore` /
  // `docs` / `test` / `ci` that #810 collapsed), a plan-driver prefix maps
  // to the type it actually ships (`Bug:` → `fix`, `EPIC:` → `feat`, …),
  // and a genuinely unknown prefix is an honest `chore`.
  const bareType = parsed.type;
  const type =
    bareType !== null
      ? CONVENTIONAL_TYPES.has(bareType)
        ? bareType
        : (PLAN_DRIVER_PREFIXES[bareType] ?? "chore")
      : "chore";
  // A breaking marker already present in the title survives; none is added.
  // (A non-bumping base type that carried `!` — e.g. `chore!:` — is downgraded
  // to a plain `chore`, which is the honest reading of a housekeeping change.)
  const breaking = type !== "chore" && BUMP_TYPES.has(type) && parsed.breaking;

  // Scope: keep an alphabetic scope from the title, else `work`. A numeric
  // scope (which would violate §9) is rejected in favour of `work`.
  let scope: string | undefined = parsed.scope;
  if (scope !== undefined && !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(scope)) {
    scope = undefined;
  }
  scope = scope ?? "work";

  // Description: the conventional description, or the raw title when there
  // is no prefix. A cycle that reaches this point has an issue number to
  // name, so the subject is never a bare `type(scope):`.
  const description = parsed.description || parsed.raw;

  return `${type}${breaking ? "!" : ""}(${scope}): ${description}`;
}
