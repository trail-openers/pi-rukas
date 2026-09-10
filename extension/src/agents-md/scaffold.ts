/**
 * scaffold — boilerplate section templates and the scaffold post-pass.
 *
 * A greenfield `create` (scaffold is ON by default on the create/no-file
 * path) appends 7 boilerplate sections (minimalist-engineering, git-workflow,
 * documentation-policy, issue-driven-development, code-review-doctrine,
 * context7-protocol, testing-standards) as HEADING-DELIMITED managed
 * sections (via section-detect.ts `appendSection`/`insertSectionAfter`, which
 * emit pure-prose `# Heading` + body text — no HTML comment markers of any
 * kind). The sections are universal text — language specifics live in the
 * managed fact sections (quality-gates, commands, environment).
 *
 * Six of the seven bodies are static array literals; `testing-standards`
 * alone is answer-aware: `computeScaffold` renders it from
 * `opts.answers.coverageThreshold` (the operator's stated threshold, or the
 * ≥80% opinionated default when unanswered).
 *
 * On a brownfield update, the scaffold post-pass runs AFTER the rebuild and
 * inserts missing boilerplate sections via `insertSectionAfter` (inserts
 * after the heading-delimited environment section; falls back to
 * append-at-end when environment is absent).
 *
 * Design: Shape C (hybrid) — fact sections and boilerplate sections are both
 * heading-delimited. Stickiness is NOT "outside markers": the update splice
 * loop (update-agent.ts) only rewrites sections whose id is in its `updates`
 * Map, and that map holds only the fact-section ids (quality-gates, commands,
 * environment, code-style). Boilerplate and operator-choices ids are never in
 * the map, so a routine update spares their bytes even though they sit
 * inside heading-delimited managed sections.
 */

import type { DetectedFacts } from "./detect.ts";
import type { LedgerRow } from "./ledger.ts";
import { appendManagedSection, insertManagedSectionAfter } from "./section-detect.ts";

// Post-#681 M2 the scaffold post-pass inserts heading-delimited sections
// (section-detect.ts): a managed section is a heading-delimited block, and the
// insertion seam is the heading boundary. The names below keep the call sites
// readable as the marker-era names.
const appendSection = appendManagedSection;
const insertSectionAfter = insertManagedSectionAfter;

// ------------------------------------------------------------------ types

export interface OperatorAnswers {
  /** Coverage threshold for tests (e.g. "80%+"). */
  coverageThreshold?: string;
  /** Review-blocking severity (e.g. "MEDIUM"). */
  reviewBlockingSeverity?: string;
  /** Merge authority rule (e.g. "squash-merge when gates pass"). */
  mergeAuthority?: string;
  /** Project-specific constraints (free-form). */
  projectConstraints?: string;
}

/**
 * The B1↔B2 seam. B2 will call `updateAgent` with a `DetectedFacts`-shaped
 * value produced by its own agent dispatch, converted and fed here; B1
 * defines and tests the seam standalone, with hand-built facts. No new
 * wire-format type in this ticket — the existing `DetectedFacts` is used
 * directly.
 *
 * - `facts` — when supplied on an `update`, the three fact sections
 *   (quality-gates, commands, environment) are built from THIS via the
 *   existing `gatesBody`/`commandsBody`/`environmentBody` functions instead
 *   of a fresh `detectFacts()` call. Resulting section rows are stamped
 *   `[detected:agent,<today>]`.
 * - `codeStyleBullets` — feeds the code-style section (`codeStyleBody`).
 *
 * `agentOverride` is only honoured on the has-markers `update` path. It
 * NEVER reaches the create/wrap paths (they don't receive it).
 */
export interface AgentOverride {
  facts?: DetectedFacts;
  codeStyleBullets?: string[];
}

export interface ScaffoldOpts {
  scaffold?: boolean;
  answers?: OperatorAnswers;
  /**
   * Caller-supplied facts (B2 seam). When `facts` is set on update, the fact
   * sections are derived from it instead of `detectFacts()`.
   */
  agentOverride?: AgentOverride;
  /**
   * Explicit refresh: when true AND `agentOverride` is supplied, every section
   * whose existing ledger row is `[detected:agent,...]` is DIRECTLY replaced
   * (bypassing `mergeAutoRows`). Without it, a supplied `agentOverride` is
   * used only for first-time population — it never overwrites a section that
   * already carries a `[detected:agent,...]` row.
   */
  refresh?: boolean;
}

// ---------------------------------------------------------------- boilerplate

