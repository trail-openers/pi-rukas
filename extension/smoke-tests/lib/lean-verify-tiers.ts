/**
 * lib/lean-verify-tiers — the tier commands a verify case configures.
 *
 * A verify tier is an opaque shell string, so the ONLY way a case makes the step see a
 * particular process outcome is to run a script that really produces it. These builders are
 * the shapes a numeric exit code cannot fake: a killed second process, a first process red
 * and a second green, a tier that disturbs the tree after the step read it clean. Each is a
 * real `sh` spawn, never a stubbed answer, because a case that excuses a tier must have made
 * the step actually run it.
 */

/** A tier command that succeeds. */
export const PASS_TIER = "true";
/** A tier command that fails loudly, so a red reason has a tail worth naming. */
export function failTier(marker: string): string {
  return `sh -c 'echo tier-said-${marker} 1>&2; exit 1'`;
}
/** A tier that outlives any bound a test can wait for. */
export const HANG_TIER = "sleep 60";
/**
 * A tier whose SECOND process is killed rather than exited — the timeout/kill shape.
 *
 * The one shape a numeric `code` cannot fake: a run that was signalled has no exit code
 * at all (`code: null`, `killed: true`), and an excuse may not be built on it. Its own
 * counter decides which process dies, so the first is a real red and the second is
 * really signalled, exactly as a hung re-run is under the executor's `killGroup`.
 */
export function killOnSecondTier(marker: string, counter: string): string {
  return `sh -c 'n=$(cat ${counter} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${counter}; if [ "$n" -le 1 ]; then echo tier-said-${marker} 1>&2; exit 1; fi; exec sleep 60'`;
}
/**
 * A tier that fails its first process and succeeds from its second — a real flake.
 *
 * The count lives in a file the script itself bumps, so a re-run is a SECOND SPAWN and
 * not a stubbed answer: a case that excuses a tier as flaky must have made the step
 * actually run it twice, which is the only evidence that distinguishes a flake from a
 * red the step chose not to look at a second time. `counter` is the absolute path of a
 * file no one else writes.
 */
export function flakeTier(marker: string, counter: string): string {
  return `sh -c 'n=$(cat ${counter} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${counter}; if [ "$n" -le 1 ]; then echo tier-said-${marker} 1>&2; exit 1; fi; exit 0'`;
}

/**
 * A tier that writes `rel` in the worktree, COMMITTING it when `commit` is set.
 *
 * The re-check cases need a tier that disturbs the tree *after* the step has
 * already read it clean: the pre-tier checks pass, the tier runs, and only the
 * post-tier re-check can see what it did.
 */
export function writeTier(rel: string, text: string, commit = false): string {
  const quoted = `'${text.replace(/'/g, "'\\''")}'`;
  const add = commit
    ? " git add -A >/dev/null; git -c user.name=t -c user.email=t@t commit -q -m tier;"
    : "";
  return `sh -c "printf %s ${quoted} > '${rel}';${add} exit 0"`;
}

/**
 * A tier that leaves HEAD on the same commit but on NO branch.
 *
 * `git rev-parse HEAD` still answers the sha the step recorded, so the moved-HEAD
 * re-check cannot see it; only a branch read can. The tier itself runs `git
 * checkout`, which a test fixture's tier script may do — the step's own shell
 * never does.
 */
export const DETACH_TIER = 'sh -c "git checkout -q --detach; exit 0"';

/**
 * A tier command that fails and PRINTS `names` as pytest failing lines.
 *
 * The shape a bare exit code cannot fake: the baseline excuse compares failing
 * test NAMES between the head run and the base run, so a tier that exits 1 while
 * naming nothing is a tier the excuse must refuse. `marker` keeps the tier's own
 * identity in its output, which is how the other cases recognise their red.
 */
export function pytestFailTier(marker: string, names: readonly string[]): string {
  const printed = names.map((n) => `FAILED ${n} - AssertionError`).join("; ");
  const tally = `=== ${String(names.length)} failed, 0 passed in 0.10s ===`;
  return `sh -c 'echo tier-said-${marker} 1>&2; echo "${printed}" 1>&2; echo "${tally}" 1>&2; exit 1'`;
}
