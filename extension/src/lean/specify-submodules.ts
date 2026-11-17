/**
 * lean/specify-submodules — populating the submodules a reset left empty, from the
 * bytes this superproject already holds.
 *
 * `git clean -fdx` de-populates every submodule the base carries, so every lean reset puts them back or the
 * child is handed a test it cannot collect — an import from an empty directory dies before the runner names
 * the file. Hence the call sits on the reset path, inside `resetWorktreeToBase`.
 *
 * Git's default answer to "populate this gitlink" is a CLONE FROM THE RECORDED URL — on a machine with no
 * network, an exit-10 handback about a transport for bytes the host already holds. The local rule asks for
 * the same with one word changed: the source is the superproject's own copy, COMPUTED HERE from paths of
 * this superproject and never read out of repo content (`.gitmodules` is base content, and the submodule's
 * own is content of ANOTHER repository). Nothing is rewritten — the source reaches git ONLY as `-c` on the
 * one invocation that needs it. A step that fixed the next run by mutating the repository it was handed
 * would be hiding that it could.
 *
 * DEPTH keeps the transport licence narrow: only the first level is seeded, and only the `git submodule
 * update` carrying a URL computed here gets `protocol.file.allow` — command-line `-c`, never a config file,
 * so the widening cannot outlive the call. A deeper submodule with no local copy is disclosed by path.
 *
 * A submodule the superproject never had is not fetched either: a DISCLOSURE, not a failure.
 *
 * Two gates decide the call and are not peers. `PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT=0` is the OUTER one and
 * wins: no submodule code runs at all. Only when it is open does `PI_ENSEMBLE_LEAN_SUBMODULES_LOCAL` decide.
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
import { leanSubmodulesLocalEnabled } from "./submodules-local-switch.ts";
import { clipList, oneLine } from "./text-fence.ts";

/** The wall clock on the short reads that decide where a submodule comes from. */
const QUICK_GIT_MS = 30_000;
/** The command as the operator knows it, and as the switch-off handback has always named it. */
const UPDATE_COMMAND = "git submodule update --init --recursive";

/**
 * What the pass did to one submodule. `seeded` says where the bytes came from and names one file the base
 * holds inside it; `absent` says they were never on this host. A submodule git was ASKED for and refused is
 * not listed — it throws, since an unreachable remote is infrastructure.
 *
 * This is what `resetWorktreeToBase` returns, so every step that resets a tree puts the clause in its reason.
 */
export interface SubmoduleNote {
  /** The submodule's path, as `.gitmodules` registers it. */
  path: string;
  /**
   * `seeded` — restored from a path of this superproject; `absent` — nothing here held it; `failure` — git
   * refused the pass for a reason this step did not classify, leaving an empty gitlink as `absent` does.
   */
  kind: "seeded" | "absent" | "failure";
  /**
   * For a seeded one, the source git was pointed at. An absent or failed path is disclosed by PATH — the
   * only form an operator can act on.
   */
  detail: string;
  /**
   * The file that must exist inside a seeded submodule for its checkout to be usable. Set only by the
   * seeding arm, from the submodule's own recorded commit: a clone out of a source whose branch was emptied
   * satisfies every other part of the disclosure while handing the child an empty directory. One path the
   * base's commit names is git's answer, not a guess.
   */
  expect?: string;
  /**
   * Set by the reset when a seeded submodule's checkout does not hold `expect`: the pass cloned something
   * and has nothing to object to, while the tree holds an empty directory. Read of the tree, not the source.
   */
  emptyCheckout?: boolean;
  /**
   * Paths git itself reported as having no git dir behind them, for a pass that finished silent about them.
   * Set only by the reset, from `git submodule status`. Without it a disclosure says "no submodules" about a
   * tree that has one.
   */
  unproven?: readonly string[];
  /**
   * Set when a read this step depends on could not be answered. An absent answer is information; a thrown
   * read is an outage, and the two must not reach the caller as one value.
   */
  unreadable?: boolean;
}

