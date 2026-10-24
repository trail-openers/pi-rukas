/**
 * work-driver-plan-unfence-docs-tests — #1250 change 1: a single-workstream
 * plan must not fence out the project's documentation and tests.
 *
 * #1167 taught the plan step to drop a fence the ISSUE names. It did not help
 * the measured N=1 failure, because there the issue said nothing about the
 * fenced file at all: the planner wrote a docs page, a docs directory, a test
 * helper and a `*_test.go` into the one workstream's `outOfScope` on its own
 * initiative (the plan prompt demands a non-empty fence, and when an issue
 * names nothing to fence, docs and tests are what gets fenced). The developer
 * then did what the project's own rules require — every change updates its
 * tests and its documentation page — and `work-driver-scope-fanout.ts` parked
 * `verify-failed:develop` with `touched out-of-scope path <file> — declared
 * fence violated (issue-fenced)` after 90 to 170 minutes of develop.
 *
 * The rule this module implements, and the six things that keep it narrow:
 *
 *   - **N=1 only.** With one workstream the fence fences nobody: there is no
 *     sibling the docs could belong to, so the entry can only ever mean "the
 *     one developer may not write the docs". With N>1 a test fence is the
 *     #572/#1137 cross-declaration contract (the test belongs to the sibling
 *     that owns its subject) and opening it would put two developers on one
 *     test file. So this runs only when the plan has exactly one workstream,
 *     and nothing here re-derives N.
 *   - **The entry's OWN shape must be docs or test.** A broader fence that
 *     merely CONTAINS docs — a whole host tree, or `extension/` — is a boundary
 *     drawn around a tree for some other reason and is kept unchanged. Only an
 *     entry named under a docs directory, under a test directory, or wearing a
 *     test-shaped basename is opened. That shape question is
 *     `docsOrTestReason` in plan-docs-test-path.ts; the containment half of the
 *     judgement is this module's, not the predicate's. Both halves are asked of
 *     ONE normalised form — `fenceDirPrefix(entry)` — because the develop gate
 *     reads a fence through that normaliser and a shape judgement made on the
 *     raw entry disagrees with the gate about what one fence is: `docs/** (new)`
 *     is the same fence as `docs/`, and a bare `docs` is a directory too.
 *   - **A protected path is never opened, whatever its extension.** The
 *     `.pi/`, `.github/` and `CODEOWNERS`/`agents.json` files are what decide
 *     what verification MEANS within a cycle (#406/#285), so the develop gate
 *     halts the cycle when a developer touches one. A plan-time rule that
 *     quietly removes their fence would hand the developer a 90-minute round
 *     ending in a halt, and would read as a docs unfence to whoever audits the
 *     note. So `isProtectedPath` — the SAME predicate the develop gate's fence
 *     seam consults (`work-develop-scope-fence-seam.ts`) — keeps any entry it
 *     answers true for, before the shape question is even asked. `.pi/verify-cmd.md`,
 *     `.github/DEVELOPERS.md`, `.github/workflows/test-x.yml`, `docs/agents.json`
 *     and `docs/CODEOWNERS` all look like docs by shape and all stay fenced.
 *     The predicate is asked of the raw entry, of `normaliseDeclaredPath(entry)`
 *     and of the normalised fence key: an annotation or a directory glob hides
 *     the protected basename from exactly one of those reads, and the entry is
 *     kept if ANY of the three says protected.
 *   - **The issue's explicit prohibition wins — and an unreadable issue body
 *     disables the rule entirely.** If the issue's prose forbids that path, the
 *     fence stays. That is why the caller (`work-driver-plan-coupling-pass.ts`)
 *     refuses to run this rule at all when the cached body could not be read:
 *     a rule that cannot read the prohibition cannot honour it, and opening a
 *     fence the issue forbade is the one failure this pass must never make on a
 *     lost cache file. The caller traces that it skipped, and why. The decision reuses `isProhibition` from
 *     work-driver-plan-unfence-extract.ts — the SAME grammar the issue-named
 *     pass uses, deliberately not a second one: two prohibition grammars drift
 *     apart, and the wider of the two silently re-fences what the narrower let
 *     go. The comparison runs on `fenceDirPrefix` (work-driver-declared-path.ts),
 *     the develop gate's own fence normaliser, so `docs/`, `docs/*` and
 *     `docs/**` are one fence: a refusal that names the directory keeps every
 *     spelling of it.
 *   - **No placement, and no `paths` grant.** #1167 refuses to unfence a path
 *     it cannot place, because for an issue-named path the unfence IS a scope
 *     grant and an unowned file is a scope fanout. Here the question does not
 *     arise: the docs/test file is not a deliverable the issue asked for, and
 *     the develop gate blocks only a file that is BOTH touched AND fenced.
 *     Removing the fence makes the file simply unbudgeted, which the gate's
 *     #814 undeclared path admits. So this pass removes the entry and adds
 *     nothing to any workstream's `paths`.
 *
 * Ordering is the caller's business: this runs from the same position as
 * `unfenceIssueNamedPaths` (after the fold, port fold and coupling merge, all
 * three of which UNION fence lists). It takes a map and returns a new one — it
 * never writes through, for the reason #1167 round-3 states: a shallow copy
 * shares the caller's very `outOfScope` arrays.
 *
 * Escape hatch: `PI_ENSEMBLE_UNFENCE_DOCS_TESTS=0` disables THIS rule alone.
 * `PI_ENSEMBLE_PLAN_UNFENCE=0` still disables the whole pass.
 */

