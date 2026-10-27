/**
 * work-driver-fix-pass-admission — #1846: the two admission routes an
 * adversarial fix pass was missing, and the fence text the fix prompt prints.
 *
 * The symptom this closes: a fix pass lands its fix beside the test that proves
 * it and parks `fix-pass-park`, because the pass's fence (
 * `work-driver-adversarial-fix-scope.ts` `postPassFault`) admitted only
 * declared, already-changed, finding-named and spec-slot files. A new
 * `tests/foo.test.ts` next to a changed `pkg/foo.ts` matched none of them, so
 * the whole cycle handed off and an operator landed the refused file by hand.
 * The develop gate has had the coupled-test rule since #672
 * (`isTestPath` + `couplesTo` in work-driver-plan-paths.ts); the fix pass never
 * imported it.
 *
 * Three rules, all narrow on purpose:
 *
 *   1. A **coupled test** — `isTestPath(file)` and `couplesTo(file, subject)`
 *      for any of the pass's SUBJECTS (declared, already-changed, or
 *      finding-named) — is admitted outright. No ceiling refuses it: it is the
 *      test that proves the fix the findings asked for, and capping it
 *      reproduces the bug this module exists to fix.
 *   2. An **undeclared file under the directory anchor of a DECLARED path** —
 *      the small helper module beside the changed code — is admitted while the
 *      pass's TOTAL stays within `fanoutLimitFor(declared + admittingSlots)`
 *      (PM decision #1846-3: one ceiling over all admission routes, and this
 *      one consumes no spec-slot budget). Already-changed and finding-named
 *      paths are the OTHER widening routes' anchors, never this one's:
 *      widening a widening lets a pass invent a file in the directory of a file
 *      it invented. Refusal when the ceiling is spent: `over-ceiling`.
 *   3. `outOfScope` (the ONE fence predicate, `fenceMatches`) and protected
 *      paths stay ABSOLUTE. They are asked before either rule and neither rule
 *      reaches them: a fence the plan wrote, and the protected-path gate's
 *      decision, outrank a route the fix pass invented. Refusals: `fenced` /
 *      `protected`.
 *
 * Scope of the judgement (PM decision #1846-2): the caller passes ONLY what the
 * pass's own delta, `treeChanges(worktree, plan.headBefore)`, names. A file an
 * earlier agent commit touched is judged by the existing already-changed rule
 * exactly as before this change, and #1772's recorded rejection of a
 * round-delta fence is respected: the anchor here is never "the tree minus the
 * last round".
 *
 * The prompt half (#1846-5): `fixPassFence` is the ONE value the prompt renders
 * AND the fence reads, so the fixer is told the set it will be judged against,
 * and `test-fix-pass-prompt-fence.ts` asserts the printed set equals the read
 * set rather than merely that a list appears.
 */

import { anchorDirs, entryPath, fenceMatches, pathTokenIn } from "./work-driver-declared-path.ts";
import { protectedPathsIn } from "./work-driver-doctrine.ts";
import { couplesTo, isTestPath } from "./work-driver-plan-paths.ts";
import type { AdmissionRefusal } from "./work-driver-spec-slot-admission.ts";

/** Which admission route took a file, for the disclosure line. */
export type FixPassAdmissionRoute = "coupled-test" | "anchored-helper";

/**
 * What a fix pass's fence is judged against, computed once per workstream from
 * the plan and passed to both sides of the contract: `postPassFault` reads it
 * and the fix prompt renders it (PM decision #1846-5 — the printed fence and
 * the enforced fence are the same value, not two renderings).
 */