/**
 * The reason-line clause for what a reset's submodule pass could not supply, or `undefined` when there is
 * nothing to say. Every kind but `seeded` is named; `failure` counts as unpopulated because an unclassified
 * refusal leaves the tree holding exactly that.
 */
export function submoduleNoteClause(notes: readonly SubmoduleNote[]): string | undefined {
  // A note from `notesFor` is what GIT reported, not the pass — the one read that cannot be talked into
  // silence.
  const unpopulated = new Set<string>();
  // Every kind but `seeded`, plus a seeded note whose checkout turned out empty.
  for (const n of notes)
    if (n.kind !== "seeded" || n.emptyCheckout === true) unpopulated.add(n.path);
  for (const p of notes.flatMap((n) => n.unproven ?? [])) unpopulated.add(p);
  // A read that died is its own disclosure: it carries no path, so it must not fall through to silence.
  const unreadable = notes.some((n) => n.unreadable === true);
  if (unpopulated.size === 0 && !unreadable) return undefined;
  // Bounded: the clause rides in a reason line the consumer clips from the END, so an unbounded path list
  // made the disclosure the thing that got deleted.
  const listed = clipList(
    [...unpopulated].map((p) => `"${oneLine(p, PATH_CLIP)}"`),
    PATH_CAP,
  );
  // "some" only when a path the step knows about is NOT among the unpopulated ones — counted over PATHS,
  // never against the note count.
  const named = new Set<string>();
  for (const n of notes) {
    if (n.kind === "seeded" && n.emptyCheckout !== true) named.add(n.path);
    for (const p of n.unproven ?? []) named.add(p);
  }
  const local = [...named].some((p) => !unpopulated.has(p)) ? "some " : "";
  // A read that could not be answered is disclosed in its OWN words — "seeded nothing" would be a second
  // unmeasured claim.
  const couldNotTell = unreadable
    ? "this step could not read the tree's submodule state, so it cannot say these paths are populated"
    : "the superproject holds neither a module store nor a populated checkout for these paths, so this step seeded nothing there";
  if (unpopulated.size === 0) return couldNotTell;
  return `${local}submodules are not populated: ${listed} — ${couldNotTell}`;
}

/** How many unpopulated paths one clause names before it switches to a count. */
const PATH_CAP = 8;
/** How long one quoted path may run inside the clause before it is clipped. */
const PATH_CLIP = 80;

/**
 * Unpopulated notes for paths git says have no git dir behind them — what git printed, in the pass's form.
 */
export function notesFor(unpopulated: readonly string[]): SubmoduleNote[] {
  return unpopulated.map((p) => ({ path: p, kind: "failure" as const, detail: "" }));
}

/**
 * The submodule facts of `wt` as git sees them: paths its commit registers, and which have no git dir behind
 * them. `submoduleNoteClause` reports what THIS step did; this reports what git can see.
 */
export interface WorktreeSubmoduleState {
  readonly registered: readonly string[];
  readonly unpopulated: readonly string[];
  /**
   * Set when git was asked and could not answer — which reads oppositely to "no submodules to ask about".
   */
  readonly unreadable?: boolean;
}

/**
 * The state of a tree whose read could not be answered, so a caller whose read died produces a distinguishable
 * value rather than the one meaning "nothing to report".
 */
export function unreadableSubmoduleState(): WorktreeSubmoduleState {
  return { registered: [], unpopulated: [], unreadable: true };
}

