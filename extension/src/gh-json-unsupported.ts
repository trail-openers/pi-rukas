/**
 * gh-json-unsupported — the named refusal for a `gh` that has no `--json` on
 * the subcommand a forge read asked it of.
 *
 * Every `gh` read of CI evidence requests `--json` (`prChecksCmd`,
 * `mergeEvidenceViewCmd`), and gh builds older than that flag on `pr checks`
 * (Ubuntu's 2.46.0, for one) answer exit 1 `unknown flag: --json`. Every reader routes
 * that answer through this seam so the refusal names the gh version and the
 * command, letting an operator tell a gh too old for the gate from a broken
 * setup.
 *
 * It names the fault and never reads around it. The table `gh pr checks`
 * prints without `--json` carries no completeness signal, so grading the rows
 * that happened to arrive could turn a missing failing check into a merge; the
 * only outcome of this read is a refusal, and every caller keeps failing closed.
 *
 * The predicate keys on gh having ANSWERED: a numeric exit code and gh's own
 * `unknown flag: --json` text. A kill, a timeout or an executor that never ran
 * carries no numeric code and stays the caller's plain tooling refusal.
 */

/** The version probe. Callers that decorate every argv (the merge guard's `-R`) exempt it. */
export const GH_VERSION_CMD = "gh --version";

/**
 * The operator-facing reason when `err` is gh rejecting `--json` on `cmd`, or
 * `undefined` for any other failure. `read` runs a command and answers its
 * stdout; it is the caller's own executor, so the probe gets the caller's cwd,
 * env and bound. A probe that fails reports the version as unknown — the
 * refusal stands either way.
 */
export async function ghJsonUnsupportedReason(
  err: unknown,
  cmd: string,
  read: (cmd: string) => Promise<string>,
): Promise<string | undefined> {
  const e = err as { code?: unknown; stderr?: unknown; message?: unknown } | null;
  if (typeof e?.code !== "number") return undefined;
  if (!`${e.stderr ?? ""}\n${e.message ?? ""}`.includes("unknown flag: --json")) return undefined;
  const version = await read(GH_VERSION_CMD).then(
    (out) => /gh version (\S+)/.exec(out)?.[1],
    () => undefined,
  );
  const gh = version ? `gh ${version.slice(0, 40)}` : "gh (version unknown)";
  return `${gh} does not accept --json on \`${cmd}\` (unknown flag: --json); upgrade gh, then re-run`;
}
