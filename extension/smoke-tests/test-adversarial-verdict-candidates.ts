#!/usr/bin/env bun
/**
 * #2312 — what a candidate line is, and what one is not.
 *
 * The companion to `test-adversarial-verdict.ts`, which pins the LOOP's rules
 * (the vocabulary, what each verdict does to the loop, the measured case). This
 * file pins the READER's: which lines of a reply may state the verdict at all.
 *
 * It asserts on `verdictCandidateLines` rather than only on the final status,
 * because the two failure directions are invisible to each other at the status
 * level: a shape that was correctly EXCLUDED and a shape that silently stopped
 * being a CANDIDATE both print "not the verdict", and the difference is a
 * reviewer whose verdict was quietly thrown away. Only the candidate list can
 * tell "refused" from "never there".
 *
 * The arms are grouped by the rule each one pins, and the rules came from the
 * adversarial review of the first candidate implementation: F1 is column 0, F2
 * is list markers, F3 is what breaks a menu run. The one DELIBERATE refusal
 * (a 4+-space indent reads as unparsed) is marked as such in its own arm.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { buildAdversarialPrompt } from "../src/adversarial-prompts.ts";
import {
  readAdversarialVerdict,
  verdictCandidateLines,
} from "../src/adversarial-verdict-read.ts";
import { parseVerdict } from "../src/adversarial-verdict.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`\u2713 ${msg}`);
  else {
    console.error(`\u2717 ${msg}`);
    exit = 1;
  }
}

// --------- what a candidate line is (D1), and what one is not (D2)

{
  // The reader's own vocabulary, asserted on the candidate list rather than only
  // on the final status: an excluded shape that silently became NO candidate is
  // indistinguishable from a correct exclusion at the status level, and the
  // difference is a reviewer whose verdict was quietly thrown away.
  const c = (t: string) => verdictCandidateLines(t).map((l) => `${l.status}:${l.index}`);

  assert(
    JSON.stringify(c("VERDICT: APPROVED")) === '["APPROVED:0"]',
    "the inline form is a candidate (D1a)",
  );
  assert(
    JSON.stringify(c("**VERDICT:** APPROVED")) === '["APPROVED:0"]',
    "…including the bold-split spelling reviewers write",
  );
  // #2312 fix wave F1: the signature sits at column 0. Indentation is decoration —
  // a reviewer quoting somebody else's verdict line indents it. The line is still
  // MARKED (so a forged verdict reads as refused, not as absent) but `structural`,
  // so it signs nothing. (#2322 moved the brief's own menu to column 0, so an
  // indent is now purely quotation; AC4's arms below pin that menu spelling.)
  const ind1 = verdictCandidateLines(" VERDICT: APPROVED")[0];
  assert(
    ind1?.status === "APPROVED" && ind1?.structural === true,
    "…but NOT indented one space (F1): an inline candidate signs only at column 0",
  );
  const ind2 = verdictCandidateLines("  VERDICT: APPROVED")[0];
  assert(
    ind2?.status === "APPROVED" && ind2?.structural === true,
    "…nor two, the indent a quoted or pasted line carries (F1)",
  );
  assert(
    JSON.stringify(c("VERDICT: APPROVED (per the doctrine)")) === '["APPROVED:0"]',
    "…with trailing text after the value",
  );
  assert(
    JSON.stringify(c("### VERDICT\n\nAPPROVED")) === '["APPROVED:0"]',
    "the heading form is a candidate, and its index is the HEADING line (D1b)",
  );
  assert(
    readAdversarialVerdict("### VERDICT\n\nAPPROVED") === "APPROVED",
    "…and reads as the value on its next non-blank line",
  );
  // A heading's value line accepts what the inline form accepts after `VERDICT:`,
  // so a verdict with its reason attached signs (`APPROVED, because the gate covers
  // it` — the same tolerance `VERDICT: APPROVED (per the doctrine)` has always had).
  // What states no verdict is a line with no value in marker position at all.
  assert(
    c("### VERDICT\nAPPROVED, because the gate covers it").length === 1,
    "a heading whose value line is a verdict with its reason attached is a candidate — the same tolerance the inline form has",
  );
  assert(
    c("### VERDICT\nthe gate covers it").length === 0,
    "a heading whose value line names no verdict states none",
  );
  assert(
    c("### VERDICT\nsee the ISSUES_FOUND rows above").length === 0,
    "…and neither does a value line that merely mentions one further in",
  );
  assert(
    c(" ## VERDICT\n\nAPPROVED").length === 0,
    "the heading form starts at column 0 too — an indented heading is not a signature (F1)",
  );
  assert(
    readAdversarialVerdict("VERDICT: APPROVED\n\n### VERDICT\n\nISSUES_FOUND") ===
      "ISSUES_FOUND",
    "…and a column-0 heading after an inline candidate still wins as the later signature",
  );
  assert(
    c("The reviewer may answer VERDICT: CRITICAL_ISSUES_FOUND here.").length === 0,
    "a token that does not begin its line is not a candidate",
  );
  assert(
    c("VERDICT: <APPROVED|ISSUES_FOUND>").length === 0,
    "a placeholder template names no single value, so it is not a candidate",
  );

  // Exclusions, marked rather than dropped: the caller can see what it refused.
  const fenced = verdictCandidateLines("```\nVERDICT: APPROVED\n```")[0];
  assert(fenced?.fenced === true, "a line inside a fence is marked fenced, not silently missing");
  const quoted = verdictCandidateLines("> VERDICT: APPROVED")[0];
  assert(quoted?.structural === true, "a block-quoted line is marked structural");
  const indented = verdictCandidateLines("    VERDICT: APPROVED")[0];
  assert(indented?.structural === true, "a 4-space indented line is marked structural");
  const tabled = verdictCandidateLines("| VERDICT: APPROVED |")[0];
  assert(tabled?.structural === true, "a table row is marked structural");
  const recited = verdictCandidateLines(
    ["VERDICT: APPROVED", "VERDICT: ISSUES_FOUND"].join("\n"),
  );
  assert(
    recited.length === 2 && recited.every((l) => l.menuRun),
    "every line of a menu run is marked, and no line of it survives",
  );

  // F2: a list marker is markdown structure, not emphasis. `* VERDICT: APPROVED`
  // used to satisfy the emphasis part of the prefix, so a bullet could sign.
  // Emphasis is allowed only as `*`/`**` touching the token.
  for (const bullet of ["* ", "- ", "+ ", "1. ", "1) "]) {
    const marked = verdictCandidateLines(`${bullet}VERDICT: APPROVED`)[0];
    assert(
      marked?.status === "APPROVED" && marked?.structural === true,
      `a \`${bullet.trim()}\` list item is marked structural and signs nothing (F2)`,
    );
    assert(
      readAdversarialVerdict(`${bullet}VERDICT: APPROVED`) === undefined,
      `…and reads as no verdict at all`,
    );
  }
  assert(
    JSON.stringify(c("**VERDICT:** APPROVED")) === '["APPROVED:0"]',
    "emphasis immediately around the token is still a candidate — F2 caps it at two asterisks, it does not ban them",
  );

  // F3: a menu run is CONSECUTIVE token lines. A blank line is the reviewer
  // finishing one block and starting another, so the closing signature below the
  // gap is not part of the recitation above it.
  assert(
    JSON.stringify(
      c(
        [
          "VERDICT: APPROVED",
          "VERDICT: MINOR_OBSERVATIONS",
          "VERDICT: ISSUES_FOUND",
          "VERDICT: CRITICAL_ISSUES_FOUND",
          "",
          "VERDICT: ISSUES_FOUND",
        ].join("\n"),
      ),
    ) === '["APPROVED:0","MINOR_OBSERVATIONS:1","ISSUES_FOUND:2","CRITICAL_ISSUES_FOUND:3","ISSUES_FOUND:5"]',
    "the line after a blank line is a candidate on its own, not a member of the run above it (F3)",
  );

  // The incident's own bytes, read off disk: this is the reply that wrote a
  // passed:true row for a review that objected.
  const fixture = readFileSync(
    path.join(import.meta.dirname, "fixtures", "adversarial-replies", "incident-2304-round2.txt"),
    "utf8",
  );
  const incident = parseVerdict(fixture);
  assert(
    incident.status === "ISSUES_FOUND" && incident.verdictParsed === true,
    `canary: the incident reply reads ISSUES_FOUND with a parsed verdict (got ${incident.status}/${String(incident.verdictParsed)})`,
  );
  assert(
    fixture.includes("`VERDICT: APPROVED`"),
    "…and the fixture really carries the quoted APPROVED that caused the misread",
  );
  // A bulleted echo of the whole menu, each entry inside inline code: the values
  // are all named, none of them in marker position, so the real verdict stands.
  const echoedInline = `VERDICT: APPROVED

- the brief offers \`APPROVED\`, \`MINOR_OBSERVATIONS\`, \`ISSUES_FOUND\`, \`CRITICAL_ISSUES_FOUND\``;
  assert(
    readAdversarialVerdict(echoedInline) === "APPROVED",
    "a bulleted echo of the whole menu inside inline code leaves the real verdict alone",
  );
}

// ----- the three reproduced misreads, and the rule each one pins (#2312 fix wave)

{
  // The adversarial review reproduced these three shapes against the first
  // candidate rule. Each is a reply whose CLOSING line signs a verdict while
  // something above it — a quoted menu, a bullet, an echoed template — would
  // out-rank it under a looser rule. These are the shapes the gate was still
  // getting wrong, so each one is asserted on the final status and not only on
  // the candidate list.
  const shapes: Array<[string, string, string]> = [
    [
      "an indented menu echo followed by a closing signature below a blank line (F1+F3)",
      [
        "  VERDICT: APPROVED",
        "  VERDICT: MINOR_OBSERVATIONS",
        "  VERDICT: ISSUES_FOUND",
        "  VERDICT: CRITICAL_ISSUES_FOUND",
        "",
        "VERDICT: ISSUES_FOUND",
      ].join("\n"),
      "ISSUES_FOUND",
    ],
    [
      "a bulleted verdict after a real one (F2)",
      "VERDICT: ISSUES_FOUND\n\n### MINOR\n* VERDICT: APPROVED",
      "ISSUES_FOUND",
    ],
    [
      "a quoted APPROVED after a real ISSUES_FOUND (F1)",
      "VERDICT: ISSUES_FOUND\n\n  VERDICT: APPROVED",
      "ISSUES_FOUND",
    ],
  ];
  for (const [name, text, want] of shapes) {
    const v = parseVerdict(text);
    assert(
      v.status === want && v.verdictParsed,
      `canary: ${name} reads ${want} (got ${v.status}/${String(v.verdictParsed)})`,
    );
  }

  // The blocking direction of each rule: an indented or bulleted APPROVED must
  // never flip a real blocking verdict, and never flip a real APPROVED either.
  for (const [marker, name] of [
    ["  ", "a 2-space indented"],
    ["   ", "a 3-space indented"],
    ["* ", "an asterisk-bulleted"],
    ["- ", "a dash-bulleted"],
    ["+ ", "a plus-bulleted"],
    ["1. ", "an ordered-list"],
    ["1) ", "a paren-ordered"],
  ] as const) {
    assert(
      parseVerdict(`VERDICT: ISSUES_FOUND\n\n${marker}VERDICT: APPROVED`).status ===
        "ISSUES_FOUND",
      `canary: ${name} APPROVED after a real ISSUES_FOUND does not flip the verdict`,
    );
    assert(
      parseVerdict(`VERDICT: APPROVED\n\n${marker}VERDICT: CRITICAL_ISSUES_FOUND`).status ===
        "APPROVED",
      `canary: ${name} CRITICAL_ISSUES_FOUND after a real APPROVED does not fail a clean review`,
    );
  }

  // #2322 AC2: a tab after a list bullet, and more than two asterisks of
  // emphasis, are markdown structure or noise rather than emphasis touching the
  // token. Only `*\t` was red before the fix (QUOTED_OR_TABLE_RE's bullet
  // alternative requires a literal space); the other four rows are the
  // REGRESSION half — they were already excluded, and must stay excluded.
  for (const marker of ["*\t", "+\t", "-\t", "1.\t", "1)\t", "***"]) {
    const decorated = `${marker}VERDICT: APPROVED`;
    // Two exclusion mechanisms, one outcome. A TAB after a bullet is refused by
    // the marker patterns (the bullet group needs a literal space) and then marked
    // structural by `TAB_LIST_MARKERS`, so the line is a MARKED candidate; three
    // asterisks are never a token line at all. Both sign nothing, and only the
    // marked one can be reported as "refused" rather than "absent".
    const marked = verdictCandidateLines(decorated);
    if (marker === "***") {
      assert(
        marked.length === 0,
        `a \`${marker}\` prefix is no longer even a token line (F2/#2322)`,
      );
    } else {
      assert(
        marked.length === 1 && marked[0]?.structural === true,
        `a \`${marker.replace(/\t/g, "\\t")}\` prefix is marked structural, not silently missing (#2322)`,
      );
    }
    assert(
      readAdversarialVerdict(decorated) === undefined,
      `…so it signs nothing on its own`,
    );
    assert(
      parseVerdict(`VERDICT: ISSUES_FOUND\n\n${decorated}`).status === "ISSUES_FOUND",
      `…and never out-ranks the real ISSUES_FOUND above it`,
    );
  }

  // The same two mechanisms on the markers' NO-SPACE spellings, which are what a
  // completion produces when it drops the space after a bullet. A single `*` glued
  // to the token reads as emphasis and is refused the way `***VERDICT:***` is
  // refused — a one-asterisk run touching the token is decoration, not a list item,
  // so it is no token line at all. A `-`, `+` or `1.`/`1)` glued to the token is a
  // list marker that lost the space its content needs: no markdown renders it as a
  // marker, and it must still be a MARKED structural refusal rather than a line the
  // reader never saw, because a forgery that leaves no trace is the failure this
  // list exists to make visible.
  for (const marker of ["*", "-", "+", "1.", "1)"]) {
    const decorated = `${marker}VERDICT: APPROVED`;
    const marked = verdictCandidateLines(decorated);
    if (marker === "*") {
      assert(
        marked.length === 0,
        `a \`${marker}\` immediately before the token is decoration, not a token line at all`,
      );
    } else {
      assert(
        marked.length === 1 && marked[0]?.structural === true,
        `a \`${marker}\` glued to the token is marked structural, not silently missing`,
      );
    }
    assert(
      readAdversarialVerdict(decorated) === undefined,
      `…so \`${marker}VERDICT:\` signs nothing on its own`,
    );
    assert(
      parseVerdict(`VERDICT: ISSUES_FOUND\n\n${decorated}`).status === "ISSUES_FOUND",
      `…and \`${marker}VERDICT: APPROVED\` never out-ranks the real ISSUES_FOUND above it`,
    );
  }

  // The refusal must not reach the form reviewers actually write: two asterisks
  // touching the token are bold, and bold signs on both sides of the token.
  assert(
    readAdversarialVerdict("**VERDICT:** APPROVED") === "APPROVED",
    "`**VERDICT:** APPROVED` is bold and stays readable while a single `*` is refused",
  );
  assert(
    JSON.stringify(verdictCandidateLines("**VERDICT:** APPROVED").map((l) => `${l.status}:${l.index}`)) ===
      '["APPROVED:0"]',
    "…and is a MARKED candidate rather than a line the reader walked past",
  );

  // The shapes that must STILL read, or the exclusions have become a maw.
  assert(
    readAdversarialVerdict("**VERDICT:** APPROVED") === "APPROVED",
    "the bold-split form still reads (F2 keeps emphasis adjacent to the token)",
  );
  assert(
    readAdversarialVerdict("**VERDICT: APPROVED**") === "APPROVED",
    "…and the bold-wrapped form",
  );
  assert(
    readAdversarialVerdict("VERDICT: APPROVED (per the doctrine)") === "APPROVED",
    "…and the form with trailing prose after the value",
  );
  assert(
    readAdversarialVerdict("### VERDICT\n\nAPPROVED") === "APPROVED",
    "…and the heading form, which also starts at column 0 (F1)",
  );

  // Two column-0 lines naming different values are a menu, however short: the
  // reply chose nothing, so it states nothing.
  const twoRows = parseVerdict("VERDICT: APPROVED\nVERDICT: ISSUES_FOUND");
  assert(
    twoRows.verdictParsed === false,
    "two consecutive column-0 candidate lines with different values read unparsed — a two-entry menu is still a menu (F3)",
  );

  // DELIBERATE, not an oversight: a verdict indented 4+ spaces is indistinguishable
  // from a code block quoting one, and the two cannot be told apart from the text
  // alone. Failing closed (unparsed → fix round / `incomplete`) is the chosen
  // direction, so a reviewer that nests its signature under a list gets a round
  // back rather than a guess. If this arm ever goes green, the rule changed.
  const nested = parseVerdict("- Reviewed the diff\n    VERDICT: APPROVED");
  assert(
    nested.verdictParsed === false,
    "DELIBERATE: a 4-space indented verdict reads unparsed — it cannot be told from a code block quoting one, so we refuse rather than guess",
  );

  // The tie-break, asserted where it lives: among candidates, the later wins.
  const candidates = verdictCandidateLines("VERDICT: APPROVED\n\nsome prose\n\nVERDICT: ISSUES_FOUND");
  assert(
    candidates.length === 2 &&
      candidates[0]?.status === "APPROVED" &&
      candidates[1]?.status === "ISSUES_FOUND",
    "two candidates separated by prose are both candidates (F3: the run is broken by anything non-blank)",
  );
  assert(
    readAdversarialVerdict("VERDICT: APPROVED\n\nsome prose\n\nVERDICT: ISSUES_FOUND") ===
      "ISSUES_FOUND",
    "canary: of two candidates the LATER one is the verdict — the closing-line rule",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);

