/**
 * boilerplate-detect — scan AGENTS.md content for existing boilerplate
 * section headings. Split from update-agent.ts to stay under the 500-line
 * hard limit (§12 AGENTS.md).
 */

import { SCAFFOLD_HEADING_MAP } from "./scaffold.ts";

/**
 * Scan the current file for existing boilerplate section headings so the
 * scaffold post-pass can detect already-present sections (idempotency).
 *
 * Matches headings flexibly — tolerates different heading levels (# vs ##),
 * optional whitespace after the hash, bolded hashes (**# Heading**), and
 * trailing parentheticals or notes. This is important because brownfield
 * files rarely conform to the exact "# Heading" format the scaffold emits.
 *
 * Uses SCAFFOLD_HEADING_MAP from scaffold.ts so the name↔id mapping lives
 * in one place (#593 #1).
 */
export function detectExistingBoilerplate(fileContent: string): Set<string> {
  const ids = new Set<string>();
  for (const line of fileContent.split("\n")) {
    const trimmed = line.trim();
    const clean = trimmed.replace(/^\*+|_+/g, "").trim();
    for (const [name, id] of SCAFFOLD_HEADING_MAP) {
      const re = new RegExp(
        `^(#{1,6})\\s+${name.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`,
        "i",
      );
      if (re.test(clean)) {
        ids.add(id);
        break;
      }
    }
  }
  return ids;
}
