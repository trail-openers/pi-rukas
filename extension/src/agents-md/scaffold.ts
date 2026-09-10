/**
 * scaffold — boilerplate section templates and the scaffold post-pass.
 *
 * Greenfield `create` appends 7 boilerplate sections as heading-delimited
 * managed sections. Six bodies are static; `testing-standards` is answer-aware.
 * The scaffold post-pass also inserts caller-supplied agent-derived bullet
 * sections (code-style / architecture-notes) on the create/wrap path, reusing
 * the same pure body builders as the has-markers update path.
 *
 * Design: Shape C (hybrid) — fact and boilerplate sections are both
 * heading-delimited; the update splice loop only rewrites fact-section ids,
 * so boilerplate/operator-choices bytes are spared on routine updates.
 */

import type { DetectedFacts } from "./detect.ts";
import type { LedgerRow } from "./ledger.ts";
import { architectureNotesBody, codeStyleBody } from "./renderer.ts";
import { appendManagedSection, insertManagedSectionAfter } from "./section-detect.ts";

// Post-#681 M2: the scaffold post-pass inserts heading-delimited sections;
// these aliases keep call sites readable as the marker-era names.
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
  /**
   * 5th greenfield-interview question: project intent/tech-stack/best-practices
   * in the operator's own words. Lands EXCLUSIVELY in operator-choices with
   * [asked:operator] provenance — never in agent-derived sections. Unanswered
   * → no bullet, no row (default-omit pattern).
   */
  projectIntent?: string;
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
 * - `testingNotes` — feeds the Testing Standards section as a "Project-specific"
 *   supplement appended after the static doctrine (first-time population only,
 *   guarded by the section's skip-if-present idempotency). Not a fact section,
 *   so the TOOL maps `agentOverride.facts.testingNotes` onto this field.
 *
 * Honoured on create, wrap (no-markers), and has-markers update paths —
 * gated by skip-if-present idempotency, not by a provenance ledger.
 */
export interface AgentOverride {
  facts?: DetectedFacts;
  codeStyleBullets?: string[];
  /**
   * The agent-observed testing-setup bullets (the `testingNotes` wire field).
   * Rendered as the "Project-specific" supplement of the Testing Standards
   * section on FIRST-TIME population only: it rides inside the
   * skip-if-present idempotency (`existingIds.has("testing-standards")`), so
   * a second create/update never re-appends or churns it. No
   * `[detected:agent,...]` ledger row, no refresh, no omission machinery —
   * the static universal doctrine is never removed or altered, only
   * supplemented.
   */
  testingNotes?: string[];
  /**
   * Dense, specific bullets: module→responsibility mappings and critical-path
   * rules. Feeds the architecture-notes managed section (agent-derived, not
   * manifest-derived — no omission concept). Stays on the AgentFacts side
   * only (never enters DetectedFacts or agentFactsToDetectedFacts), mirroring
   * codeStyleBullets exactly.
   */
  architectureBullets?: string[];
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

/** The cap on agent-observed testing bullets appended to the Testing
 * Standards section. The static body is 10 lines; the supplement adds a
 * blank line + a "Project-specific" bold lead-in + up to 5 bullets (≈2 lines
 * each when wrapped) → ≤ ~20 lines total, so the ≤20-line per-section density
 * gate (test-agents-md-scaffold-quality.ts) STAYS unchanged. Beyond the cap
 * the bullets are silently truncated — the section never grows unbounded. */
export const TESTING_NOTES_MAX = 5;

/**
 * The Testing Standards body — the ONE answer-aware scaffold section. It
 * states the coverage threshold exactly once: the operator's stated value
 * when the interview answered it, the opinionated default otherwise. Pure: a
 * function of the (possibly absent) answer and notes alone.
 *
 * `testingNotes` (the pre-pass agent's observed testing-setup bullets) is
 * appended AFTER the static universal doctrine, clearly demarcated under a
 * "Project-specific" bold lead-in — never a `##` sub-heading (the density
 * test's `bodyLines()` stops at the first next heading, so a sub-heading
 * would make the supplement invisible to the budget gate). The static
 * doctrine is NEVER removed or altered — only supplemented. Absent/empty
 * notes → byte-identical to the static-only body (no lead-in, no blank
 * line): the supplement is purely additive.
 */
export function testingStandardsBody(coverageThreshold?: string, testingNotes?: string[]): string {
  const threshold = coverageThreshold ?? DEFAULT_COVERAGE_THRESHOLD;
  const lines = [
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
  ];
  const notes = (testingNotes ?? []).slice(0, TESTING_NOTES_MAX);
  if (notes.length > 0) {
    lines.push("", "**Project-specific**", ...notes.map((n) => `- ${n}`));
  }
  return lines.join("\n");
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

/** The [detected:agent] row for caller-supplied bullet sections on create/wrap. */
function agentDetectedLedgerRow(id: string, date: string): LedgerRow {
  return { key: id, value: "agent", provenance: "detected", date };
}

/**
 * Operator-choices body for the scaffold: a bullet list that always ends
 * with a newline for splice symmetry. `omitCoverage` suppresses the
 * coverage bullet — once the answer-aware Testing Standards section carries
 * the threshold, it is the SOLE statement of the value in the file (the
 * `[asked:operator]` ledger row is unaffected: it records what was asked,
 * not where the value is stated).
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
  if (answers.projectIntent) rows.push(`- **Project intent & stack:** ${answers.projectIntent}`);
  return `## Operator choices\n\n${rows.join("\n")}\n`;
}

/**
 * The `[asked:operator,<date>]` ledger row per ANSWERED operator choice —
 * the ledger records what was asked, not where the value is stated.
 */
export function operatorChoicesLedgerRows(answers: OperatorAnswers, date: string): LedgerRow[] {
  const entries: [string, string | undefined][] = [
    ["operator:coverage", answers.coverageThreshold],
    ["operator:review-blocking", answers.reviewBlockingSeverity],
    ["operator:merge-authority", answers.mergeAuthority],
    ["operator:constraints", answers.projectConstraints],
    ["operator:intent", answers.projectIntent],
  ];
  return entries.flatMap(([key, value]) =>
    value === undefined ? [] : [{ key, value, provenance: "asked", date } as LedgerRow],
  );
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

  // Agent-derived bullet sections (create/wrap path): caller-supplied
  // codeStyleBullets/architectureBullets rendered via the SAME pure body
  // builders the has-markers update path uses, so both emit identical bytes.
  // [detected:agent] provenance: caller intent, never clobbered by routine
  // updates. existingIds skip-if-present gate applies like testing-standards.
  // agentOverride.facts is NOT consumed — only these two bullet fields.
  const override = opts?.agentOverride;
  const codeStyleOut = override?.codeStyleBullets
    ? codeStyleBody(override.codeStyleBullets)
    : undefined;
  const archNotesOut = override?.architectureBullets
    ? architectureNotesBody(override.architectureBullets)
    : undefined;
  // Unshift order: architecture-notes first, then code-style, so the final
  // array is [code-style, architecture-notes, …] — the FACT_SECTIONS order.
  if (archNotesOut !== undefined && !existingIds.has("architecture-notes")) {
    sections.unshift({ id: "architecture-notes", body: archNotesOut });
    ledgerRows.unshift(agentDetectedLedgerRow("architecture-notes", date));
  }
  if (codeStyleOut !== undefined && !existingIds.has("code-style")) {
    sections.unshift({ id: "code-style", body: codeStyleOut });
    ledgerRows.unshift(agentDetectedLedgerRow("code-style", date));
  }

  // The answer-aware section: rendered from opts.answers (the operator's
  // stated threshold, or the opinionated default) + the agent-observed
  // testingNotes supplement (first-time population only), in document
  // position after the static bodies. Skipped when already present, like
  // the rest — the supplement rides INSIDE the same skip, so a second
  // create/update never re-appends or churns it.
  if (!existingIds.has("testing-standards")) {
    sections.push({
      id: "testing-standards",
      body: testingStandardsBody(coverage, override?.testingNotes),
    });
    ledgerRows.push(scaffoldedLedgerRow("testing-standards", date));
  }

  if (answers) {
    const hasAny =
      answers.coverageThreshold ||
      answers.reviewBlockingSeverity ||
      answers.mergeAuthority ||
      answers.projectConstraints ||
      answers.projectIntent;
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
 * operator-choices) to the rebuild output. Create/wrap: appended at end.
 * Update: inserted after the environment section. Returns { bytes, scaffoldedIds }.
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

  // First: append operator-choices (if any), matching pre-M2 document order.
  if (scaffoldResult.operatorChoicesBody) {
    result = appendSection(result, "operator-choices", scaffoldResult.operatorChoicesBody);
  }
  // Then: insert each boilerplate section in document order, each after the
  // previous (seam recomputed from current bytes every call). The first uses
  // `environment` when present (update path); all subsequent target the prior.
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
