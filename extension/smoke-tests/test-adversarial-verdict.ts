#!/usr/bin/env bun
/**
 * The gate must mean what its own prompt says.
 *
 * `agents-base/adversarial-developer.md:81-93` defines four verdicts and calls
 * two of them non-blocking:
 *
 *     ISSUES_FOUND       — "Should address, not blocking"
 *     MINOR_OBSERVATIONS — "Non-blocking, author's discretion"
 *
 * `adversarial.ts` knew three of them and exited only on APPROVED, so the
 * verdict its own doctrine calls *not blocking* halted the cycle, and
 * MINOR_OBSERVATIONS — absent from the enum — failed to parse, fell through to
 * the ISSUES_FOUND default, and was punished as a malfunction.
 *
 * Measured over 253 loops recovered from the durable session store: 49 ended
 * REJECTED, and **41 of those 49 (83.7%) ended on ISSUES_FOUND**. Only 8 ended
 * on CRITICAL. A loop still alive at round 3 was roughly 2:1 to be rejected.
 *
 * A measured loop is the worked example. Its final round said "quality gates pass
 * … the overall design is sound", filed one item under `### ISSUES` and the
 * rest under `### MINOR_OBSERVATIONS`, and returned ISSUES_FOUND. The cycle
 * died with no commit and no PR.
 */

import { decideLoopAction, parseVerdict } from "../src/adversarial-verdict.ts";
import {
  readAdversarialVerdict,
  verdictCandidateLines,
} from "../src/adversarial-verdict-read.ts";
import { readFileSync } from "node:fs";
import path from "node:path";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const MAX = 3;

// ------------------------------------------------- the vocabulary parses

{
  assert(parseVerdict("VERDICT: APPROVED").status === "APPROVED", "APPROVED parses");
  assert(parseVerdict("VERDICT: ISSUES_FOUND").status === "ISSUES_FOUND", "ISSUES_FOUND parses");
  assert(
    parseVerdict("VERDICT: MINOR_OBSERVATIONS").status === "MINOR_OBSERVATIONS",
    "canary: MINOR_OBSERVATIONS parses — the prompt's own non-blocking verdict, absent from the enum before this",
  );
  assert(
    parseVerdict("**VERDICT: MINOR_OBSERVATIONS**").status === "MINOR_OBSERVATIONS",
    "...including the markdown-bold form reviewers routinely write",
  );

  // The substring hazard: CRITICAL_ISSUES_FOUND contains ISSUES_FOUND.
  assert(
    parseVerdict("VERDICT: CRITICAL_ISSUES_FOUND").status === "CRITICAL_ISSUES_FOUND",
    "canary: CRITICAL_ISSUES_FOUND never degrades to ISSUES_FOUND",
  );

  const unparsed = parseVerdict("I could not decide.");
  assert(unparsed.status === "ISSUES_FOUND", "an unreadable reply still defaults to ISSUES_FOUND");
  assert(
    unparsed.verdictParsed === false,
    "...and is marked unparsed, so its text is not passed off as findings",
  );
}

// ---------------- an unreadable verdict is not a verdict, and must not pass

{
  // The regression this file failed to prevent when it was written. Relaxing
  // the terminal rule to "only CRITICAL blocks" silently relaxed it for the
  // NO-VERDICT case too, because a marker miss defaults to ISSUES_FOUND — so a
  // reviewer that crashed, was truncated, or wrote its marker in a shape the
  // parser does not know went from REJECT to PASS. That is the mirror of the
  // bug this file exists to fix, and worse: it passes on no signal at all.
  const shapes: Array<[string, string]> = [
    ["no marker at all", "The reviewer crashed before writing a verdict."],
    // reply-markers.ts builds the separator as `\s*:?\s*\**\s*:?\s*`, which
    // an em-dash does not match.
    ["an em-dash separator", "VERDICT — CRITICAL_ISSUES_FOUND"],
    // spawn-collapse-events.ts sets this exact string, with ok=true, when a
    // child produced only thinking content.
    ["thinking-only output", "(thinking content only - no text output)"],
  ];

  for (const [name, text] of shapes) {
    const v = parseVerdict(text);
    assert(v.verdictParsed === false, `${name}: marked unparsed`);
    assert(
      decideLoopAction(v.status, MAX, MAX, v.verdictParsed) !== "pass",
      `canary: ${name} does NOT pass the terminal gate — no verdict is not an approval`,
    );
  }

  // ...and it is not silently downgraded to a rejection either: nothing was
  // reviewed, so this is an infrastructure failure, which is what the loop
  // already knows how to report and retry.
  const v = parseVerdict("garbage");
  assert(
    decideLoopAction(v.status, MAX, MAX, v.verdictParsed) === "incomplete",
    "an unreadable reply is INCOMPLETE — distinct from a reviewer that read the diff and objected",
  );
  assert(
    decideLoopAction("ISSUES_FOUND", MAX, MAX, true) === "pass",
    "...while a genuine ISSUES_FOUND still passes, so the #664 fix is intact",
  );
}