export interface FixPassFence {
  /** The workstream id, for the disclosure lines. */
  id: string;
  /**
   * The set the pass's own delta is judged against: declared paths, the
   * finding-named widening, and — when nothing is declared — the files this
   * cycle already changed. This is the `allowed` list the fence built before
   * #1846; it is now shared instead of rebuilt in two places.
   */
  admits: string[];
  /**
   * The subjects the coupled-test rule couples to: declared, already-changed,
   * finding-named. These answer "which file is this test ABOUT" — a question a
   * file the cycle already committed legitimately answers, which is exactly the
   * provenance the #1698 widening route established.
   */
  subjects: string[];
  /**
   * The subjects the HELPER rule is anchored in: the planner's declared paths
   * plus the finding-named widening, never an already-changed path.
   *
   * LOAD-BEARING, and not the same set as `subjects`. `alreadyChanged` is the
   * tree judged against the cycle's BASE, so an earlier develop round's edits
   * appear in it — and PM decision #1846-2 says a file an earlier agent commit
   * touched is judged exactly as before this change, by the already-changed rule
   * alone. Anchoring the helper rule on `subjects` would let a pass create a
   * file beside something a round before it changed: a widening built on a
   * widening, which is the round-delta fence #1772 records as rejected. So the
   * helper route asks this narrower set — which is also what keeps every
   * refusal the fence made before #1846 a refusal after it.
   */
  helperSubjects: string[];
  /** The planner's declared paths, kept so the prompt can name the basis. */
  declared: string[];
  /**
   * The directories rule 2 admits a helper in, chosen by the gate per pass:
   * the directories of the declared files the findings name plus the
   * finding-named widening when anything is declared; the corrective route's
   * own anchor set (`plan.dirs`) when nothing is declared but a round ran;
   * empty otherwise (no declared paths and no round — the route admits
   * nothing). See `postPassFault` for why each shape is what it is.
   *
   * Kept separate from {@link dirs} (route (a)'s and the corrective route's
   * `anchorDirs(declared ∪ already-changed)`) because this route is one the
   * pass invented: `alreadyChanged` is the tree judged against the CYCLE BASE
   * and carries an earlier develop round's edits, and anchoring a route the pass
   * invented on it is the widening built on a widening that #1772 records as
   * rejected. PM decision #1846-2: a file an earlier agent commit touched is
   * judged exactly as before this change.
   */
  helperDirs: ReadonlySet<string>;
  /**
   * `anchorDirs(declared ∪ named)` — kept for diagnostics and disclosure; the
   * gate chooses {@link helperDirs} per pass rather than reading this directly.
   */
  declaredDirs: ReadonlySet<string>;
  /**
   * `anchorDirs(subjects)` — the wider anchor set (declared ∪ already-changed),
   * route (a)'s and the corrective route's reading of what the workstream owns.
   * Kept on the view so the disclosure can name it; rule 2 does NOT read it.
   */
  dirs: ReadonlySet<string>;
  /**
   * The files this pass itself changed — `treeChanges(worktree, headBefore)`
   * names, the pass's own delta (PM decision #1846-2). `postPassFault` fills it
   * in at the gate read; it is EMPTY on the plan-time / prompt-time view.
   *
   * That asymmetry is the point, and it is why the two routes that read it
   * (`couplesToSubject`, `sitsUnderSubjectAnchor`) are not reached before the
   * caller has checked `admits`: a pass's own fix is a legitimate anchor for a
   * test and a helper beside it, while a file an EARLIER agent commit touched —
   * which appears in `before`, the diff against the cycle base, but never here —
   * may not be. Printing these in the prompt would show the fixer files it has
   * not changed yet, so they stay out of the rendered fence.
   */
  passChanged: string[];
  /** The workstream's own `outOfScope` fence entries, normalised. */
  outOfScope: string[];
  /** `fanoutLimitFor(declared + admittingSlots)` — the ONE ceiling (#1846-3). */
  ceiling: number;
  /** The denominator behind that ceiling, for the disclosure line. */
  ceilingBasis: string;
  /**
   * #1846 — how many files of this pass's OWN delta the fence has counted so
   * far. `postPassFault` threads the running count in, so the anchored-helper
   * route sees the same numerator the pass's fan-out check reads and the single
   * ceiling of PM decision #1846-3 really is one ceiling over every route.
   */
  used: number;
  /**
   * The already-rendered fence lines, when this view is carried into the fix
   * prompt (#1846). Plan time leaves it absent — the ceiling is not final
   * there — and the fix pass fills it before handing develop the overlay, so a
   * prompt can only ever carry a rendered fence.
   */
  fixFenceLines?: readonly string[];
}

/** Inputs to the fence view — the plan's own fields, already normalised. */
export interface FixPassFenceInput {
  id: string;
  declared: readonly string[];
  named: readonly string[];
  /** The workstream's changes against the cycle base (the N=1 baseline). */
  alreadyChanged: readonly string[];
  outOfScope: readonly string[];
  /** Distinct spec pattern slots that admitted a file for this workstream. */
  admittingSlots: number;
}

