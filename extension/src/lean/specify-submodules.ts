/**
 * lean/specify-submodules — populating the submodules a reset left empty, from the
 * bytes this superproject already holds.
 *
 * `git clean -fdx` de-populates every submodule the base carries, so every lean reset has to
 * put them back or the child is handed a test it cannot collect — an import from an empty
 * directory dies before the runner names the file. Hence the call sits on the reset path,
 * inside `resetWorktreeToBase`, rather than at the six places a reset happens.
 *
 * The question git is asked is "populate this gitlink", and git's default answer is a CLONE
 * FROM THE RECORDED URL. On a machine with no network — the benchmark trial, an air-gapped
 * runner, a remote that went away — that is an exit-10 handback about a transport, for bytes
 * the host already holds: in the submodule's checkout, or in the module store under
 * `.git/modules/<name>`. The local rule asks for the same thing with one word changed — the
 * source is the superproject's own copy, COMPUTED HERE from paths of this superproject and
 * never read out of repo content (`.gitmodules` is content of the base, and the submodule's own
 * `.gitmodules` is content of ANOTHER repository, so neither says where to fetch). Nothing on
 * disk is rewritten: `.gitmodules` keeps the base's URL and the superproject keeps its own
 * config, because a step that fixed the next run by mutating the repository it was handed would
 * be hiding that it could.
 *
 * DEPTH keeps the transport licence narrow: only the first level is seeded, and only the one
 * `git submodule update` carrying a URL computed here gets `protocol.file.allow` —
 * command-line `-c`, never a config file, so the widening cannot outlive the call. A nested
 * level is used only when this superproject already holds it, so nothing deeper is ever
 * fetched that is not already on disk; a deeper submodule with no local copy is disclosed by
 * path rather than fetched.
 *
 * A submodule the superproject has NEVER had is not fetched either — a trial host has no
 * network to reach it. That is a DISCLOSURE, not a failure: the run proceeds and the path is
 * named, since "the base's verify ran without it" is the honest answer and a child's red
 * tests are not evidence of a missing submodule.
 *
 * Two gates decide the call, and they are not peers. `PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT=0`
 * (`lean/runner-preflight-switch.ts`) is the OUTER one and wins: no submodule code runs at
 * all, since "do not ask this runner to populate anything" makes WHERE moot. Only when it is
 * open does `PI_ENSEMBLE_LEAN_SUBMODULES_LOCAL` (`lean/submodules-local-switch.ts`) decide —
 * on, the local rule above; `0`, the release's own single call, byte for byte.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import type { ExecFn } from "../worktree.ts";
import { leanRunnerPreflightEnabled } from "./runner-preflight-switch.ts";
import { trim } from "./specify-proof.ts";
import { NO_HOOKS, SpecifyInfraError } from "./specify-reset.ts";
import type { SubmoduleEntry } from "./submodule-entries.ts";
import { gitDirsOf, listSubmodules, localSource, superprojectRoot } from "./submodule-entries.ts";
import { firstTrackedFile } from "./submodule-expect.ts";
import { ask, handback, run } from "./submodule-reads.ts";
import { describe } from "./submodule-verify.ts";
import { leanSubmodulesLocalEnabled } from "./submodules-local-switch.ts";

/** The wall clock on the short reads that decide where a submodule comes from. */
const QUICK_GIT_MS = 30_000;

/** The command as the operator knows it, and as the switch-off handback has always named it. */
const UPDATE_COMMAND = "git submodule update --init --recursive";

/**
 * What the pass did to one submodule, as the step that owns the tree reports it.
 *
 * `seeded` says where the bytes came from and names one file the base's own commit holds
 * inside the submodule, so the caller can check that something arrived; `absent` says they
 * were never on this host. A submodule git was ASKED for and refused is not in this list —
 * it throws, because an unreachable remote is infrastructure and must not be paid to the
 * adversary.
 *
 * This is the value `resetWorktreeToBase` returns, so every step that resets a tree can put
 * the clause in ITS reason: `challenge`, `build`'s fold and the review fix round each
 * compose their own outcome line, and a disclosure that only the worktree's owner could
 * see would be invisible in the two steps whose verdicts read worst without it.
 */