/** Heading name → section id for the seven boilerplate sections.
 * Used by update-agent.ts detectExistingBoilerplate to map file headings
 * to managed section ids (avoids duplicating the mapping). A heading missing
 * from this map breaks update-path idempotency: the section would be
 * re-inserted on every run. */
export const SCAFFOLD_HEADING_MAP: Map<string, string> = new Map([
  ["Minimalist Engineering", "minimalist-engineering"],
  ["Git Workflow", "git-workflow"],
  ["Documentation Policy", "documentation-policy"],
  ["Issue-Driven Development", "issue-driven-development"],
  ["Code Review Doctrine", "code-review-doctrine"],
  ["Context7 Protocol", "context7-protocol"],
  ["Testing Standards", "testing-standards"],
]);

/** The static boilerplate sections (all except the answer-aware
 * `testing-standards` body), in document order. Exported so the quality
 * test can assert per-section density budgets against the registered body. */
export const SCAFFOLD_BODIES: { id: string; body: string }[] = [
  {
    id: "minimalist-engineering",
    body: [
      "# Minimalist Engineering",
      "",
      "Every line of code is a liability. Before creating anything:",
      "",
      "- **Is this explicitly required** by the GitHub issue?",
      "- **Can existing code/tools** solve this instead?",
      "- **What's the SIMPLEST** way to meet the requirement?",
      "- **Am I building for hypothetical** future needs?",
      "",
      "If you cannot justify necessity, DO NOT CREATE IT.",
    ].join("\n"),
  },
  {
    id: "git-workflow",
    body: [
      "# Git Workflow",
      "",
      "## Conventional commits",
      "",
      "```",
      "<type>(<scope>): <description>",
      "```",
      "",
      "Types: `feat` | `fix` | `refactor` | `docs` | `test` | `chore`",
      "",
      "## Branch naming",
      "",
      "```",
      "feature/issue-{N}-brief-description",
      "```",
      "",
      "## Branch protection",
      "",
      "- ❌ NO direct commits to `main`",
      "- ✅ All work on feature branches → PR",
      "- ✅ PRs squash-merged",
    ].join("\n"),
  },
  {
    id: "documentation-policy",
    body: [
      "# Documentation Policy",
      "",
      "## The 200-PR test",
      "",
      'Before adding documentation: *"Will this be true in 200 PRs?"*',
      "",
      "- **YES** (enduring principle) → Document the principle (WHY)",
      "- **NO** (implementation detail) → Skip, or use code comments (WHAT/HOW)",
      "",
      "## Forbidden documentation",
      "",
      "- ❌ Issue drafts, implementation summaries, fix notes, scratch files",
      "- ❌ `TODO` comments — create GitHub issues instead",
    ].join("\n"),
  },
  {
    id: "issue-driven-development",
    body: [
      "# Issue-Driven Development",
      "",
      "## Before starting",
      "",
      "1. GitHub issue exists for the work",
      "2. Issue clearly describes the requirement",
      "3. Your approach matches issue scope exactly",
      "4. No scope expansion without updating the issue",
      "",
      "## Linking",
      "",
      "Link PRs to issues via `Closes #N` in the PR body. Use the issue number",
      "in the branch name, never in the commit scope.",
    ].join("\n"),
  },
  {
    id: "code-review-doctrine",
    body: [
      "# Code Review Doctrine",
      "",
      "## Quality gates (blocking)",
      "",
      "All checks must pass locally before push:",
      "",
      "- [ ] Tests passing (0 failures)",
      "- [ ] Coverage meets threshold",
      "- [ ] Linting passing (0 errors)",
      "- [ ] Type checking passing (0 errors)",
      "",
      "## Zero technical debt",
      "",
      "- ❌ No `# noqa`, `@ts-ignore`, `# type: ignore`",
      "- ❌ No `// biome-ignore` without explicit justification",
      "- ❌ No suppressions in the diff",
    ].join("\n"),
  },
  {
    id: "context7-protocol",
    body: [
      "# Context7 Protocol",
      "",
      "Before writing ANY code, check Context7 for current documentation:",
      "- Library APIs and syntax",
      "- Framework patterns and best practices",
      "- Configuration options",
      "",
      "Training data is often months out of date. Context7 provides",
      "authoritative, up-to-date docs. Skip it for the project's own code",
      "standard-library features, or meta-questions about the project.",
    ].join("\n"),
  },
];

/** The opinionated default coverage threshold the Testing Standards section
 * renders when the interview's coverage question was never answered. */
