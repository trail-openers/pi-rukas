/**
 * work-driver-verify-select-render — #1647: the PR-body sections for the
 * selected verify's non-blocking outcomes.
 *
 * A flaky test (failed once, passed on the rerun) and a baseline-red test
 * (failed twice, red on the base commit as well) do not block a cycle, so the
 * only record of them is the PR body. The reviewer should see which gate
 * results were carried, the same way the pre-existing-failures section already
 * shows the commit-pr seam's carried reds.
 */

import { neutraliseMarkdownField } from "./comment-evidence.ts";

/** The attribution a cycle recorded: `flaky` and `baselineRed` test names. */
export interface VerifyAttributionRecord {
  flaky: readonly string[];
  baselineRed: readonly string[];
}

function listSection(title: string, intro: string, names: readonly string[]): string {
  return [
    "",
    `## ${title}`,
    "",
    intro,
    "",
    ...names.map((n) => `- \`${neutraliseMarkdownField(n)}\``),
  ].join("\n");
}

/**
 * The flaky and baseline-red sections, or "" when the cycle recorded neither.
 * `scope` (#1647) suffixes the headings when a second writer adds its own
 * sections to a body that already has them.
 */
export function verifyAttributionSectionOf(
  attribution: VerifyAttributionRecord | undefined,
  scope?: string,
): string {
  if (!attribution) return "";
  const tag = scope === undefined ? "" : ` (${scope})`;
  const parts: string[] = [];
  if (attribution.flaky.length > 0) {
    parts.push(
      listSection(
        `Flaky tests${tag}`,
        "These failed on the first run and passed on the single rerun, so they did not block this change. They are listed so a reviewer can tell a gate that flickered from one that held.",
        attribution.flaky,
      ),
    );
  }
  if (attribution.baselineRed.length > 0) {
    parts.push(
      listSection(
        `Tests red on the base commit${tag}`,
        "These failed twice on this change and fail the same way on a clean checkout of the base commit, so they did not block it. They are gate failures owned by the base, listed so they are not mistaken for this diff.",
        attribution.baselineRed,
      ),
    );
  }
  return parts.join("\n");
}
