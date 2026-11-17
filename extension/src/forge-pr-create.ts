/**
 * forge-pr-create — the PR/MR create seam, split out of `forge.ts` at the seam
 * the GitLab argv transport opened (AGENTS.md §12: split, never compress).
 *
 * This is the one forge write whose command shape differs per forge, and the
 * reason the difference is not obvious: `glab mr create` has no positional
 * source branch, no description-from-file flag and no JSON mode, so the GitLab
 * call is issued as argv of the flags that subcommand actually lists and its
 * reply read as plain text — while `gh pr create` stays a shell string taking a
 * body FILE and printing JSON. Pattern-matching one against the other is what
 * produced the invented flags, so the two shapes are written side by side here
 * and judged against the real CLI by `smoke-tests/test-glab-flags.ts`.
 */

import * as cmds from "./forge-commands.ts";
import type { ForgeArgvCmd } from "./forge-commands.ts";
import type { ForgeType } from "./forge-detect.ts";
import {
  asRecord,
  makeMinimalPr,
  mapGhPrWithNumber,
  parsePrNumberFromResponse,
} from "./forge-mapping.ts";
import type { NormalizedPullRequest } from "./forge-types.ts";

/** Run one forge command and map its stdout — the adapter's `run` seam. */
export type ForgeRunCmd = <T>(
  cmd: string | ForgeArgvCmd,
  map: (stdout: string) => T,
  extra?: { env?: NodeJS.ProcessEnv },
) => Promise<T>;

/** Write `body` to a scratch file and hand its path to `use`. */
export type WithBodyFile = <T>(
  name: string,
  body: string,
  use: (file: string) => Promise<T>,
) => Promise<T>;

/**
 * The create itself, after the caller's public-text checks.
 *
 * `run` and `withBodyFile` come from the adapter so the timeout, cwd and buffer
 * policy stay in one place; this module owns only the per-forge command shape and
 * its reply mapping.
 */
export async function createPullRequest(
  forge: ForgeType,
  title: string,
  headBranch: string,
  body: string,
  opts: { baseBranch?: string; draft?: boolean } | undefined,
  run: ForgeRunCmd,
  withBodyFile: WithBodyFile,
  // The env the GitLab create is exec'd with, supplied by the adapter so a test
  // states it rather than inheriting whatever the suite process carries. The
  // production value is `glabCreateEnv()` — see its comment for why an explicit
  // env is what closes this call's stdin.
  createEnv: () => Record<string, string>,
): Promise<NormalizedPullRequest> {
  // An empty body is not a merge request with no description — it is the
  // driver having lost the body, and a create with an empty `-d` (or, worse,
  // `-d -`, which asks glab for an editor) is a record nobody can read. Refused
  // before any command is built, so nothing reaches the forge.
  if (body.trim() === "" || body.trim() === "-") {
    throw new Error(
      `forge pr create: refusing to open a merge request with an empty body (branch ${headBranch})`,
    );
  }
  if (forge === "github") {
    return withBodyFile(`pr-${headBranch.slice(0, 16)}`, body, (file) =>
      run(cmds.prCreateCmd(forge, title, headBranch, file, opts ?? {}), (stdout) => {
        // Tolerate both JSON (from --json flag) and plain-text URL responses.
        const parsed = parsePrNumberFromResponse(stdout);
        if (!parsed) {
          throw new Error(
            `forge pr create: could not parse PR number from response: ${stdout.trim().slice(0, 120)}`,
          );
        }
        try {
          return mapGhPrWithNumber(asRecord(stdout), parsed.number);
        } catch {
          return makeMinimalPr(parsed);
        }
      }),
    );
  }
  // GitLab creates with the body as ONE argv element (no file transport at the
  // versions glab lacks a description-from-file flag), and prints the new MR's
  // URL as plain text on success — so stdout is never JSON.parsed here. The last
  // line carrying `/-/merge_requests/` is the answer; the progress line above it
  // is not. A create that printed no such line created nothing, and saying so
  // beats a number 0 that reads as MR #0.
  const built = cmds.prCreateCmd(forge, title, headBranch, body, opts ?? {});
  return run(
    built,
    (stdout) => {
      const line = stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.includes("/-/merge_requests/"))
        .pop();
      const parsed = line ? parsePrNumberFromResponse(line) : undefined;
      if (!parsed) {
        throw new Error(
          `forge pr create: glab printed no merge request URL: ${stdout.trim().slice(0, 120)}`,
        );
      }
      return makeMinimalPr(parsed);
    },
    // The explicit env strips the forge login and answers "nobody is here"; the
    // argv carries `-y` so the submission prompt is skipped anyway. Closing this
    // call's stdin is `execp`'s argv form, which ends the child's stdin so a
    // prompting CLI reads EOF rather than waiting on a terminal the driver does
    // not have (test-exec-argv-stdin.ts is the pin).
    { env: createEnv() },
  );
}