// ------------- the LAST CANDIDATE line wins, not the first (#2312, reply-markers.ts:44)

{
  // Two rules, and #2312 is the second one.
  //
  // (1) LAST, not first. `readMarker` used a non-global `text.match`, which
  // returns the FIRST hit, so a reviewer that mentions the token while thinking —
  // and they do, the fix prompts are full of mid-task narration — had its
  // narration read as its verdict. The musing below is not a candidate line at
  // all (its token is mid-sentence), so the rule it tests is now carried by the
  // candidate set rather than by the tie-break; it stays because a musing whose
  // token DID start its line must still lose to the closing line.
  //
  // (2) CANDIDATE lines only. Of the lines that could be signatures — an
  // inline `VERDICT: <value>` at ≤3 spaces of indent, or `### VERDICT` with a
  // bare value under it — the verdict is the LAST one that is not fenced,
  // indented, quoted, tabled, or part of a menu run (D1–D3,
  // adversarial-verdict-read.ts). A quotation is not a signature, and the whole
  // reply is not the thing being read.
  const twoMarkers = [
    "I will return VERDICT: ISSUES_FOUND if the parser is wrong.",
    "It turned out to be fine.",
    "VERDICT: APPROVED",
  ].join("\n\n");
  assert(
    parseVerdict(twoMarkers).status === "APPROVED",
    "canary: with two VERDICT markers the LAST one wins — the first-match read a reviewer's musing as its verdict",
  );
}

// --------- a quoted, fenced, quoted-away or recited verdict is not the verdict