export interface SubmoduleNote {
  /** The submodule's path, as `.gitmodules` registers it. */
  path: string;
  /**
   * `seeded` — restored from a path of this superproject; `absent` — nothing here held
   * it; `failure` — git refused the pass for a reason this step did not classify, which
   * leaves the tree holding an empty gitlink exactly as `absent` does.
   */
  kind: "seeded" | "absent" | "failure";
  /**
   * For a seeded one, the source git was pointed at. An absent or failed path is disclosed by
   * PATH — the only form an operator can act on — so those carry nothing here.
   */
  detail: string;
  /**
   * The file that must exist inside a seeded submodule for its checkout to be usable.
   *
   * Only ever set by the seeding arm, from the submodule's own recorded commit, and only
   * when git named a file to look for: the claim the disclosure rests on is "this path
   * came back", and a clone that completes out of a source whose branch was emptied
   * satisfies every part of that claim while handing the child a directory with nothing
   * in it. Checking one path the base's own commit names is git's answer, not a guess
   * about what a vendored repository ought to contain — and a submodule with no committed
   * files at all sets nothing, which is that repository's fact rather than this step's.
   */
  expect?: string;
  /**
   * Set by the reset when a seeded submodule's checkout does not hold `expect` — the seeded
   * form of the silence this module exists for: the pass cloned something and has nothing to
   * object to, while the tree holds an empty directory. The read is the submodule's own
   * commit, asked of the tree rather than of the source the step chose, so a source that
   * quietly lost its content cannot pass as one that supplied it.
   */
  emptyCheckout?: boolean;
  /**
   * Submodule paths git itself reported as having no git dir behind them, when this step's
   * own pass finished without saying anything about them.
   *
   * Only ever set by the reset, on the notes it returns, and only for a pass that reported
   * nothing: `git submodule status` is asked of the tree afterwards and answers `U` for a
   * gitlink with no git dir — the one read that survives a step whose own bookkeeping was
   * silent. Without it a disclosure written from these notes says "no submodules" about a
   * tree that has one, and silence is never a pass.
   */
  unproven?: readonly string[];
}

/**
 * The reason-line clause for what a reset's submodule pass could not supply, or `undefined`
 * when there is nothing to say — empty for a seeded tree and for one with no submodules at
 * all, so a caller folds it into a `joinNotes` list unconditionally. Every kind but `seeded`
 * is named: a seeded submodule is the step working, not a caveat, and `failure` counts as
 * unpopulated because an unclassified refusal leaves the tree holding exactly that.
 */
export function submoduleNoteClause(notes: readonly SubmoduleNote[]): string | undefined {
  // `notesFor` is what git reported rather than what the pass reported, and it is the one
  // read that cannot be talked into silence: a pass whose own command failed still leaves
  // the path there, so a step whose notes came back empty says so instead of reporting a
  // tree with a submodule in it as if the submodule were there.
  const unpopulated = new Set<string>();
  for (const n of notes) if (n.kind !== "seeded") unpopulated.add(n.path);
  for (const p of notes.flatMap((n) => n.unproven ?? [])) unpopulated.add(p);
  for (const n of notes) if (n.emptyCheckout === true) unpopulated.add(n.path);
  if (unpopulated.size === 0) return undefined;
  const named = [...unpopulated].map((p) => `"${p}"`).join(", ");
  const local = unpopulated.size < notes.length ? "some " : "";
  return `${local}submodules are not populated: ${named} — nothing on this host could supply them; the base commit's verify ran without them too`;
}

/**
 * Unpopulated notes for paths git itself says have no git dir behind them — the other half of
 * the pair with {@link submoduleState}, turning what git printed into the same notes the pass
 * produces so a disclosure can be written from git's answer when the step's account has none.
 */
export function notesFor(unpopulated: readonly string[]): SubmoduleNote[] {
  return unpopulated.map((p) => ({ path: p, kind: "failure" as const, detail: "" }));
}

/**
 * The submodule facts of `wt` as git sees them: every path its commit registers, and
 * which of them have no git dir behind them.
 */
export interface WorktreeSubmoduleState {
  /** Every submodule the worktree's commit registers, in `.gitmodules` order. */
  readonly registered: readonly string[];
  /** Which of those git has no git dir for, so nothing is checked out. */
  readonly unpopulated: readonly string[];
}

/**
 * Ask the tree what it holds, for the case that must not be taken on trust. Where
 * {@link submoduleNoteClause} reports what THIS step did, this reports what git can see — and
 * only a control that reads the tree can tell a seeded submodule from one the pass merely
 * claimed. `submodule status` is git's own answer: `U` marks a gitlink with no git dir behind
 * it, exactly the state an unseeded submodule has to be left in.
 */
