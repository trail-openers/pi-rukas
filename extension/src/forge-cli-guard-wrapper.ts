/**
 * forge-cli-guard-wrapper — the `gh`/`glab` answer a non-ops child gets instead of
 * the CLI's own (#2638).
 *
 * Without it, a helper's `glab auth status` answers with glab's own authentication
 * complaint and `gh` answers `HTTP 401: Requires authentication … Try authenticating
 * with: gh auth login`. Both read to an agent as "I am not logged in, so let me fix
 * that", which is the exact move the field report recorded — unset the config-dir
 * variable, read the operator's file, and put its token in the transcript. The
 * wrapper makes the isolated state an END rather than an obstacle: it is a small
 * executable in a directory PREPENDED to the non-ops child's `PATH`, so every `gh`
 * and `glab` the child runs lands here first.
 *
 * It answers EVERY invocation, whatever the subcommand (decision 1), with the one
 * refusal constant (`forge-read-refusal.ts`, shared with the guard so the two
 * voices cannot drift) on **stderr**, and exits non-zero. The real CLIs are never
 * execed, so the test asserts the wrapper's own string and never a CLI's.
 *
 * The one exception is deliberate: a child that is exempt from the read rule (the
 * role that keeps its login) must never be handed this directory at all — see
 * `forgeCliGuardEnv`, which returns no prefix for it. A wrapper that refused for
 * ops would break the role that lands work, and refusing is not its judgement to
 * make: it answers, it does not decide.
 *
 * This is a guardrail against a child's own bad judgement, not a security boundary:
 * a child that names the real binary's absolute path bypasses it, exactly as it
 * bypasses the read guard's command-text rule. `PATH` is otherwise left alone.
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FORGE_READ_SECRET_ENV, FORGE_READ_SOCKET_ENV } from "./child-forge-read-activation.ts";
import { FORGE_PROTECTED_PATHS_ENV } from "./child-forge-read-roots.ts";
import { FORGE_READ_RULE, roleKeepsForgeLogin } from "./forge-read-refusal.ts";

/** The CLI names this wrapper stands in for. */
export const GUARDED_FORGE_CLIS = ["gh", "glab"] as const;

/** The env that switches the PATH prefix off (an operator's escape hatch for a dispatch that must reach the CLI). */
export const FORGE_CLI_GUARD_SWITCH = "PI_ENSEMBLE_FORGE_CLI_GUARD";

/** The child env name that carries the refusal text, so the script holds no prose of its own. */
export const FORGE_CLI_GUARD_REASON_ENV = "PI_ENSEMBLE_FORGE_CLI_GUARD_REASON";

/** Where the wrapper scripts live inside one spawn's dir. */
export const FORGE_CLI_GUARD_DIR = "forge-guard-bin";

/**
 * The wrapper script for one CLI. Its ONLY text is the refusal the harness handed
 * down, so a second spelling of the rule is not possible; the fallback clause
 * covers a hand-run invocation whose env was not set, and repeats the same rule in
 * the child's own words.
 *
 * Two shells are covered by one form: `#!/bin/sh` is what a POSIX host runs, and
 * `printf … >&2` plus `exit 1` are POSIX. No CLI is execed on any path.
 */
export function forgeCliGuardScript(reasonEnv: string, cli: string): string {
  const fallback =
    `Refused: ${FORGE_READ_RULE}. Ask the ops role, which is the only role that keeps a forge login. ` +
    `${cli} is not installed for this child.`;
  return `#!/bin/sh
# pi-rukas #2638 — stands in for \`${cli}\` on a helper child's PATH. Answers, never execs.
if [ -n "\${${reasonEnv}:-}" ]; then
  printf '%s\\n' "\${${reasonEnv}}" >&2
else
  printf '%s\\n' '${fallback}' >&2
fi
exit 1
`;
}

/**
 * Write the wrapper directory for one spawn and return the env that puts it first
 * on the child's `PATH`.
 *
 * Returns `{}` for the role that keeps its login, and for the operator's escape
 * hatch (`PI_ENSEMBLE_FORGE_CLI_GUARD=0`): both cases must land on the real CLI,
 * and the way to guarantee that is to add nothing to `PATH`, not to add a directory
 * and hope the child looks elsewhere first.
 *
 * `reason` is the harness's own refusal text, passed by env name rather than baked
 * in, and `cliNames` lets a caller narrow the set (a host with no glab installed
 * gains nothing from a glab stub — but naming both is harmless and keeps one rule).
 */
export function forgeCliGuardEnv(
  role: string,
  dir: string,
  reason: string,
  source: NodeJS.ProcessEnv = process.env,
  cliNames: readonly string[] = GUARDED_FORGE_CLIS,
): Record<string, string> {
  if (roleKeepsForgeLogin(role)) return {};
  if (source[FORGE_CLI_GUARD_SWITCH] === "0") return {};
  const bin = path.join(dir, FORGE_CLI_GUARD_DIR);
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  for (const cli of cliNames) {
    writeFileSync(path.join(bin, cli), forgeCliGuardScript(FORGE_CLI_GUARD_REASON_ENV, cli), {
      mode: 0o755,
    });
    // `writeFileSync`'s mode applies only when it CREATES the file; an existing
    // entry keeps its bits, and a non-executable stub resolves to "permission
    // denied" rather than the refusal.
    chmodSync(path.join(bin, cli), 0o755);
  }
  const inherited = source.PATH ?? "";
  return {
    [FORGE_CLI_GUARD_REASON_ENV]: reason,
    PATH: inherited === "" ? bin : `${bin}${path.delimiter}${inherited}`,
  };
}

/**
 * The env names the forge rule owns on a child: the harness-owned protected set
 * and the CLI stub's refusal. Exported for the source-scan test, which asserts
 * every env-building site hands all of them down — a site that stamps the role
 * but not the protected set is a site whose child reads unjudged.
 */
export const FORGE_READ_CHILD_ENV_NAMES = [
  FORGE_PROTECTED_PATHS_ENV,
  FORGE_CLI_GUARD_REASON_ENV,
  FORGE_READ_SOCKET_ENV,
  FORGE_READ_SECRET_ENV,
] as const;
