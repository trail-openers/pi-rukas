/**
 * work-driver-protected-paths-status — the uncommitted half of the protected-path
 * read: `git status --porcelain -z --untracked-files=all` and its parser. Split
 * from `work-driver-protected-paths-read.ts` for the file cap (AGENTS.md §12) along
 * the seam the module header already drew: the two readers are deliberately NOT one
 * parser over two layouts, so they are not one file either.
 *
 * Why `-z` is the whole point: with the default `--porcelain` git C-quotes
 * a non-ASCII name (`".github/workflows/w\303\266rkflows.yml"`) and collapses a
 * wholly-untracked directory to `?? .github/`. The gate then compared escape
 * sequences against the operator's grant, and a directory is a path no grant can
 * name. `-z` emits the bytes git has on disk, verbatim, and `-uall` lists an
 * untracked directory file by file.
 *
 * A rename/copy under `-z` is `XY new\0orig\0` — the origin is its own token and
 * it is the *second* one. Both sides are returned. A malformed record, or a
 * rename whose origin token is missing, is **unreadable**, not skipped: the
 * tokens after it would be misread as status records, which is a wrong answer
 * rather than a missing one, and the caller halts on it.
 *
 * The executor is the driver's `verifyExecFn` seam and the argv form is not
 * optional — see the header of `work-driver-protected-paths-read.ts` for why a
 * string `cmd` is refused there and `test-exec-argv-contract.ts` enforces it.
 */

import { DEFAULT_GIT_TIMEOUT_MS } from "./git-range.ts";
import { errText } from "./protected-paths-text.ts";
import {
  PROTECTED_READ_MAX_BUFFER,
  PROTECTED_STATUS_ARGV,
  type ProtectedPathExec,
  type StatusRead,
} from "./work-driver-protected-paths-read.ts";

/** Porcelain v1 is `XY PATH`: at least four chars with a space at index 2. */
function isMalformedStatusToken(tok: string): boolean {
  return tok.length < 4 || tok[2] !== " ";
}

/**
 * Read the uncommitted change set with `status --porcelain -z --untracked-files=all`.
 *
 * Returns every path git reports, both sides of a rename included. The
 * protected-path gate is the only consumer allowed to see a rename source (see
 * the header of the module this was split from); the verify-skip, falsily-green
 * and fanout verdicts take their paths from the committed reader instead.
 */
export async function readProtectedStatusPaths(
  exec: ProtectedPathExec,
  cwd: string,
): Promise<StatusRead> {
  let stdout: string;
  try {
    ({ stdout } = await exec("git", {
      argv: [...PROTECTED_STATUS_ARGV],
      cwd,
      maxBuffer: PROTECTED_READ_MAX_BUFFER,
      timeout: DEFAULT_GIT_TIMEOUT_MS,
    }));
  } catch (err) {
    return { ok: false, unreadable: `git status --porcelain -z failed: ${errText(err)}` };
  }
  const tokens = stdout.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i] ?? "";
    // The only legitimate empty token is the one after the final NUL.
    if (tok === "" && i === tokens.length - 1) continue;
    if (isMalformedStatusToken(tok)) {
      return {
        ok: false,
        unreadable: `malformed status entry ${JSON.stringify(tok.slice(0, 80))}`,
      };
    }
    const code = tok.slice(0, 2);
    const path = tok.slice(3);
    if (/[RC]/.test(code)) {
      i++;
      const origin = tokens[i];
      if (origin === undefined || origin === "") {
        return {
          ok: false,
          unreadable: `rename/copy status entry without its origin path: ${JSON.stringify(path.slice(0, 80))}`,
        };
      }
      paths.push(path, origin);
    } else if (path.length > 0) {
      paths.push(path);
    }
  }
  return { ok: true, paths };
}