import { docsOrTestReason } from "./plan-docs-test-path.ts";
import { clippedField, keepClippedRecords } from "./plan-fence-record.ts";
import { trace } from "./trace.ts";
import {
  fenceDirPrefix,
  normaliseDeclaredPath,
  stripFenceGlob,
} from "./work-driver-declared-path.ts";
import { isProtectedPath } from "./work-driver-doctrine.ts";
import { stripCodeBlocks } from "./work-driver-plan-unfence-code.ts";
import { isProhibition } from "./work-driver-plan-unfence-extract.ts";
import { type UnfenceRecord, unfencedDocsTestNote } from "./work-driver-plan-unfence-notes.ts";
import type { UnfenceResult } from "./work-driver-plan-unfence.ts";
import type { Workstream } from "./workflow-state-schema.ts";

/**
 * The escape hatch, read the way the other unfence knob is read
 * (`planUnfenceEnabled` in work-driver-plan-coupling-pass.ts): `0` or `false`
 * disables, anything else — including unset — enables. Off, the plan keeps the
 * planner's docs and test fences exactly as written and the develop gate parks
 * as it did before #1250.
 *
 * The value is trimmed and lower-cased before the comparison: an operator who
 * writes `PI_ENSEMBLE_UNFENCE_DOCS_TESTS=" 0 "` in a shell profile means the
 * same instruction as `0`, and a rule that reads it as "on" has ignored the one
 * thing the operator asked for.
 */
export function unfenceDocsTestsEnabled(): boolean {
  const v = process.env.PI_ENSEMBLE_UNFENCE_DOCS_TESTS?.trim().toLowerCase();
  return v !== "0" && v !== "false";
}

/**
 * Does the issue FORBID this path? Scans the sentences of the body that name
 * it and asks `isProhibition` of each.
 *
 * Sentences, not the body: `isProhibition` is a sentence-level grammar, and a
 * prohibition anywhere in a long body would re-fence every path if fed the
 * whole thing. And only sentences that NAME the path are consulted, so an
 * unrelated refusal about some other file cannot keep a docs page fenced.
 *
 * The comparison runs through `fenceDirPrefix` — the develop gate's OWN fence
 * normaliser, not a local one — so the three spellings of a directory fence
 * (`docs/`, `docs/*`, `docs/**`) are one boundary: an issue that forbids a path
 * under `docs` keeps all three fenced, exactly as the develop gate fences them.
 * The planner's trailing separator and the issue's bare directory name are the
 * same boundary for the same reason. That containment runs in BOTH directions:
 * an issue that forbids `docs/help.md` does fence `docs/page.md` at the develop
 * gate, so the refusal about one file keeps the tree fenced.
 *
 * **Which prose counts, and which does not.** An issue's example block quotes a
 * path to show what the change must not become; that is an illustration, not a
 * refusal, so code blocks are stripped (`stripCodeBlocks`) before any sentence
 * is read — the same strip the issue-named pass applies through
 * `decisionSectionsOf`. What is NOT stripped is the section filter of that
 * function: a prohibition lives precisely in the sections it does not keep
 * (`## Out of scope`, `## Do not touch` — an extraction that read them as
 * requirements would unfence exactly what they refuse), so keeping them here
 * would re-fence every docs fence in the plan on the strength of a rule that
 * only ever refuses to write them. Stripping code blocks is a SAFER reading
 * than that view and exactly the one the brief asks for; the two grammars may
 * differ on which sections they read, never on whether an example counts.
 *
 * **Bare substring naming** is the other reading this must not have: `docs/x`
 * in prose must not forbid `doc/`, so each side is normalised (`\` → `/`, a
 * leading `./` dropped, `//` collapsed, lower-cased) and the fence key is
 * matched on path-segment boundaries, never as a substring a longer name
 * contains.
 *
 * Sentences arrive pre-split: the body never changes between fence entries and a
 * plan routinely has a dozen of them.
 */