/** The subjects both new rules couple to: declared, already-changed, named. */
export function fixPassSubjects(input: FixPassFenceInput): string[] {
  const declared = input.declared.map(entryPath);
  const named = input.named.map(entryPath);
  const base =
    declared.length > 0
      ? [...declared, ...named]
      : [...input.alreadyChanged.map(entryPath), ...named];
  return [...new Set(base)];
}

/** The fence view both the gate and the prompt read. */
export function fixPassFence(
  input: FixPassFenceInput,
  fanoutLimit: (declaredCount: number) => number,
): FixPassFence {
  const subjects = fixPassSubjects(input);
  const declared = input.declared.map(entryPath);
  // #1725 round 3 — the ceiling grows per ADMITTING SLOT, never per admitted
  // file, and the coupled-test / anchored-helper route adds no denominator of
  // its own: one ceiling over all admission routes (#1846 PM decision 3).
  const denominator = declared.length + input.admittingSlots;
  // A finding naming a file is the reviewer asking for work in that file's
  // neighbourhood, and `named` is already provenance-checked (tracked at base
  // or committed by the cycle, unprotected, anchored) by `namedPaths`.
  // Already-changed paths are NOT here — see `helperSubjects`.
  const helperSubjects = [...new Set([...declared, ...input.named.map(entryPath)])];
  return {
    id: input.id,
    admits: subjects,
    subjects,
    helperSubjects,
    declared,
    dirs: anchorDirs(subjects),
    declaredDirs: anchorDirs(helperSubjects),
    helperDirs: anchorDirs(helperSubjects),
    passChanged: [],
    outOfScope: input.outOfScope.map(entryPath),
    ceiling: fanoutLimit(denominator),
    ceilingBasis:
      declared.length > 0
        ? `${declared.length} declared path(s) plus ${input.admittingSlots} admitting slot(s)`
        : `no declared paths, so ${input.alreadyChanged.length} already-changed file(s) plus ${input.admittingSlots} admitting slot(s)`,
    used: 0,
  };
}

/**
 * Does the admitted entry `entry` cover `file`? The exact-or-trailing-slash
 * reading the fence used before #1846, kept as the ONE place it is spelled: a
 * declared path matches itself, and a directory entry (`src/foo/`) matches
 * everything beneath it. Deliberately NOT `fenceMatches` — a declared path is
 * not a glob, and reading one as a pattern would let `a+b.ts` mean something
 * other than the file the planner named.
 */
export function admitsEntry(entry: string, file: string): boolean {
  return file === entry || (entry.endsWith("/") && file.startsWith(entry));
}

/**
 * Is `file` a coupled test of one of `subjects` (rule 1)?
 *
 * The caller chooses `subjects`: what the PASS changed for a file the pass
 * created (a new test proves the fix it just made), and the cycle-wide
 * `subjects` for a file the pass merely edited (a pre-existing test of an
 * already-changed module was always the workstream's own — refusing an edit to
 * it is the bug this issue reports). The split is what keeps PM decision
 * #1846-2 true: a file an EARLIER agent commit created sits in `before` (the
 * diff against the cycle base) and never in `passChanged`, so it is judged
 * exactly as before this change and the pass buys no room from it.
 */
export function couplesToSubject(file: string, subjects: readonly string[]): boolean {
  if (!isTestPath(file)) return false;
  return subjects.some((subject) => !isTestPath(subject) && couplesTo(file, subject));
}

/** The directory `p` lives in (`""` at the root). */
const parentOf = (p: string): string => {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
};

/**
 * Is `file` under the directory anchor of a path this pass was asked to work
 * on (rule 2)? The fence passes `declaredDirs`, never `dirs`.
 *
 * A root-level file has no anchor: `anchorDirs` never yields "", and a root
 * anchor would make every root file widenable (work-driver-declared-path.ts).
 * A declared DIRECTORY entry (`src/foo/`) anchors the directory it names, so a
 * sibling under it is the helper beside the code the planner asked for.
 */
export function sitsUnderSubjectAnchor(file: string, dirs: ReadonlySet<string>): boolean {
  const parent = parentOf(file);
  return parent !== "" && dirs.has(parent);
}

/** One admitted file's disclosure line — one per admitted file, so an
 *  authorisation the operator never sees cannot happen by omission (#1522). */