/** Ask the tree what it holds, for the case that must not be taken on trust. */
export async function submoduleState(exec: ExecFn, wt: string): Promise<WorktreeSubmoduleState> {
  // No `.gitmodules` is a genuine absence, not a failed read.
  if (!existsSync(path.join(wt, ".gitmodules"))) return { registered: [], unpopulated: [] };
  const status = await exec("git", {
    // No `--recursive`: a sweep walks into seeded submodules, describing levels not this tree's to report.
    argv: [...NO_HOOKS, "submodule", "status"],
    cwd: wt,
    timeout: QUICK_GIT_MS,
    maxBuffer: 1024 * 1024,
  }).catch(() => undefined);
  // A read that could not be answered is not one that answered "nothing" — the empty state would make the
  // backstop's failure indistinguishable from a tree with no submodules.
  if (status === undefined) return unreadableSubmoduleState();
  const registered: string[] = [];
  const unpopulated: string[] = [];
  // git's format: `<sigil><sha> <path> [(<describe>)]`. The sigil is GLUED to the sha and the sha is always
  // printed, so the parser demands both.
  //
  // Three sigils are read, and the third keeps `registered` meaningful: ` ` is a populated submodule, so a
  // parser matching only the defect glyphs reports nothing for a healthy tree. `-` is a gitlink with nothing
  // checked out; `U` is unmerged. A line matching none is ignored, not guessed at.
  for (const line of ((status as { stdout?: string }).stdout ?? "").split("\n")) {
    // The path is group 3: group 2 is only checked to BE a sha, so a parser reading it as the path took the
    // SHA for the submodule's name.
    const hit = /^([-U ])([0-9a-f]{40})\s+(\S+)/u.exec(line);
    if (hit?.[1] === undefined || hit[3] === undefined) continue;
    registered.push(hit[3]);
    if (hit[1] !== " ") unpopulated.push(hit[3]);
  }
  return registered.length === 0 ? unreadableSubmoduleState() : { registered, unpopulated };
}

/**
 * Populate the worktree's submodules when its commit has any, and say what was done to each. Never throws for
 * a submodule this host does not hold; throws `SpecifyInfraError` only when git was ASKED and refused.
 * `beforeInit` is the smoke tests' seam, firing only where a real command would run.
 */
export async function initSubmodules(
  exec: ExecFn,
  wt: string,
  beforeInit?: (wt: string) => void | Promise<void>,
): Promise<SubmoduleNote[]> {
  // The outer gate: with the runner untrusted there is no listing, no seeding and no disclosure read.
  if (!leanRunnerPreflightEnabled()) return [];
  if (!existsSync(path.join(wt, ".gitmodules"))) return [];
  const listed = await listSubmodules(exec, wt);
  if (listed === undefined) return [];
  await beforeInit?.(wt);
  if (!leanSubmodulesLocalEnabled()) return updateFromRemote(exec, wt);
  const notes = await seedFromSuperproject(exec, wt, listed);
  // The seeding arm's claim is negative — it never hands a recorded URL to git — and a negative is not
  // observable from a passing run. So one `submodule status` per absent path settles two questions:
  //
  //   - did something FETCH it? An unseeded gitlink shows `-` (or `U`); anything else means something
  //     populated it, and on this arm only a fetch from the recorded URL could have.
  //   - or did the RUN create it? A store under this tree's own gitdir is invisible to `clean -fdx`, so a
  //     submodule the run added arrives populated and unseeded. Refused too.
  //
  // An unreadable line is evidence of neither, and "could not tell" proceeds with the ordinary disclosure.
  for (const note of notes.filter((n) => n.kind === "absent")) {
    const status = await ask(exec, wt, [...NO_HOOKS, "submodule", "status", "--", note.path]);
    // "could not tell" is neither answer this read decides between, so the mark travels on the note.
    if (status === undefined) {
      const at = notes.indexOf(note);
      notes[at] = { ...note, unreadable: true };
      continue;
    }
    const line = (status.stdout ?? "").split("\n")[0] ?? "";
    if (line === "" || line.startsWith("U") || line.startsWith("-")) continue;
    throw new SpecifyInfraError(
      `the submodule at ${note.path} was added inside this run's own worktree, so this superproject never held it: the only source on this host is the tree under test, and bytes nobody verified cannot carry a verdict. Seed it in the superproject, or set PI_ENSEMBLE_LEAN_SUBMODULES_LOCAL=0 and let git fetch the URL the base records. git's line, which tells this from a fetch: ${trim(line)}`,
    );
  }
  return notes;
}