function issueForbidsPath(sentences: readonly string[], path: string): boolean {
  const needle = fenceDirPrefix(path).toLowerCase();
  if (needle.length === 0) return false;
  for (const sentence of sentences) {
    const normalized = sentence
      .replace(/\\/g, "/")
      .replace(/(^|[\s(`'"])\.\//g, "$1")
      .replace(/\/+/g, "/")
      .toLowerCase();
    if (!namesPathBoundary(normalized, needle)) continue;
    // The prohibition is asked of a sentence carrying NO backslashes and no
    // sentence-terminal punctuation: the `keep/leave/skip <path>` arm of
    // `isProhibition` ends its path class at a character set that excludes `\`
    // and `.`/`,`/`;`, so a Windows separator or the full stop closing the
    // sentence silently un-prohibits the very sentence that forbids the path —
    // and `docs/` as a fence key always ends in a `/`, which the arm then
    // refuses to match at all. The judgement is about the refusal, not its
    // spelling; `[^\w]` stops the path class exactly where prose does, so a
    // sentence about `docs/x.ts` cannot swallow `docs` and invent a refusal
    // when the fence key is the bare directory.
    const refusal = normalized.replace(/[.,;:!?)]+([\s(]|$)/g, "$1");
    if (isProhibition(refusal)) return true;
  }
  return false;
}

/**
 * Does this prose name `key` as a PATH, including one that lives UNDER it?
 *
 * Sharper than a substring, looser than `pathTokenIn`'s exactness. The issue
 * names a FILE (`docs/help.md`) while the fence is often the DIRECTORY (`docs/`)
 * that the develop gate fences every file under — so a refusal about one file
 * keeps that tree fenced, which is containment, not a new match rule. Neither
 * side may be a bare substring: `doc` must not be named by `docs/x`, and
 * `docs/guide.md-extra` must not count as naming `docs/guide.md`. The lookarounds
 * are the same path-segment boundary `pathTokenIn` uses — the key may be
 * followed only by nothing, or by the `/` that opens a path under it, and never
 * by a word character, a `-`, or a further `.ext` that just lengthens the name.
 */
function namesPathBoundary(text: string, key: string): boolean {
  // ONE boundary rule (the `pathTokenIn` shape, which already means "a whole
  // path token, possibly with a path under it"): the key may be followed by
  // nothing or by a `/`-opened remainder, never by a character that only makes
  // the name longer.
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w./-])${escaped}(?![\\w-]|\\.\\w)`).test(text);
}

/**
 * The fields a copy this pass builds must NOT inherit from the planner's
 * workstream, because it rewrites them itself. `outOfScopeClipped` is the only
 * one today: it is re-keyed from the surviving entries below. Exported so the
 * smoke suite can assert the list still covers the fence fields a `Workstream`
 * actually carries — an unlisted second fence-record field would silently be
 * copied stale, which is the defect this block exists to prevent. Typed as keys
 * of `Workstream` so the canary is a real assertion rather than a string
 * comparison: a name that stopped being a field is a type error, not a test that
 * quietly stops meaning anything.
 */
export const DROPPED_ON_COPY: readonly (keyof Workstream)[] = ["outOfScopeClipped"];

/**
 * Open every docs/test fence in a single-workstream plan that the issue does
 * not forbid.
 *
 * Returns the repaired map plus the records and notes the plan persists, shaped
 * to merge into whatever `unfenceIssueNamedPaths` already produced (the caller
 * concatenates `notes`, `warnings`, `placed` and `removed` and hands the union
 * to `unfenceSummary`). No I/O, no git, no model: the whole judgement is the
 * entry's shape and the issue's prose.
 *
 * **The N=1 precondition is this function's own, not its caller's.** The caller
 * (`runPlanUnfencePass`) computes N and declines to call this at all for a
 * multi-workstream plan — but a rule whose only guard is a caller's `if` is a
 * rule that opens a sibling's test fence the first time anything else calls it,
 * and with N>1 a test fence IS the #572/#1137 cross-declaration contract. So
 * the first statement here returns the input map UNCHANGED — the same object,
 * no copies, no removals, no records — unless the map holds exactly one
 * workstream.
 */
export function unfenceDocsTestPaths(
  workstreams: Record<string, Workstream>,
  body: string,
): UnfenceResult {
  const notes: string[] = [];
  const warnings: string[] = [];
  const removed: UnfenceRecord[] = [];
  const next: Record<string, Workstream> = {};

  if (Object.keys(workstreams).length !== 1) {
    return { workstreams, notes, warnings, placed: [], removed };
  }
  // The prohibition scan reads the WHOLE body with its code blocks stripped, ONCE
  // for the whole call rather than once per fence entry. Not `decisionSectionsOf`:
  // a refusal lives in the sections that function deliberately drops, and an
  // unreadable prohibition must never open a fence (see the module header).
  const sentences = stripCodeBlocks(body).split(/(?<=[.!?])\s+|\n+/);

  for (const id of Object.keys(workstreams)) {
    const ws = workstreams[id];
    if (!ws) continue;
    const kept: string[] = [];
    for (const entry of ws.outOfScope) {
      // ONE normalised form for both halves of the judgement. `fenceDirPrefix`
      // is the develop gate's own fence normaliser (paired markup, a planner
      // annotation, `./` and the `dir/**` / `dir/*` directory spellings all
      // collapse to the directory), so the three spellings of one fence get one
      // verdict here exactly as they do at the gate — and a bare `docs` or
      // `test` entry (no separator, no extension) is judged as the directory it
      // names, which is how the gate fences it. Judging the RAW entry instead
      // reads `docs/** (new)` as neither docs nor test while the gate fences the
      // whole tree under it, and keeps `docs` fenced while opening `docs/`.
      const key = fenceDirPrefix(entry);
      const reason = docsOrTestReason(key);
      // Asked three ways because each read sees a different text and an
      // annotation hides the protected basename from exactly one of them:
      // `docs/CODEOWNERS (keep)` deannotates to a protected basename the raw
      // form does not end with, and the fence key strips the glob an annotated
      // or directory entry carries. ANY of these keeps the entry fenced. The
      // fourth read is the one an entry carrying BOTH a glob and an annotation
      // needs: `docs/agents.json/** (new)` — `fenceDirPrefix` deannotates first,
      // so an annotation sitting behind the glob is gone by the time the glob
      // is, and neither of the two earlier reads ever holds `…/agents.json`
      // alone. So the canonical form is asked twice: annotation stripped
      // (`normaliseDeclaredPath`), then the trailing glob stripped from THAT
      // (`stripFenceGlob`, the second half of what `fenceDirPrefix` composes).
      const protectedEntry =
        isProtectedPath(entry) ||
        isProtectedPath(normaliseDeclaredPath(entry)) ||
        isProtectedPath(key) ||
        isProtectedPath(stripFenceGlob(normaliseDeclaredPath(entry)));
      if (reason === undefined || protectedEntry || issueForbidsPath(sentences, entry)) {
        kept.push(entry);
        continue;
      }
      const note = unfencedDocsTestNote(entry, reason);
      // The note is planner-derived text heading for a state file and a trace
      // line, so the ENTRY inside it is neutralised (see plan-fence-render.ts);
      // `path`/`entry` on the record stay the raw text the plan compares.
      removed.push({ workstream: id, path: entry, entry, note, docsTest: reason });
      if (!notes.includes(note)) notes.push(note);
    }
    // Copied WITHOUT the fence-record field. `outOfScopeClipped` must not reach
    // the copy through a spread — a stale marker set is a second shape for
    // "nothing was bounded", indistinguishable from markers this pass just
    // re-keyed — and it cannot be dropped by destructuring it into an unused
    // binding (what a formatter removes) nor by `delete` (what
    // `lint/performance/noDelete` refuses). So the excluded names are listed in
    // `DROPPED_ON_COPY`, typed `keyof Workstream`, which doubles as the
    // type-level statement of the same fact: `Pick<Workstream, …>` is exactly
    // the fields this copy must supply itself, so the literal below is checked
    // against the interface rather than waved through by a cast — add a fence
    // field to `Workstream` and leave it out of the spread and this line stops
    // compiling. The smoke-suite canary asserts the same list from the other
    // side. A clip marker is keyed by its ENTRY TEXT, so a removed entry takes
    // its own record with it: the same rule `unfenceIssueNamedPaths` applies via
    // `keepClippedRecords`.
    const carried: Pick<Workstream, (typeof DROPPED_ON_COPY)[number]> = { ...ws };
    const keep = ws.outOfScopeClipped ? keepClippedRecords(kept, ws.outOfScopeClipped) : [];
    next[id] = {
      ...ws,
      ...carried,
      paths: [...ws.paths],
      outOfScope: kept,
      ...(ws.dependsOn ? { dependsOn: [...ws.dependsOn] } : {}),
      ...(ws.introduces ? { introduces: [...ws.introduces] } : {}),
      ...(ws.consumes ? { consumes: [...ws.consumes] } : {}),
      // The same shape the other three fence-list writers use, so an empty
      // record list cannot leave a key holding `undefined` behind.
      ...clippedField(keep),
    };
  }

  if (removed.length > 0) {
    trace(
      `work-driver: plan unfence (N=1 docs/test) — opened ${removed.length} docs/test fence(s)`,
    );
  }
  return { workstreams: next, notes, warnings, placed: [], removed };
}