export async function submoduleState(
  exec: ExecFn,
  wt: string,
): Promise<WorktreeSubmoduleState | undefined> {
  if (!existsSync(path.join(wt, ".gitmodules"))) return undefined;
  const status = await exec("git", {
    // Per-path output is requested with `--` rather than read from a `--recursive` sweep:
    // a recursive status walks into seeded submodules and asks git to describe levels that
    // are not this tree's to report. It fetches nothing, so it is no exposure — but it put
    // the word `--recursive` on the argv of a suite whose point is that no submodule command
    // of this step's ever recurses.
    argv: [...NO_HOOKS, "submodule", "status"],
    cwd: wt,
    timeout: QUICK_GIT_MS,
    maxBuffer: 1024 * 1024,
  }).catch(() => undefined);
  if (status === undefined) return undefined;
  const registered: string[] = [];
  const unpopulated: string[] = [];
  for (const line of ((status as { stdout?: string }).stdout ?? "").split("\n")) {
    // `<sha> <path> (<describe>)[-tags]` for a populated one; the same shape with a
    // leading `U` and no describe for a gitlink whose git dir is gone. A leading `+` is
    // a checked-out submodule at a DIFFERENT sha — a different defect, not this read's —
    // and `-` is de-init, which the pass's own `--init` covers.
    const hit = /^([-+U ])(?:[0-9a-f]{40})?\s+(\S+)/.exec(line);
    if (hit?.[1] === undefined || hit[2] === undefined) continue;
    registered.push(hit[2]);
    if (hit[1] === "U") unpopulated.push(hit[2]);
  }
  return registered.length === 0 ? undefined : { registered, unpopulated };
}

/**
 * Populate the worktree's submodules, when its commit has any, and say what was done
 * to each of them.
 *
 * Never throws for a submodule this host does not hold; throws `SpecifyInfraError` only
 * when git was ASKED to populate something and refused — on the local arm a source that
 * exists and still would not clone, on the switch-off arm the ordinary unreachable
 * remote.
 *
 * `beforeInit` is the smoke tests' seam, threaded from `resetWorktreeToBase`; it fires
 * only when a real submodule command would have run.
 */
export async function initSubmodules(
  exec: ExecFn,
  wt: string,
  beforeInit?: (wt: string) => void | Promise<void>,
): Promise<SubmoduleNote[]> {
  // The outer gate. With the runner untrusted there is no listing, no seeding and no
  // disclosure read: the step asks git to populate NOTHING, which is what the switch's
  // own claim is, and it holds for every one of the six reset call sites.
  if (!leanRunnerPreflightEnabled()) return [];
  if (!existsSync(path.join(wt, ".gitmodules"))) return [];
  const listed = await listSubmodules(exec, wt);
  if (listed === undefined) return [];
  await beforeInit?.(wt);
  if (!leanSubmodulesLocalEnabled()) return updateFromRemote(exec, wt);
  const notes = await seedFromSuperproject(exec, wt, listed);
  // The seeding arm's defining claim is negative: it never hands a recorded URL to git, and a
  // negative is not observable from a passing run. So where a submodule had nothing to seed
  // from, one `submodule status` per absent path settles two questions at once:
  //
  //   - did something FETCH it? An unseeded gitlink has no git dir behind it (`U` in git's own
  //     output); anything else means something populated it, and on this arm the only thing
  //     that could is a fetch from the recorded URL. A case asserting "no network" therefore
  //     has an observation, and a step that quietly reached for the URL is red with the argv.
  //   - or did the RUN create it? A store filed under this tree's own gitdir is invisible to
  //     `clean -fdx`, so a submodule the run added on its own branch arrives as a populated path
  //     nobody seeded — the child's own bytes, never verified. Refused too, or a verdict lands on
  //     vendored code from nowhere anybody checked; git's line rides on the message.
  //
  // An unreadable line is evidence of neither, and "could not tell" proceeds with the ordinary
  // disclosure, which stays honest in the other direction. One local call, on a path that had
  // nothing to do.
  for (const note of notes.filter((n) => n.kind === "absent")) {
    const status = await ask(exec, wt, [...NO_HOOKS, "submodule", "status", "--", note.path]);
    const line = (status?.stdout ?? "").split("\n")[0] ?? "";
    if (line === "" || line.startsWith("U") || line.startsWith("-")) continue;
    throw new SpecifyInfraError(
      `the submodule at ${note.path} was added inside this run's own worktree, so this superproject never held it: the only source on this host is the tree under test, and bytes nobody verified cannot carry a verdict. Seed it in the superproject, or set PI_ENSEMBLE_LEAN_SUBMODULES_LOCAL=0 and let git fetch the URL the base records. git's line, which tells this from a fetch: ${trim(line)}`,
    );
  }
  return notes;
}

/**
 * The switch-off arm: the release's own call, unchanged. One `submodule update --init
 * --recursive` with no `-c` beyond the hook refusals, so git applies its OWN transport policy,
 * and its failure is the handback this message has always carried — including the words of the
 * command, which the case asserting byte-for-byte equality with the pre-fix code depends on.
 * The listing probe has already run by then, as it did then, so the argv the operator sees is
 * the argv of that release.
 */
async function updateFromRemote(exec: ExecFn, wt: string): Promise<SubmoduleNote[]> {
  const failed = await run(exec, wt, [...NO_HOOKS, "submodule", "update", "--init", "--recursive"]);
  if (failed !== undefined) throw handback(wt, failed, UPDATE_COMMAND);
  return [];
}

