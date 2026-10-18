/**
 * work-driver-verify-select-render — #1647: the PR-body section for the
 * selected verify's non-blocking outcomes.
 *
 * A flaky test (failed once, passed on the rerun) and a baseline-red test
 * (failed twice, red on the base commit as well) do not block a cycle, so the
 * only record of them is the PR body. The section is one block between HTML
 * comment markers, rendered from the cycle's whole accumulated record. The
 * develop round writes it at commit-pr and the ci tier replaces it, so repeated
 * writes converge on one block instead of appending duplicates.
 */

import { neutraliseMarkdownField } from "./comment-evidence.ts";
import type { VerifyAttributionRecord } from "./work-driver-verify-shared.ts";

export const ATTRIBUTION_BEGIN = "<!-- verify-attribution:begin -->";
export const ATTRIBUTION_END = "<!-- verify-attribution:end -->";

const BLOCK_RE = new RegExp(`\\n*${ATTRIBUTION_BEGIN}[\\s\\S]*?${ATTRIBUTION_END}\\n*`, "g");

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
 * The marked flaky and baseline-red block, or "" when the record holds neither.
 * It carries the whole record, so a caller replaces the block rather than
 * adding a second one.
 */
export function verifyAttributionSectionOf(
  attribution: VerifyAttributionRecord | undefined,
): string {
  if (!attribution) return "";
  const parts: string[] = [];
  if (attribution.flaky.length > 0) {
    parts.push(
      listSection(
        "Flaky tests",
        "These failed on the first run and passed on the single rerun, so they did not block this change. They are listed so a reviewer can tell a gate that flickered from one that held.",
        attribution.flaky,
      ),
    );
  }
  if (attribution.baselineRed.length > 0) {
    parts.push(
      listSection(
        "Tests red on the base commit",
        "These failed twice on this change and fail the same way on a clean checkout of the base commit, so they did not block it. They are gate failures owned by the base, listed so they are not mistaken for this diff.",
        attribution.baselineRed,
      ),
    );
  }
  if (parts.length === 0) return "";
  return [ATTRIBUTION_BEGIN, ...parts, ATTRIBUTION_END].join("\n");
}

/**
 * `body` with its attribution block replaced by `block` (or removed, when
 * `block` is ""). Throws when the markers do not pair up: a half-marked body is
 * one the writer does not understand, and writing into it could duplicate or
 * lose the record.
 */
export function replaceAttributionBlock(body: string, block: string): string {
  const begins = body.split(ATTRIBUTION_BEGIN).length - 1;
  const ends = body.split(ATTRIBUTION_END).length - 1;
  if (begins !== ends || begins > 1) {
    throw new Error("the PR body's verify-attribution markers are unpaired or repeated");
  }
  if (begins === 0 && block === "") return body;
  const stripped = body.replace(BLOCK_RE, "\n").replace(/\s+$/, "");
  return block === "" ? `${stripped}\n` : `${stripped}\n\n${block}\n`;
}
