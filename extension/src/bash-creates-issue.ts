import { stripQuotedSegments } from "./bash-command-parser.ts";

/**
 * Does this command create a forge issue (or a REST POST that does)?
 *
 * Forge-agnostic (#611): the same two doors, for both `gh` (GitHub) and
 * `glab` (GitLab).
 *
 * The mode-independent issue-creation guard (#598) calls this ahead of every
 * trust/sandbox bypass, exactly like `discardsUncommittedWork`: the
 * permission layers answer "may this role run the forge CLI?" — yes — and the
 * self-judged triviality test that used to gate creation had no oracle. The
 * shapes must all be caught, on the same scan-not-anchor + strip-quoted terms:
 *
 *   - `gh issue create …` / `glab issue create …` (with or without the `oo`
 *     prefix, chained after `cd x && …` or any other command),
 *   - `gh api repos/{o}/{r}/issues` — gh api defaults to POST when body
 *     fields (`-f`) are present, so a "read" that isn't actually a read is a
 *     second door into issue creation. Blocked unless the command EXPLICITLY
 *     says `--method GET`; a GET on a SPECIFIC issue (`…/issues/123`) is a
 *     read and stays open.
 *   - `glab api /projects/{id}/issues` — glab's REST door. glab api does NOT
 *     default to POST the way gh api does, so this door is method-aware:
 *     it is blocked only when the command EXPLICITLY posts (`-X POST`,
 *     `--method POST`, or `-f`/`-F`/`--field` body fields, which glab
 *     converts to a POST/PUT); an unqualified `glab api /…/issues` or an
 *     explicit `--method GET` is a read and stays open, as is a GET on a
 *     SPECIFIC issue (`…/issues/123`).
 *
 * Quoted segments are stripped first, so `echo "gh issue create"` or a PR
 * comment that merely mentions the verb is not blocked.
 */
export function createsIssue(command: string): string | undefined {
  const c = stripQuotedSegments(command);
  const FORGE = "(?:^|[;&|]|\\s)(?:oo\\s+)?(?:gh|glab)\\s+";
  const issueCreate = new RegExp(`${FORGE}issue\\s+create(?:\\s|$)`).exec(c);
  if (issueCreate?.[0]) return issueCreate[0].trim();
  // REST door, gh: `gh api` on the issues COLLECTION (`repos/{o}/{r}/issues`).
  // gh api defaults to POST when body fields (`-f`) are present. A trailing
  // segment (specific issue) or an explicit `--method GET` makes it a read.
  const ghApiMatch = new RegExp(`${FORGE}api\\s+(repos/[^\\s]+)`).exec(c);
  const ghEndpoint = ghApiMatch?.[1] ?? "";
  if (ghApiMatch && /\/issues(?:[?&?#\s]|$)/.test(ghEndpoint)) {
    const rest = c.slice(ghApiMatch.index);
    if (!/\s(?:--method|-X)\s+GET\b/.test(rest)) return (ghApiMatch?.[0] ?? "").trim();
  }
  // REST door, glab: `glab api` on the issues COLLECTION
  // (`/projects/{id}/issues`). glab api does NOT default to POST the way gh
  // api does, so this door is method-aware: blocked only when the command
  // EXPLICITLY posts. An unqualified call, or an explicit `--method`/`-X GET`,
  // is a read.
  const glabApiMatch = new RegExp(`${FORGE}api\\s+(/projects/[^\\s]+)/issues(?:[?#\\s]|$)`).exec(c);
  if (glabApiMatch?.[0] !== undefined) {
    const rest = c.slice(glabApiMatch.index);
    const explicitGet = /\s(?:--method|-X)\s+GET\b/.test(rest);
    const posts =
      /\s(?:-X|-f|-F)\s+POST\b/.test(rest) ||
      /\s--method\s+POST\b/.test(rest) ||
      /\s(?:-f|-F|--field)(?:=|\s)/.test(rest);
    if (!explicitGet && posts) return glabApiMatch[0].trim();
  }
  return undefined;
}
