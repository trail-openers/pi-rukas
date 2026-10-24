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
 * The rule this module implements, and the four things that keep it narrow:
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
 *     judgement is this module's, not the predicate's.
 *   - **The issue's explicit prohibition wins.** If the issue's prose forbids
 *     that path, the fence stays. The decision reuses `isProhibition` from
 *     work-driver-plan-unfence-extract.ts — the SAME grammar the issue-named
 *     pass uses, deliberately not a second one: two prohibition grammars drift
 *     apart, and the wider of the two silently re-fences what the narrower let
 *     go.
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
import { keepClippedRecords } from "./plan-fence-record.ts";
import { trace } from "./trace.ts";
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
 * The comparison tolerates the two ways a directory fence is written: the
 * planner's trailing separator and the issue's bare directory name are the same
 * boundary.
 */
export function issueForbidsPath(body: string, path: string): boolean {
  const needle = path.replace(/\/+$/, "").toLowerCase();
  if (needle.length === 0) return false;
  for (const sentence of body.split(/(?<=[.!?])\s+|\n+/)) {
    const normalized = sentence.replace(/\/+/g, "/").toLowerCase();
    if (!normalized.includes(needle) && !normalized.includes(`${needle}/`)) continue;
    if (isProhibition(sentence)) return true;
  }
  return false;
}

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
      const reason = docsOrTestReason(entry);
      if (reason === undefined || issueForbidsPath(body, entry)) {
        kept.push(entry);
        continue;
      }
      const note = unfencedDocsTestNote(entry, reason);
      removed.push({ workstream: id, path: entry, entry, note, docsTest: reason });
      if (!notes.includes(note)) notes.push(note);
    }
    // The original `outOfScopeClipped` is destructured away and NOT spread into
    // the copy: `rest` still carries it if this line is made conditional, and
    // then a plan whose every fence survived kept markers the caller could not
    // distinguish from markers that had just been re-keyed — a stale field is a
    // second shape for "nothing was bounded". A clip marker is keyed by its
    // ENTRY TEXT, so a removed entry takes its own record with it: the same
    // rule `unfenceIssueNamedPaths` applies via `keepClippedRecords`.
    const { outOfScopeClipped: _droppedClipped, ...rest } = ws;
    const keep = outOfScopeClipped ? keepClippedRecords(kept, outOfScopeClipped) : [];
    next[id] = {
      ...(rest as Workstream),
      paths: [...ws.paths],
      outOfScope: kept,
      ...(ws.dependsOn ? { dependsOn: [...ws.dependsOn] } : {}),
      ...(ws.introduces ? { introduces: [...ws.introduces] } : {}),
      ...(ws.consumes ? { consumes: [...ws.consumes] } : {}),
      ...(keep.length > 0 ? { outOfScopeClipped: keep } : {}),
    } as Workstream;
  }

  if (removed.length > 0) {
    trace(
      `work-driver: plan unfence (N=1 docs/test) — opened ${removed.length} docs/test fence(s)`,
    );
  }
  return { workstreams: next, notes, warnings, placed: [], removed };
}
