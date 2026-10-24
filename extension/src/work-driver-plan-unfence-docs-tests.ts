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
import { fenceDirPrefix, normaliseDeclaredPath } from "./work-driver-declared-path.ts";
import { isProtectedPath } from "./work-driver-doctrine.ts";
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
 */
export function unfenceDocsTestsEnabled(): boolean {
  const v = process.env.PI_ENSEMBLE_UNFENCE_DOCS_TESTS;
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
 * same boundary for the same reason.
 */
function issueForbidsPath(body: string, path: string): boolean {
  const needle = fenceDirPrefix(path).toLowerCase();
  if (needle.length === 0) return false;
  for (const sentence of body.split(/(?<=[.!?])\s+|\n+/)) {
    const normalized = sentence.replace(/\/+/g, "/").toLowerCase();
    if (!normalized.includes(needle) && !normalized.includes(`${needle}/`)) continue;
    if (isProhibition(sentence)) return true;
  }
  return false;
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
 */
export function unfenceDocsTestPaths(
  workstreams: Record<string, Workstream>,
  body: string,
): UnfenceResult {
  const notes: string[] = [];
  const warnings: string[] = [];
  const removed: UnfenceRecord[] = [];
  const next: Record<string, Workstream> = {};

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
      // or directory entry carries. ANY of the three keeps the entry fenced.
      const protectedEntry =
        isProtectedPath(entry) ||
        isProtectedPath(normaliseDeclaredPath(entry)) ||
        isProtectedPath(key);
      if (reason === undefined || protectedEntry || issueForbidsPath(body, entry)) {
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
