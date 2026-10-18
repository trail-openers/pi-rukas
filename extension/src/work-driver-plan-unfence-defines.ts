/**
 * work-driver-plan-unfence-defines — #1167: which candidate file DEFINES a
 * symbol the issue named, as opposed to merely mentioning it.
 *
 * Split out of work-driver-plan-unfence-extract.ts for the AGENTS.md §12 line
 * cap. The extraction half answers "what did the issue point at?"; this half
 * answers "of the files `git grep` returned, which one is the definition the
 * issue meant?" — and that second question is the one whose wrong answer
 * removes a fence, so it is the half worth reading carefully.
 *
 * `git grep -l` cannot tell a definition from a reference, so a popular symbol
 * name matches half the repository: every test that calls it, every doc that
 * mentions it. Two filters stand between that list and a fence being lifted.
 *
 *   - Only files under a recognised code directory qualify (`CODE_DIR`).
 *   - Exactly one of them has to carry a DECLARATION line for the name
 *     (`definesSymbol`), not a mention.
 *
 * Zero or several definitions is an ambiguous name: nothing unfences, and the
 * caller records why. Silence there is what lets an extraction bug read as a
 * clean plan, which is the failure this whole module exists to remove.
 */

/**
 * Files that can DEFINE a symbol. Prose and test files MENTION symbols far
 * more often than they define them, and a repo-wide `git grep` for a popular
 * name hits dozens of test files — so an identifier is resolved only against
 * files under a recognised code directory, which is what keeps a
 * widely-mentioned name from resolving to a test that merely calls it.
 */
const CODE_DIR = /(^|\/)(src|lib|app|pkg|cmd|internal|server|client|extension)\//;

/** Declaration keywords that introduce a definition, in the languages at home here. */
const DECL_KEYWORDS =
  "function|const|let|var|class|interface|type|enum|fn|func|def|struct|trait|impl";
const DECL_PREFIX =
  /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:static\s+)?/;

/**
 * A line that DEFINES `name` rather than mentioning it: a declaration keyword
 * immediately followed by the name. The boundary check runs here in
 * TypeScript, not in the grep pattern — `git grep`'s BRE cannot be trusted
 * with `\s`/`\b`, and a silently-unsupported escape turns a definition check
 * into no check at all.
 */
export function definesSymbolLine(line: string, name: string): boolean {
  const stripped = line.replace(/^\s*/, "").replace(DECL_PREFIX, "");
  if (!new RegExp(`^(?:${DECL_KEYWORDS})\\b`).test(stripped)) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^(?:${DECL_KEYWORDS})\\s+${escaped}(?:[\\s({<:=,)]|$)`).test(stripped);
}

/** True when any line of `text` defines `name`. */
export function definesSymbol(text: string, name: string): boolean {
  for (const line of text.split("\n")) {
    if (definesSymbolLine(line, name)) return true;
  }
  return false;
}

/**
 * Narrow a `git grep -l` candidate list to the single file that DEFINES the
 * symbol: only source files qualify, and exactly one of them has to carry a
 * definition line (see this module's header for why a mention never owns a
 * symbol).
 *
 * #1167 round-4 — `report` is REQUIRED, and that is the point. The resolver
 * used to swallow an unreadable candidate in a bare `catch`, so "the `git show`
 * of this file failed" produced the same answer as "no file here defines the
 * symbol" — and the plan then carried the second claim for the first fact. The
 * caller owns the warnings list and the wording, so it hands in the sink.
 * Failing CLOSED is unchanged: a failed read never unfences anything.
 */
export async function resolveDefiningFile(
  name: string,
  candidates: string[],
  read: (file: string) => Promise<string>,
  report: (name: string, why: string) => void,
): Promise<string | undefined> {
  const source = [...new Set(candidates.filter((f) => CODE_DIR.test(f)))];
  const defining: string[] = [];
  const failures: string[] = [];
  for (const file of source) {
    try {
      if (definesSymbol(await read(file), name)) defining.push(file);
    } catch (err) {
      failures.push(`${file}: ${(err as Error)?.message?.slice(0, 80) ?? String(err)}`);
    }
  }
  if (defining.length !== 1 && failures.length > 0) {
    // Reported once per name, with the files that could not be read — the
    // operator's distinction between "this symbol is defined nowhere" and
    // "the pass could not look". A sole definition still wins: one file that
    // READS and DECLARES the symbol is a resolution, and the unreadable
    // siblings are only prose that mentioned it or could not be fetched.
    report(name, couldNotResolveWhy(failures));
  }
  return defining.length === 1 ? defining[0] : undefined;
}

/** The `why` half of the failed-read report, with the files that broke. */
export function couldNotResolveWhy(failures: string[]): string {
  return `could not resolve — ${failures.slice(0, 3).join("; ")}`;
}
