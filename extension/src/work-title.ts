/**
 * work-title — the rules a /work PR title, its commit subject and a /plan issue
 * title share.
 *
 * A title is a complete phrase written by the model that understood the change
 * (explore's `### Title`, the /plan caller's `title`). The driver checks the
 * length and asks once more; when the second answer is still too long it falls
 * back to a source text used whole. Cutting is never the fallback: a cut title
 * reads as a sentence that stops, and the reader cannot tell what the change
 * does. GitHub allows 256 characters, so a long whole title is always valid.
 *
 * The `type(scope):` prefix is the target repository's convention, not the
 * driver's: it is added only when the repo's own recent history uses it, or
 * `PI_ENSEMBLE_CONVENTIONAL_COMMITS` says so.
 */

import type { NormalisedSpec } from "./work-driver-intent.ts";

/** The longest title a model is asked to write, prefix included. */
export const TITLE_BUDGET = 72;

/** How many recent subjects the convention check reads. */
const HISTORY_DEPTH = 20;

const CONVENTIONAL_SUBJECT_RE = /^[a-z]+(\([^)]*\))?!?: \S/;

/** A title the driver uses as given: one non-empty line, within `budget`, not trailing off. */
export function fitsTitle(t: string | undefined, budget = TITLE_BUDGET): t is string {
  if (t === undefined) return false;
  const s = t.trim();
  return s !== "" && !s.includes("\n") && s.length <= budget && !/(?:…|\.\.\.)$/.test(s);
}

/** The title in a model's one-line answer: the first non-empty line, with a list
 * marker, a `Title:` label, bold and wrapping quotes or backticks removed. */
export function readTitleAnswer(text: string): string | undefined {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  if (line === undefined) return undefined;
  const s = line
    .replace(/^(?:[-*]|\d+[.)])\s+/, "")
    .replace(/^\**title\**\s*:\s*\**/i, "")
    .replace(/^["'`“*]+|["'`”*]+$/g, "")
    .trim();
  return s === "" ? undefined : s;
}

/** The one follow-up a too-long or missing spec title gets. */
export function titleReaskPrompt(previous: string | undefined): string {
  const was =
    previous === undefined || previous.trim() === ""
      ? "Your spec had no `### Title`."
      : `Your spec's title is ${previous.trim().length} characters: ${JSON.stringify(previous.trim())}.`;
  return `${was} Reply with exactly one line: a complete phrase of at most ${TITLE_BUDGET} characters that says what the change does. No type prefix, no quotes, no trailing ellipsis, nothing else.`;
}

/**
 * Keep the spec's title when it fits; otherwise ask once more through `ask`.
 * An answer that still does not fit drops the title, and the PR falls back to
 * the whole issue title. `ask` is absent where there is no session to resume.
 */
export async function settleSpecTitle(
  spec: NormalisedSpec,
  ask: ((prompt: string) => Promise<string | undefined>) | undefined,
): Promise<NormalisedSpec> {
  if (fitsTitle(spec.title)) return { ...spec, title: spec.title.trim() };
  const { title: previous, ...rest } = spec;
  if (ask === undefined) return rest;
  const answer = readTitleAnswer((await ask(titleReaskPrompt(previous)).catch(() => "")) ?? "");
  return fitsTitle(answer) ? { ...rest, title: answer } : rest;
}

/**
 * Does the target repository write conventional-commit subjects?
 *
 * `PI_ENSEMBLE_CONVENTIONAL_COMMITS=1|0` decides outright. Otherwise the last
 * {@link HISTORY_DEPTH} non-merge subjects at `ref` (the cycle's base commit)
 * decide by majority. A history that cannot be read keeps the prefix, which is
 * what the driver wrote before it read history at all.
 */
export async function usesConventionalCommits(
  repoRoot: string,
  ref: string | undefined,
  execFn: (cmd: string, o?: { cwd?: string; maxBuffer?: number }) => Promise<{ stdout: string }>,
): Promise<boolean> {
  const forced = process.env.PI_ENSEMBLE_CONVENTIONAL_COMMITS;
  if (forced === "1") return true;
  if (forced === "0") return false;
  const at = ref !== undefined && /^[0-9a-f]{7,40}$/.test(ref) ? ref : "HEAD";
  let subjects: string[];
  try {
    const { stdout } = await execFn(`git log -n ${HISTORY_DEPTH} --no-merges --format=%s ${at}`, {
      cwd: repoRoot,
      maxBuffer: 256 * 1024,
    });
    subjects = stdout.split("\n").filter((s) => s.trim() !== "");
  } catch {
    return true;
  }
  if (subjects.length === 0) return true;
  const conventional = subjects.filter((s) => CONVENTIONAL_SUBJECT_RE.test(s)).length;
  return conventional * 2 > subjects.length;
}