{
  // #2312 — the incident. `readMarker` answers "what is the LAST match anywhere
  // in this string", and a reviewer's report is full of places a verdict string
  // appears that are not the reviewer signing one. Each shape below sits AFTER a
  // real `VERDICT: APPROVED` and names a blocking value; the whole-reply reader
  // landed on the quotation every time, and the loop approved a review that
  // objected. The `…AFTER_APPROVED` arms are the blocking ones: if the reader
  // stops excluding any of these shapes, that row flips the verdict.
  const AFTER = "VERDICT: APPROVED\n\n";
  const blocking: Array<[string, string]> = [
    ["a closed ``` fence", "```text\nVERDICT: CRITICAL_ISSUES_FOUND\n```"],
    ["an unclosed ``` fence", "```text\nVERDICT: CRITICAL_ISSUES_FOUND"],
    ["a closed ~~~ fence", "~~~\nVERDICT: CRITICAL_ISSUES_FOUND\n~~~"],
    ["an unclosed ~~~ fence", "~~~\nVERDICT: CRITICAL_ISSUES_FOUND"],
    ["a 4-space indented block", "    VERDICT: CRITICAL_ISSUES_FOUND"],
    ["a tab-indented block", "\tVERDICT: CRITICAL_ISSUES_FOUND"],
    ['a "> " block quote', "> VERDICT: CRITICAL_ISSUES_FOUND"],
    ['a "| " table cell', "| VERDICT: CRITICAL_ISSUES_FOUND |"],
    ["inline backticks", "`VERDICT: CRITICAL_ISSUES_FOUND`"],
    ["a mid-line prose mention", "It would be wrong to answer VERDICT: CRITICAL_ISSUES_FOUND here."],
  ];
  for (const [name, shape] of blocking) {
    const v = parseVerdict(AFTER + shape);
    assert(
      v.status === "APPROVED" && v.verdictParsed,
      `canary: ${name} after a real APPROVED leaves APPROVED — the whole-reply reader read the quotation instead (got ${v.status})`,
    );
  }

  // The menu echo. `buildAdversarialPrompt` prints the reviewer's four choices as
  // four consecutive 2-space-indented VERDICT lines, and a child that recites its
  // brief back is a shape the incident reproduces on. Every line of such a run is
  // excluded, so the verdict stays the real one above it.
  const MENU = [
    "  VERDICT: APPROVED",
    "  VERDICT: MINOR_OBSERVATIONS",
    "  VERDICT: ISSUES_FOUND",
    "  VERDICT: CRITICAL_ISSUES_FOUND",
  ].join("\n");
  const echoed = parseVerdict(`${AFTER}Return a verdict line at the end matching one of:\n${MENU}`);
  assert(
    echoed.status === "APPROVED" && echoed.verdictParsed,
    `canary: the brief's own menu echoed back after a real APPROVED leaves APPROVED (got ${echoed.status})`,
  );

  // The recitation rule (the stop's `blockRefusesVerdict` mirrored into the
  // gate): a reply whose ONLY verdict lines are a menu named ≥2 values states no
  // verdict, so it is unreadable — a fix round mid-loop, `incomplete` at the
  // terminal round. Silence is never a pass.
  const recited = parseVerdict(MENU);
  assert(
    recited.verdictParsed === false,
    "canary: a reply that is nothing but the verdict menu reads verdictParsed:false — reciting the protocol is not choosing",
  );
  assert(
    decideLoopAction(recited.status, MAX, MAX, recited.verdictParsed) === "incomplete",
    "…and a recitation at the terminal round is INCOMPLETE, never a pass",
  );

  // The exclusions must not eat a legitimate verdict: the same value twice is a
  // reviewer that wrote its verdict twice, and one line naming one value is a
  // menu with one entry — both still sign.
  assert(
    parseVerdict("VERDICT: APPROVED\nVERDICT: APPROVED").status === "APPROVED",
    "a repeated identical verdict line still parses — the run rule is about DISTINCT values, not about repetition",
  );
  assert(
    parseVerdict("This is ISSUES_FOUND rather than CRITICAL_ISSUES_FOUND.\n\nVERDICT: ISSUES_FOUND")
      .status === "ISSUES_FOUND",
    "arguing about two verdicts in prose and then signing one still parses — the reader refuses a REPEAT of the menu, not an argument",
  );
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
  assert(
    JSON.stringify(c("   VERDICT: APPROVED")) === '["APPROVED:0"]',
    "…at up to three spaces of indent",
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
  assert(
    c("### VERDICT\nAPPROVED, because the gate covers it").length === 0,
    "a heading whose value line is prose states no verdict",
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
    ["  VERDICT: APPROVED", "  VERDICT: ISSUES_FOUND"].join("\n"),
  );
  assert(
    recited.length === 2 && recited.every((l) => l.menuRun),
    "every line of a menu run is marked, and no line of it survives",
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
  assert(
    readAdversarialVerdict(`VERDICT: APPROVED\n\n- as the brief says: \`${MENU.split("\n").join("` and `")}\``) ===
      "APPROVED",
    "a bulleted echo of the whole menu inside inline code leaves the real verdict alone",
  );
}

// -------------------------------------------- what each verdict does to the loop

{
  // Mid-loop: anything unresolved earns a fix round. That is what the rounds
  // are for, and in #664 rounds 1 and 2 produced real fixes.
  assert(decideLoopAction("APPROVED", 1, MAX, true) === "pass", "APPROVED passes immediately");
  assert(
    decideLoopAction("MINOR_OBSERVATIONS", 1, MAX, true) === "pass",
    "MINOR_OBSERVATIONS passes immediately — 'author's discretion'",
  );
  assert(
    decideLoopAction("ISSUES_FOUND", 1, MAX, true) === "fix",
    "ISSUES_FOUND earns a fix round",
  );
  assert(
    decideLoopAction("CRITICAL_ISSUES_FOUND", 1, MAX, true) === "fix",
    "CRITICAL_ISSUES_FOUND earns a fix round",
  );
  assert(decideLoopAction("ISSUES_FOUND", 2, MAX, true) === "fix", "...still, on round 2");
}

{
  // Terminal: only the verdict the doctrine calls blocking actually blocks.
  assert(
    decideLoopAction("ISSUES_FOUND", MAX, MAX, true) === "pass",
    "canary: ISSUES_FOUND on the LAST round passes — 83.7% of all rejections ended here",
  );
  assert(
    decideLoopAction("MINOR_OBSERVATIONS", MAX, MAX, true) === "pass",
    "MINOR_OBSERVATIONS on the last round passes",
  );
  assert(
    decideLoopAction("CRITICAL_ISSUES_FOUND", MAX, MAX, true) === "reject",
    "CRITICAL_ISSUES_FOUND on the last round still REJECTS — the gate keeps its teeth",
  );
  assert(
    decideLoopAction("APPROVED", MAX, MAX, true) === "pass",
    "APPROVED on the last round passes",
  );
}

// ------------------------------------------- the measured case, round by round

{
  // The verdict sequence a real loop produced: critical, then issues, then issues.
  const sequence = ["CRITICAL_ISSUES_FOUND", "ISSUES_FOUND", "ISSUES_FOUND"] as const;
  const actions = sequence.map((v, i) => decideLoopAction(v, i + 1, MAX, true));
  assert(
    actions[0] === "fix" && actions[1] === "fix",
    "#664: rounds 1 and 2 still earn fix rounds — they produced real fixes and must not be skipped",
  );
  assert(
    actions[2] === "pass",
    "canary: #664 now PASSES on round 3 — it died here, with green tests and a design the reviewer called sound",
  );

  // And the counter-case must still fail, or this is not a gate.
  const bad = ["ISSUES_FOUND", "ISSUES_FOUND", "CRITICAL_ISSUES_FOUND"] as const;
  assert(
    bad.map((v, i) => decideLoopAction(v, i + 1, MAX, true))[2] === "reject",
    "a loop ending CRITICAL still rejects — the fix is not 'always pass'",
  );
}

// -------------------------------------------- prompt and code agree on the words

{
  // The defect underneath all of the above: three sources disagreed about the
  // vocabulary, and two of them were markdown files composed into one prompt.
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const ROOT = path.resolve(import.meta.dirname, "..", "..");

  const doctrine = readFileSync(path.join(ROOT, "agents-base", "adversarial-developer.md"), "utf8");
  const src = readFileSync(path.join(ROOT, "extension", "src", "adversarial-verdict.ts"), "utf8");

  const menu = doctrine.match(/VERDICT:\s*\[([A-Z_|\s]+)\]/);
  const tokens = (menu?.[1] ?? "")
    .split("|")
    .map((t) => t.trim())
    .filter(Boolean);
  assert(
    tokens.length === 4,
    `the doctrine offers ${tokens.length} verdicts: ${tokens.join(", ")}`,
  );
  const missing = tokens.filter((t) => !src.includes(t));
  assert(
    missing.length === 0,
    `every verdict the prompt offers is known to the code${missing.length ? ` — missing: ${missing.join(", ")}` : ""}`,
  );

  // Exactly one verdict menu in the composed prompt. Two copies is how they
  // drifted: modules/domains/adversarial-patterns.md carried a stale
  // three-verdict menu that also told the reviewer to use APPROVED only when
  // "genuinely unable to find problems".
  const built = path.join(ROOT, "dist", "prompts", "standard", "adversarial-developer.md");
  try {
    const composed = readFileSync(built, "utf8");
    const menus = composed.match(/VERDICT:\s*\[[A-Z_|\s]+\]/g) ?? [];
    assert(
      menus.length === 1,
      `canary: the built prompt states its verdict menu exactly once (found ${menus.length})`,
    );
    for (const m of menus) {
      assert(
        m.includes("MINOR_OBSERVATIONS"),
        "...and that menu is the four-verdict one, not the stale three-verdict copy",
      );
    }
  } catch {
    console.log("  … dist/ not built; skipping composed-prompt check (run `bun run build`)");
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