/**
 * The switch-off arm: the release's own call, unchanged. One `submodule update --init --recursive` with no
 * `-c` beyond the hook refusals, so git applies its OWN transport policy; its failure is the handback, with
 * the command's words, which the byte-for-byte equality case depends on.
 */
async function updateFromRemote(exec: ExecFn, wt: string): Promise<SubmoduleNote[]> {
  const failed = await run(exec, wt, [...NO_HOOKS, "submodule", "update", "--init", "--recursive"]);
  if (failed !== undefined) throw handback(wt, failed, UPDATE_COMMAND);
  return [];
}

/**
 * The local arm: every submodule comes from this superproject or is named absent — never from the network.
 * Per submodule, in order: the module store under the superproject's git dir, then its own populated
 * checkout, then nothing. Either is the same bytes the base's verify ran against. First level only — the
 * call carrying a source computed here is the one given `file`.
 *
 * All of it is argv: a path is a git argument, never a word a shell re-parses.
 */
async function seedFromSuperproject(
  exec: ExecFn,
  wt: string,
  listed: SubmoduleEntry[],
): Promise<SubmoduleNote[]> {
  // The SUPERPROJECT, asked of git rather than assumed from the caller's path: a linked worktree's gitdir
  // holds only what THIS tree cloned; the shared store holds what the operator populated.
  const superproject = await superprojectRoot(exec, wt);
  const superGitDirs = await gitDirsOf(exec, superproject);
  // Dirs seeding may read from: the superproject's own answers, plus this tree's `--git-common-dir` ONLY
  // when byte-for-byte one of them — git saying "this is the shared store", not the run naming a directory
  // it wants trusted. A dir unique to the run tree would call an unheld path `seeded`.
  const readDirs = new Set<string>(superGitDirs);
  for (const dir of await gitDirsOf(exec, wt)) {
    if (superGitDirs.includes(dir)) readDirs.add(dir);
  }
  const gitDirs = [...readDirs];
  const notes: SubmoduleNote[] = [];
  for (const entry of listed) {
    const source = localSource(superproject, gitDirs, entry.path, { wt });
    if (source === undefined) {
      // Nothing here held it: the run proceeds and the clause names the path, distinguishing it from a
      // submodule the step FAILED to restore.
      notes.push({
        path: entry.path,
        kind: "absent",
        detail: "no module store and no populated path in the superproject",
      });
      continue;
    }
    // Two commands. The WHY of the pair, the licence and the depth rule is the switch header's; what this
    // code holds locally is that the source and the licence are BOTH command-line `-c`, so neither can
    // outlive the invocation that used it.
    const registered = await run(exec, wt, [...NO_HOOKS, "submodule", "init", "--", entry.path]);
    if (registered !== undefined)
      throw handback(wt, registered, `git submodule init -- ${entry.path}`);
    // The source is named as a `-c` on the very call that reads it, NOT by `submodule set-url`: that writes
    // `submodule.<name>.url` into `<superproject>/.git/config` — the SHARED config — which every later git
    // in the operator's checkout consults, and the restore in `resetWorktreeToBase` reaches only
    // `.gitmodules`, never that key. A per-invocation `-c` dies with the process. The key is `entry.name` as
    // git spelled it in
    // `submodule-entries.ts` — one `submodule.` prefix, because a name that carried it twice names
    // a key git never consults and the entry would silently seed from the base's recorded URL.
    const failed = await run(exec, wt, [
      ...NO_HOOKS,
      "-c",
      `submodule.${entry.name}.url=${source}`,
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
      // fetch), an object no local copy holds, or a checkout that could not be written.
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