export function fixPassAdmissionNote(route: FixPassAdmissionRoute, file: string): string {
  const why =
    route === "coupled-test"
      ? "it is a test coupled by name to a file this pass owns"
      : "it sits in the directory of a declared path";
  return `${file} admitted — ${why} (authorised by the fix pass's admission rules; bounded by the pass's fan-out ceiling)`;
}

/**
 * Why neither rule admitted a file, beyond the fence/protected answers.
 *
 * `other` means neither rule fitted: not a coupled test, and either no subject
 * directory or (for a pass with declared paths) outside every declared
 * directory entirely. `over-ceiling` means the anchored-helper route fitted but
 * the pass's single fan-out ceiling is spent — named apart so the park says the
 * CEILING stopped the file rather than that nobody claimed it.
 */
export type FixPassAdmissionRefusal =
  | Extract<AdmissionRefusal, "fenced" | "protected">
  | "other"
  | "over-ceiling"
  | "corrective-scope";

/** The admission decision for one file: which rule admitted it, or neither. */
export type FixPassAdmission =
  | { admitted: true; route: FixPassAdmissionRoute; note: string }
  | { admitted: false; refused: FixPassAdmissionRefusal };

/**
 * The admission question for one file in the pass's OWN delta.
 *
 * Precedence is the contract:
 *
 *   1. `fenced` / `protected` are asked FIRST and are final — neither rule can
 *      admit what the plan fenced or the protected-path gate owns (acceptance
 *      criterion 2, the same order the spec-slot admitter runs).
 *   2. A **coupled test** is admitted with NO ceiling check. It is the test
 *      that proves the fix the findings asked for, and refusing it for the file
 *      count reproduces the bug this module exists to fix.
 *   3. An **anchored helper** is admitted only inside the directory of a path
 *      the pass was actually asked to work on (`helperDirs`), and only while
 *      `used < ceiling`.
 *
 * Both rules are anchored on `passChanged`, so the prompt-time view (which has
 * no delta yet) admits nothing through this function at all — the prompt is
 * told the ROUTES, the gate is what decides the FILES.
 */
export function admitFixPassFile(
  file: string,
  fence: FixPassFence,
  used: number,
): FixPassAdmission {
  if (fence.outOfScope.some((entry) => fenceMatches(entry, file)))
    return { admitted: false, refused: "fenced" };
  if (protectedPathsIn([file]).length > 0) return { admitted: false, refused: "protected" };
  // #1846 PM decision 2 — both rules below are anchored on `passChanged`, the
  // pass's own delta (`treeChanges(worktree, headBefore)`), which the gate
  // fills in and the prompt-time view leaves EMPTY. A file the pass never
  // changed cannot be a test coupled to its fix or a helper beside it, so an
  // empty `passChanged` — the prompt-time fence — refuses every file here, and
  // the two rules can never disagree with each other across the two views.
  if (fence.passChanged.length === 0) return { admitted: false, refused: "other" };
  // `passChanged` is ALWAYS this file's own delta as set by the caller, so the
  // coupled-test rule always reads the pass's own commits — never `before`.
  if (couplesToSubject(file, fence.passChanged))
    return {
      admitted: true,
      route: "coupled-test",
      note: fixPassAdmissionNote("coupled-test", file),
    };
  if (!sitsUnderSubjectAnchor(file, fence.helperDirs)) return { admitted: false, refused: "other" };
  return used < fence.ceiling
    ? {
        admitted: true,
        route: "anchored-helper",
        note: fixPassAdmissionNote("anchored-helper", file),
      }
    : { admitted: false, refused: "over-ceiling" };
}

/**
 * Is `file` a test the COUPLED-TEST route would admit for this pass?
 *
 * The fan-out ceiling asks this to keep a pass's own tests out of its wander
 * budget: the ceiling bounds how far a pass may drift from its declared scope,
 * and a test that proves the fix it was asked to make is the opposite of
 * drifting. Same predicate the route itself uses, so the two cannot disagree
 * about which files are coupled — a ceiling that excluded a different set from
 * the one the route admits would be a second rule with its own edge cases.
 */
export function coupledTestAdmitted(file: string, fence: FixPassFence): boolean {
  if (fence.passChanged.length === 0) return false;
  return couplesToSubject(file, fence.passChanged);
}

