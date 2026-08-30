/**
 * scaffold — boilerplate section templates and the scaffold post-pass.
 *
 * A greenfield `create --scaffold` appends 5 static boilerplate sections
 * (minimalist-engineering, git-workflow, documentation-policy,
 * issue-driven-development, code-review-doctrine) OUTSIDE the managed
 * markers. The sections are universal text — language specifics live in the
 * managed fact sections (quality-gates, commands, environment).
 *
 * On a brownfield update, the scaffold post-pass runs AFTER the rebuild and
 * inserts missing boilerplate sections via `appendSection`'s `after` param
 * (inserts after the environment section; falls back to append-at-end when
 * environment is absent).
 *
 * Design: Shape C (hybrid) — fact sections stay managed as today; boilerplate
 * sections are emitted OUTSIDE markers (doctrine, operator-owned).
 */

import type { LedgerRow } from "./ledger.ts";
import { MARKER_VERSION, appendSection, insertSectionAfter } from "./markers.ts";

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

export interface ScaffoldOpts {
  scaffold?: boolean;
  answers?: OperatorAnswers;
}

// ---------------------------------------------------------------- boilerplate

/** Heading name → section id for the five boilerplate sections.
 * Used by update-agent.ts detectExistingBoilerplate to map file headings
 * to managed section ids (avoids duplicating the mapping). */
export const SCAFFOLD_HEADING_MAP: Map<string, string> = new Map([
  ["Minimalist Engineering", "minimalist-engineering"],
  ["Git Workflow", "git-workflow"],
  ["Documentation Policy", "documentation-policy"],
  ["Issue-Driven Development", "issue-driven-development"],
  ["Code Review Doctrine", "code-review-doctrine"],
]);

/** The five static boilerplate sections, in document order. */
const SCAFFOLD_BODIES: { id: string; body: string }[] = [
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
];

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
 */
export function renderOperatorChoices(answers: OperatorAnswers): string {
  const rows: string[] = [];
  if (answers.coverageThreshold)
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
 * a second `--scaffold` run adds nothing.
 */
export function computeScaffold(existingIds: Set<string>, opts?: ScaffoldOpts): ScaffoldResult {
  const sections: { id: string; body: string }[] = [];
  const ledgerRows: LedgerRow[] = [];
  let operatorChoicesBody: string | undefined;
  const date = new Date().toISOString().slice(0, 10);

  for (const { id, body } of SCAFFOLD_BODIES) {
    if (existingIds.has(id)) continue;
    sections.push({ id, body });
    ledgerRows.push(scaffoldedLedgerRow(id, date));
  }

  if (opts?.answers) {
    const answers = opts.answers;
    const hasAny =
      answers.coverageThreshold ||
      answers.reviewBlockingSeverity ||
      answers.mergeAuthority ||
      answers.projectConstraints;
    if (hasAny) {
      const operatorRows = operatorChoicesLedgerRows(answers, date);
      ledgerRows.push(...operatorRows);
      operatorChoicesBody = renderOperatorChoices(answers);
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
 * managed sections rebuilt), and boilerplate is inserted AFTER the `environment`
 * section (via `appendSection`'s `after` param). Falls back to append-at-end
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
  const afterId = isUpdatePath ? "environment" : undefined;

  // First: append operator-choices section (if any).
  if (scaffoldResult.operatorChoicesBody) {
    result = appendSection(result, "operator-choices", scaffoldResult.operatorChoicesBody);
  }

  // Then: append each boilerplate section. Iterating in reverse so that
  // insertSectionAfter (which always targets the same position right after
  // `environment`) produces forward order — each new insertion lands before
  // the ones already there, pushing earlier iterations further down.
  for (const { id, body } of [...scaffoldResult.sections].reverse()) {
    result = afterId
      ? insertSectionAfter(result, id, body, afterId)
      : appendSection(result, id, body);
    scaffoldedIds.push(id);
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