const DEFAULT_COVERAGE_THRESHOLD = "≥80%";

/**
 * The Testing Standards body — the ONE answer-aware scaffold section. It
 * states the coverage threshold exactly once: the operator's stated value
 * when the interview answered it, the opinionated default otherwise.
 * Pure: a function of the (possibly absent) answer alone.
 */
export function testingStandardsBody(coverageThreshold?: string): string {
  const threshold = coverageThreshold ?? DEFAULT_COVERAGE_THRESHOLD;
  return [
    "# Testing Standards",
    "",
    "- TDD preferred: write the failing test first, then the minimal",
    "  implementation that passes it; refactor with the tests green.",
    `- Coverage threshold: **${threshold}** for new code.`,
    "- Coverage for lower-risk areas (documentation, config, formatting)",
    "  may be lower; the threshold is the floor for logic, not a target for",
    "  boilerplate.",
    "- A bug fix ships with its regression test — a fix without a test that",
    "  failed first is an incomplete fix.",
  ].join("\n");
}

// ------------------------------------------------------------------- ledger

/** The `scaffolded:<id>` ledger row — dedicated namespace, never written by mergeAutoRows/omissionRows. */
function scaffoldedLedgerRow(id: string, date: string): LedgerRow {
  return {
    key: `scaffolded:${id}`,
    value: "scaffolded",
    provenance: "auto",
    date,
  };
}

/**
 * Operator-choices body for the scaffold. Rendered as a bullet list; always
 * ends with a newline for splice symmetry.
 *
 * `omitCoverage` suppresses the coverage bullet: once the answer-aware
 * Testing Standards section carries the threshold, it is the SOLE statement
 * of the value in the file, and the operator-choices section must not
 * duplicate it. The `[asked:operator]` ledger row is unaffected (it records
 * what was asked, not where the value is stated).
 */
export function renderOperatorChoices(answers: OperatorAnswers, omitCoverage = false): string {
  const rows: string[] = [];
  if (answers.coverageThreshold && !omitCoverage)
    rows.push(`- **Coverage threshold:** ${answers.coverageThreshold}`);
  if (answers.reviewBlockingSeverity)
    rows.push(`- **Review-blocking severity:** ${answers.reviewBlockingSeverity}`);
  if (answers.mergeAuthority) rows.push(`- **Merge authority:** ${answers.mergeAuthority}`);
  if (answers.projectConstraints)
    rows.push(`- **Project-specific constraints:** ${answers.projectConstraints}`);
  return `## Operator choices\n\n${rows.join("\n")}\n`;
}

/**
 * Ledger rows for the operator-choices section. Each carries
 * `[asked:operator,<date>]` so the ledger remembers what was provided.
 */
export function operatorChoicesLedgerRows(answers: OperatorAnswers, date: string): LedgerRow[] {
  const rows: LedgerRow[] = [];
  if (answers.coverageThreshold)
    rows.push({
      key: "operator:coverage",
      value: answers.coverageThreshold,
      provenance: "asked",
      date,
    });
  if (answers.reviewBlockingSeverity)
    rows.push({
      key: "operator:review-blocking",
      value: answers.reviewBlockingSeverity,
      provenance: "asked",
      date,
    });
  if (answers.mergeAuthority)
    rows.push({
      key: "operator:merge-authority",
      value: answers.mergeAuthority,
      provenance: "asked",
      date,
    });
  if (answers.projectConstraints)
    rows.push({
      key: "operator:constraints",
      value: answers.projectConstraints,
      provenance: "asked",
      date,
    });
  return rows;
}

// ------------------------------------------------------- scaffold result builder

/** The full scaffold result, consumed by the plan builder. */
export interface ScaffoldResult {
  /** Boilerplate section bodies that were (or would be) added. */
  sections: { id: string; body: string }[];
  /** Operator-choices body if answers were provided. */
  operatorChoicesBody?: string;
  /** Ledger rows for scaffolded sections (scaffolded:<id> namespace) + operator rows. */
  ledgerRows: LedgerRow[];
}

/**
 * Compute the scaffold result given the existing section ids.
 *
 * `existingIds` is the set of section ids already present (from markers or
 * wrap append output). Sections already present are skipped — idempotency:
 * a second `--scaffold` run adds nothing (the answer-aware Testing Standards
 * body included: once present, it is not re-rendered even if the answer
 * changes later).
 */