/**
 * The local arm: every submodule comes from this superproject, or is named as absent — never
 * from the network. Per submodule, in order: the module store under the superproject's git dir
 * (`<common>/.git/modules/<path>`, and the per-worktree form for a tree git made with `worktree
 * add`), then the superproject's own populated checkout, then nothing. Either is the same bytes
 * the base's verify ran against, so the worktree's tests see what the base's saw. The first
 * level only: the call carrying a source computed here is the one call given the `file` licence,
 * and a nested level is reached through it only because this superproject already holds it.
 *
 * All of it is argv: a path is a git argument here, never a word a shell re-parses.
 */
async function seedFromSuperproject(
  exec: ExecFn,
  wt: string,
  listed: SubmoduleEntry[],
): Promise<SubmoduleNote[]> {
  // The SUPERPROJECT, asked of git (`superprojectRoot`) rather than assumed from the caller's
  // path, and its git dirs (`gitDirsOf`): a linked worktree's own gitdir holds only what THIS
  // tree cloned, while the shared store under the superproject holds what the operator's
  // checkout populated — the bytes the base's verify ran against.
  const superproject = await superprojectRoot(exec, wt);
  const superGitDirs = await gitDirsOf(exec, superproject);
  // The git dirs the seeding may read a store from: the superproject's own answers, plus this
  // tree's `--git-common-dir` ONLY when it is byte-for-byte one of them — git saying "this is
  // the shared store", not the run naming a directory it wants trusted. A git dir unique to the
  // run tree is never admitted: a submodule added inside a linked worktree is filed there, holds
  // only what this run committed, and seeding from it would call a path the superproject never
  // held `seeded`. `localSource` refuses the same store where it is read; this is the guard that
  // keeps a probe this step issues from even offering it.
  const readDirs = new Set<string>(superGitDirs);
  for (const dir of await gitDirsOf(exec, wt)) {
    if (superGitDirs.includes(dir)) readDirs.add(dir);
  }
  const gitDirs = [...readDirs];
  const notes: SubmoduleNote[] = [];
  for (const entry of listed) {
    const source = localSource(superproject, gitDirs, entry.path, { wt });
    if (source === undefined) {
      // Nothing on this host held the submodule: the run proceeds and the clause names the path,
      // which is what distinguishes this from a submodule the step FAILED to restore — that one
      // throws.
      notes.push({
        path: entry.path,
        kind: "absent",
        detail: "no module store and no populated path in the superproject",
      });
      continue;
    }
    // Three commands. The WHY of each, of the licence and of `set-url` over a `-c` override is
    // the switch header's (`submodules-local-switch.ts`); what this code has to hold locally is
    // that the licence is command-line `-c`, so it cannot outlive an invocation, and that it
    // appears only on the calls consuming a source THIS module named — never one from repo
    // content, and never with `--recursive`, so no level below the one named is cloned.
    //
    // `set-url` REWRITES `.gitmodules` in this work tree; `resetWorktreeToBase` restores the
    // file from the base commit when the pass seeded anything, so the seed leaves nothing
    // behind that the clean-tree proof would (rightly) refuse the tree for.
    const registered = await run(exec, wt, [...NO_HOOKS, "submodule", "init", "--", entry.path]);
    if (registered !== undefined)
      throw handback(wt, registered, `git submodule init -- ${entry.path}`);
    const retargeted = await run(exec, wt, [
      ...NO_HOOKS,
      "submodule",
      "set-url",
      "--",
      entry.path,
      source,
    ]);
    if (retargeted !== undefined)
      throw handback(wt, retargeted, `git submodule set-url -- ${entry.path}`);
    const failed = await run(exec, wt, [
      ...NO_HOOKS,
      "-c",
      // The licence for THIS call only, and only because the source is a path this
      // module computed rather than a URL some repo's content named. See the header.
      "protocol.file.allow=always",
      "submodule",
      "update",
      "--",
      entry.path,
    ]);
    if (failed !== undefined) {
      // git's OWN reason is carried verbatim: it is the only thing that tells an operator
      // which of three repairs this is — a transport refusal (turn the rule off and let git
      // fetch), an object no local copy holds, or a checkout that could not be written. A
      // message naming only the command makes all three read alike, and the fixes differ.
      // The command is named as the operator knows it, not as this call was spelled.
      throw handback(wt, failed, UPDATE_COMMAND);
    }
    notes.push({
      path: entry.path,
      kind: "seeded",
      detail: source,
      // One path from the submodule's OWN recorded commit, checked against the tree by the
      // reset. Never a path inside the SOURCE: the source may be the module store, whose own
      // tree holds no submodule files, and joining the two would call every seed empty.
      expect: await firstTrackedFile(exec, wt, entry, source),
    });
  }
  return notes;
}
