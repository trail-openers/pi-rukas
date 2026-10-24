/**
 * public-hygiene-publish-shapes — the text patterns that say "this command
 * publishes" without deciding what it publishes (#1788 round 6).
 *
 * `public-hygiene-verbs.ts` reads a publish command word by word and refuses
 * anything it cannot read. This module asks a much dumber question of the RAW
 * command text: does it LOOK like a publish? One pattern per publish family,
 * each the same noun/verb set the verb readers use, loosened only enough to
 * survive the word split going wrong — which is precisely the case where a
 * careful reader sees nothing and the command publishes unchecked.
 *
 * ## What it is for, and what it is not
 *
 * Its commit arm over-matches on purpose: a bare `-m`/`-F` with no value at all,
 * a cluster whose tail swallows the delimiter (`-amSECRET`), and the `-c`/`-C`
 * reuse forms the reader refuses outright are all shapes here, because this is
 * the view that survives a word split gone wrong — and a cluster the reader did
 * read has already set `scan.publishes`, which short-circuits the backstop.
 *
 * It is a backstop trigger, never a verdict: it decides whether the guard owes
 * the operator an explanation, never whether a piece of text is clean. A shape
 * match with a readable surface is ordinary prose and nothing here fires; a
 * shape match with NO surface the scan could read is a refusal. Matching on
 * text rather than on argv is the whole design — a shape the argv reader could
 * see would not need a backstop.
 *
 * ## GitHub only
 *
 * The publish shapes name `gh` and `git`, the two CLIs the guard scans. A
 * `glab` publish is not scanned anywhere in this guard (issue decision 3 puts
 * the forge boundary at github.com); `merge-guard.ts` is the guard that refuses
 * a `glab` merge, and this module is not the place a second forge silently
 * joins the publish tables.
 */

/** `gh pr|issue|release create|comment|edit|review` — the nouns and verbs that publish text. */
export const GH_PUBLISH_TEXT_SHAPE =
  /\bgh\s+(?:-R\s+\S+\s+)?(?:pr|issue|release)\s+(?:create|comment|edit|review)\b/;

/** A `gh api` field flag: the form that puts a value on the command line. */
export const GH_API_FIELD_SHAPE = /(?:^|\s)(?:-f|-F|--field|--raw-field|--input)(?:=|\s)/;

/** `gh api` — the CLI whose writes go through a path rather than a noun/verb. */
export const GH_API_SHAPE = /\bgh\s+api\b/;

/** `git … commit` — the verb that records a message. */
export const GIT_COMMIT_SHAPE = /\bgit\b[\s\S]*\bcommit\b/;

/**
 * A `git commit` message flag: the form that carries the message text. The
 * delimited forms (`-m x`, `-m=x`) plus any bundled short cluster containing
 * `m`/`F` (`-am`, `-qmx`, `-aF`), which carries its message with NO delimiter —
 * getopt treats `m` as the last option of the cluster, so `git commit -amSECRET`
 * is a publish and a delimiter-after-`-m` rule never saw it (#1792 follow-up).
 */
export const GIT_COMMIT_MESSAGE_SHAPE =
  /(?:^|\s)(?:-[A-Za-z]*[mF][A-Za-z]*|--message|--file)(?:=|\s|$)/;

/**
 * Does the RAW command text look like one of the three publish families?
 * Deliberately over-matches: `echo gh pr comment 3 --body x` is a shape, and
 * the caller's "did the scan see anything?" question is what decides whether
 * anything is said about it.
 */
export function looksLikePublish(raw: string): boolean {
  if (GH_PUBLISH_TEXT_SHAPE.test(raw)) return true;
  if (GH_API_SHAPE.test(raw) && GH_API_FIELD_SHAPE.test(raw)) return true;
  return GIT_COMMIT_SHAPE.test(raw) && GIT_COMMIT_MESSAGE_SHAPE.test(raw);
}

/**
 * The refusal for a publish the scan could not see at all — a wrapper, an
 * interpreter, or any shape the argv reader does not reach. Named by what the
 * operator can change, since the guard cannot name the command it could not
 * read without quoting the text it is refusing to publish.
 */
export function unseenPublishReason(): string {
  return [
    "Refused: this command looks like a publish, but the public hygiene guard could not see the",
    "publish in it — no title, body, comment, field or commit message was reachable to check.",
    "An unchecked publish is not a clean one, so this is a refusal rather than a pass.",
    "Run `gh` or `git` directly (without a wrapper or an interpreter such as `sudo`, `env`,",
    "`timeout`, `xargs`, `watch` or `python3 -c`), and pass the text with --body-file (for",
    "`gh api`, -F field=@file). If this publish is genuinely fine, an operator can set",
    "PI_ENSEMBLE_PUBLIC_HYGIENE=0.",
  ].join("\n");
}