export function computeScaffold(existingIds: Set<string>, opts?: ScaffoldOpts): ScaffoldResult {
  const sections: { id: string; body: string }[] = [];
  const ledgerRows: LedgerRow[] = [];
  let operatorChoicesBody: string | undefined;
  const date = new Date().toISOString().slice(0, 10);
  const answers = opts?.answers;
  const coverage = answers?.coverageThreshold;

  for (const { id, body } of SCAFFOLD_BODIES) {
    if (existingIds.has(id)) continue;
    sections.push({ id, body });
    ledgerRows.push(scaffoldedLedgerRow(id, date));
  }

  // The answer-aware section: rendered from opts.answers (the operator's
  // stated threshold, or the opinionated default), in document position
  // after the static bodies. Skipped when already present, like the rest.
  if (!existingIds.has("testing-standards")) {
    sections.push({ id: "testing-standards", body: testingStandardsBody(coverage) });
    ledgerRows.push(scaffoldedLedgerRow("testing-standards", date));
  }

  if (answers) {
    const hasAny =
      answers.coverageThreshold ||
      answers.reviewBlockingSeverity ||
      answers.mergeAuthority ||
      answers.projectConstraints;
    if (hasAny) {
      const operatorRows = operatorChoicesLedgerRows(answers, date);
      ledgerRows.push(...operatorRows);
      // Mutual exclusion: the threshold value is stated exactly once —
      // in the Testing Standards section. When that section is present
      // (fresh create, or an update that still inserts it), the
      // operator-choices section suppresses its coverage bullet; on an
      // update where Testing Standards was already present (skipped above),
      // the file already carries the value there, so suppress regardless.
      operatorChoicesBody = renderOperatorChoices(answers, true);
    }
  }

  return { sections, operatorChoicesBody, ledgerRows };
}

// ----------------------------------------------------- scaffold post-pass

/**
 * The scaffold post-pass: appends boilerplate sections (and optionally
 * operator-choices) to the rebuild output.
 *
 * For `create` (and wrap): `text` is the file content so far, and boilerplate
 * sections are appended at end. The `after` param is `undefined`.
 *
 * For `update` (has-markers): `text` is the REBUILD OUTPUT (current file with
 * managed sections rebuilt), and boilerplate is inserted AFTER the
 * `environment` section (via `insertSectionAfter`, which reads the
 * heading-delimited environment section's end). Falls back to append-at-end
 * when environment is absent.
 *
 * Insertion happens AFTER the rebuild, positions computed from
 * REBUILD-OUTPUT bytes (not pre-rebuild originals).
 *
 * Returns `{ bytes, scaffoldedIds }`.
 */
export function runScaffoldPostPass(
  text: string,
  scaffoldResult: ScaffoldResult,
  isUpdatePath: boolean,
): { bytes: string; scaffoldedIds: string[] } {
  if (scaffoldResult.sections.length === 0) {
    return { bytes: text, scaffoldedIds: [] };
  }

  let result = text;
  const scaffoldedIds: string[] = [];

  // First: append operator-choices section (if any). Matches the pre-M2
  // document order (fact sections, operator-choices, boilerplate) — the
  // scaffold post-pass on the create path previously inserted operator-choices
  // before the boilerplate, and the scaffold tests pin that order.
  if (scaffoldResult.operatorChoicesBody) {
    result = appendSection(result, "operator-choices", scaffoldResult.operatorChoicesBody);
  }

  // Then: insert each boilerplate section IN DOCUMENT ORDER, each directly
  // after the previous section (seam recomputed from current bytes every
  // call). The first insertion uses the `environment` target when present
  // (update path); when environment is absent it falls back to append-at-end.
  // All subsequent insertions target the previously inserted section.
  let afterId: string | undefined = isUpdatePath ? "environment" : undefined;
  for (const { id, body } of scaffoldResult.sections) {
    result = afterId
      ? insertSectionAfter(result, id, body, afterId)
      : appendSection(result, id, body);
    scaffoldedIds.push(id);
    afterId = id;
  }

  return { bytes: result, scaffoldedIds };
}

// -------------------------------------------------- wrap-scaffold passthrough

/**
 * For the wrap (no-markers) path with scaffold enabled: the scaffold post-pass
 * appends boilerplate after the wrapped output.
 */
export function runWrapScaffold(
  wrappedBytes: string,
  scaffoldResult: ScaffoldResult,
): { bytes: string; scaffoldedIds: string[] } {
  return runScaffoldPostPass(wrappedBytes, scaffoldResult, false);
}