/**
 * The helper route's ANCHOR FILES — the specific files the pass was ASKED to
 * change, not every file in its declared scope. Three shapes:
 *
 *  - DECLARED paths exist → the anchors are the declared files this pass's
 *    findings actually name, plus the finding-named widening (`named`).
 *    Restricting to what the findings name is what makes this "the helper beside
 *    the fix I just made" rather than "anything anywhere the planner mentioned":
 *    a plan that declared 30 files would otherwise authorise a new module beside
 *    all 30 for the whole pass. A declared file no finding names is still in the
 *    fence — as a file, through `admits` — it just anchors nothing.
 *    `alreadyChanged` is never an anchor in any shape: it is the tree judged
 *    against the CYCLE BASE, so it carries an earlier develop round's edits, and
 *    anchoring on it is the widening built on a widening that #1772 records as
 *    rejected.
 *  - nothing is declared AND a corrective round ran → that round is evidence the
 *    driver itself put the workstream into `roundDirs` (route (a)'s anchor set:
 *    declared ∪ already-changed), which is exactly the set the corrective route
 *    is bounded to by condition (2) of `createCorrectiveAdmission`. The helper
 *    route therefore claims no directory the pass is not already permitted to
 *    work in, and the two routes cannot disagree about which that is.
 *  - nothing is declared AND no round ran → the helper route admits nothing, so
 *    no directories. With no declared paths the pass's fence *is* `before`, so
 *    any anchor drawn from it is a widening built on a widening. This is what
 *    keeps the unfenced N=1 shape closed: `b.txt` beside `a.txt` stays a stray.
 *
 * The round's refusal still outranks this route for the file it refused (see
 * `admitFixPassEntry`), so `CORRECTIVE_ADMIT_MAX` keeps its teeth.
 */
export function fixPassHelperDirs(
  declared: readonly string[],
  findings: string,
  named: readonly string[],
  roundDirs: ReadonlySet<string>,
  ranRound: boolean,
): ReadonlySet<string> {
  if (declared.length > 0)
    return anchorDirs([...declared.filter((f) => pathTokenIn(findings, f)), ...named]);
  return ranRound ? roundDirs : EMPTY_DIRS;
}

/** No anchors: the anchored-helper route admits nothing. */
const EMPTY_DIRS: ReadonlySet<string> = new Set<string>();

/** How many paths the printed fence names for one rule before it says "more". */
const PRINTED_PATHS = 12;

const shown = (paths: readonly string[]): string => {
  const head = paths
    .slice(0, PRINTED_PATHS)
    .map((p) => `\`${p}\``)
    .join(", ");
  return paths.length > PRINTED_PATHS ? `${head}, … (${paths.length} total)` : head;
};

/**
 * The fence block the fix prompt prints (#1846-3), rendered from the SAME
 * `FixPassFence` the fence reads. It states the four things the acceptance
 * criterion names: the admitted set, the finding-named widening inside it, the
 * two admission rules with their ceiling, and the outOfScope list.
 */
export function fixPassFenceLines(fence: FixPassFence): string[] {
  const basis =
    fence.declared.length > 0
      ? "the declared paths and the files the findings name"
      : "the files this worktree already changed and the files the findings name";
  const lines = [
    "",
    "## The fence this fix pass is judged against",
    "",
    "The post-pass scope fence refuses the pass (cap `fix-pass-park`) unless every file you change sits in one of these:",
    `- **admitted directly** (${basis}): ${shown(fence.admits)}`,
    "- **admitted as a coupled test**: any test file whose name couples to one of those files — its stem contains the file's whole basename (so `tests/foo.test.ts` is coupled to `pkg/foo.ts`). Always allowed; never refused for the file count.",
    `- **admitted as an anchored helper**: an undeclared file in the same directory as one of the files you are allowed to change, while the pass's total stays within ${fence.ceiling} file(s) for its ${fence.ceilingBasis}`,
  ];
  lines.push(
    fence.outOfScope.length > 0
      ? `- **never admitted**: this workstream's out-of-scope fence — ${shown(fence.outOfScope)} — and any protected path (\`.github/\`, \`.pi/\`, \`CODEOWNERS\`, \`agents.json\`). Either parks the cycle.`
      : "- **never admitted**: this workstream's out-of-scope fence (none declared) and any protected path (`.github/`, `.pi/`, `CODEOWNERS`, `agents.json`) — either parks the cycle.",
  );
  lines.push(
    "",
    "Anything outside those routes is a stray: the driver preserves it under a ref and a patch, reverts it and continues — one stray set does not park the pass, a second one does.",
  );
  return lines;
}
