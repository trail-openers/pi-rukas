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
 */

/** The conventional-commit types release-please actually bumps for. */
const BUMP_TYPES = new Set(["feat", "fix", "perf", "refactor", "docs", "build"]);

/**
 * The conventional-commit prefix at the START of an issue title.
 *
 * Matches the shape AGENTS.md §9 requires for commit subjects —
 * `type:`, `type!:` and `type(scope):` — so `fix(work): restore …` in a
 * title maps to `fix`/`work` and `feat: add …` maps to `feat`. A title that
 * does not begin with a conventional prefix (a `spike`, an `epic`, or a
 * question) returns `{ type: null, raw: title }` so the caller falls back to
 * an honest `chore` rather than inventing a `fix:` to satisfy release-please.
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
  const m = title.match(
    /^(feat|fix|perf|refactor|docs|build|style|test|ci|chore|revert)(!)?(\(([^)]*)\))?:\s*(.+)$/,
  );
  if (!m) {
    return { type: null, scope: undefined, description: "", breaking: false, raw: title.trim() };
  }
  const type = m[1] ?? null;
  const scope = m[4]?.trim() || undefined;
  const description = (m[5] ?? "").trim();
  return { type, scope, description, breaking: m[2] === "!", raw: title.trim() };
}

/**
 * Derive the consolidation commit subject from the issue title.
 *
 * Rules (each maps to an acceptance criterion / edge case in #810):
 *
 *  - **Real work only.** The caller invokes this only when real change is
 *    present (a non-empty staged diff). A no-op consolidation produces no
 *    commit at all, so this never fires for "parked before producing a
 *    change" — that path keeps no subject and no mislabelling.
 *  - **Type.** If the title begins with a conventional prefix the type
 *    release-please bumps for (`feat`/`fix`/`perf`/`refactor`/`docs`/`build`),
 *    it is used. A title with a conventional prefix that release-please does
 *    NOT bump (`test:`, `ci:`, `chore:`, …) or no prefix at all falls back to
 *    `chore` — the honest default — rather than being relabelled to satisfy
 *    the version tool.
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

  // Honest default: no recognizable, bumpable conventional type → `chore`.
  // The BARE type is checked (a `feat!` is still a `feat` for bump purposes).
  const bareType = parsed.type;
  const type = bareType !== null && BUMP_TYPES.has(bareType) ? bareType : "chore";
  // A breaking marker already present in the title survives; none is added.
  // (A non-bumping base type that carried `!` — e.g. `chore!:` — is downgraded
  // to a plain `chore`, which is the honest reading of a housekeeping change.)
  const breaking = type !== "chore" && parsed.breaking;

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
