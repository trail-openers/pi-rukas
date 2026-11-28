/**
 * lib/lean-panel-rows — the panel rows the preservation cases drive through the real `specify` step.
 *
 * `PANEL_IDS` is a list of STRINGS. A caller that maps it as `PANEL_IDS.map((row) => row.id)` builds rows
 * whose criterion is `undefined`, every one of those `submit_tests` calls is refused as a malformed call at
 * the extractor, and the step never proves a file: no verdict, no freeze rule, no disclosure. Three mutants
 * of the green-only freeze rule survived the whole suite for exactly that reason — each case believed it
 * had exercised an `unclear` row when the run had ended at the boundary.
 *
 * So the row builder lives here, once, taking a criterion id and a script. `preserves` rides on the row
 * only where the case declares it, and the calls and writes both read the built rows rather than a second
 * copy of the shape.
 */

import {
  PANEL_IDS,
  greenFile,
  redFile,
  testRel,
} from "./lean-specify-preservation-fixture.ts";
import { put } from "./lean-specify-fixture.ts";

/** One row of a panel submission: a criterion, the script the child writes for it, its declaration. */
export interface RowSpec {
  id: string;
  script: string;
  preserves?: true;
  /** The path this row is written at; defaults to the criterion's usual test name. */
  rel?: string;
}

/** A row resolved to the path it is written at. */
export interface BuiltRow extends RowSpec {
  rel: string;
}

/** A file the runner cannot classify: non-zero, and its output names neither the submitted path nor its basename. */
export function unclearFile(): string {
  return ["#!/bin/sh", 'echo "nothing here the runner could judge" 1>&2', "exit 3", ""].join("\n");
}

/** The five panel rows, `scriptFor` deciding each file and `preservedId` carrying the declaration. */
export function panelSpecs(scriptFor: (id: string) => string, preservedId?: string): RowSpec[] {
  return PANEL_IDS.map((id) => ({
    id,
    script: scriptFor(id),
    ...(id === preservedId ? { preserves: true as const } : {}),
  }));
}

/** The rows plus the path each is written at, in the order the child submits them. */
export function buildRows(specs: readonly RowSpec[]): BuiltRow[] {
  return specs.map((s) => ({ ...s, rel: s.rel ?? testRel(s.id) }));
}

/** The `submit_tests` calls a child would make for these rows — the shape the extractor reads. */
export function submitCalls(rows: readonly BuiltRow[]): unknown[] {
  return rows.map((r) => ({
    name: "submit_tests",
    arguments: {
      criterionId: r.id,
      testFiles: [r.rel],
      ...(r.preserves === undefined ? {} : { preserves: r.preserves }),
    },
  }));
}

/** The writes the same child makes into its worktree, one file per row. */
export function panelWrites(rows: readonly BuiltRow[]): (wt: string) => void {
  return (wt) => {
    for (const r of rows) put(wt, r.rel, r.script);
  };
}

export { PANEL_IDS, greenFile, redFile, testRel };
