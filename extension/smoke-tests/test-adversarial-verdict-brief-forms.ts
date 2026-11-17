#!/usr/bin/env bun
/**
 * #2322 — the reviewer's brief and the heading form, read as the reviewer writes them.
 *
 * The companion to `test-adversarial-verdict-candidates.ts`, which pins the
 * reader's per-line vocabulary. This file pins the two shapes #2322 was opened
 * for: a verdict line COPIED out of the reviewer brief, and the heading form
 * (`### VERDICT` over its value line) judged on both of its lines.
 *
 * Both are read from the built prompt rather than retyped, so a brief edit that
 * moves the menu cannot leave a suite green while testing a spelling no reviewer
 * is ever shown. The DELIBERATE refusals (a pasted menu glued to its signature,
 * and the same glued to a fence) are marked as such in their own arms: they are
 * the documented cost of taking no tail exemption on the menu-run rule, and the
 * reason they are refusals rather than fixes is stated beside each one.
 */

import { buildAdversarialPrompt } from "../src/adversarial-prompts.ts";
import { readAdversarialVerdict, verdictCandidateLines } from "../src/adversarial-verdict-read.ts";
import { parseVerdict } from "../src/adversarial-verdict.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`\u2713 ${msg}`);
  else {
    console.error(`\u2717 ${msg}`);
    exit = 1;
  }
}

{
  // #2322 AC4, read from the brief the reviewer is actually sent: a menu line
  // copied out of it verbatim must be a readable signature (an indented one read
  // `verdictParsed: false` and cost the round), while the whole menu echoed back
  // stays excluded by the menu-run rule below. The menu is taken from the built
  // prompt rather than retyped, so the prompt and this suite cannot drift.
  {
    const built = buildAdversarialPrompt({
      diff: "+const x = 1;",
      context: "c",
      round: 1,
      maxRounds: 3,
    });
    const menu = built.split("\n").filter((l) => /^\s*VERDICT: [A-Z_]+$/.test(l));
    assert(
      menu.length === 4,
      `the reviewer brief prints a four-line verdict menu (${menu.length})`,
    );
    for (const line of menu) {
      assert(
        /^VERDICT: [A-Z_]+$/.test(line),
        `canary: a menu line is printed at column 0, so copying it verbatim signs: ${line}`,
      );
      assert(
        parseVerdict(line).verdictParsed === true,
        `…and the loop reads that copied line as a verdict (${line})`,
      );
    }
    assert(
      parseVerdict(menu.join("\n")).verdictParsed === false,
      "…while the whole menu echoed back is still a recitation, not a verdict (AC4)",
    );

    // The half of the field shape AC4 cannot reach, pinned so it is a documented
    // refusal rather than an accident: a reviewer that copies the menu AND forgets the
    // blank line before its signature ends inside one run, and the run rule refuses
    // the block whole. Exempting the run's last line would read that reply — but it
    // also reads the plain echo above as `CRITICAL_ISSUES_FOUND`, because the brief's
    // menu itself ends on a value. So the refusal stands, and a reviewer that closes
    // with a blank line under its paste signs (the AC4 arm above).
    assert(
      parseVerdict(`${menu.join("\n")}\nVERDICT: APPROVED`).verdictParsed === false,
      "DELIBERATE: a pasted menu glued to its signature reads unparsed — exempting the run's tail would turn the whole-menu echo above into a verdict, so the reply gets a fix round rather than a guess",
    );
    assert(
      parseVerdict(`${menu.join("\n")}\n\nVERDICT: APPROVED`).verdictParsed === true,
      "…and the same reviewer with the blank line its brief asks for does sign — so the refusal is the missing separator, not the paste",
    );
    // A signature ABOVE the paste survives on its own line but not glued to it, which
    // is the asymmetry the run rule trades for its safety; both directions are pinned.
    assert(
      readAdversarialVerdict(`VERDICT: ISSUES_FOUND\n\n${menu.join("\n")}`) === "ISSUES_FOUND",
      "a real signature separated from the pasted menu still reads",
    );
    assert(
      readAdversarialVerdict(`VERDICT: ISSUES_FOUND\n${menu.join("\n")}`) === undefined,
      "…while glued to it the whole block is refused, which is the cost of taking no tail exemption — disclosed, never silent (the reviewer brief asks for a blank line)",
    );

    // Fenced final verdict: the shape a reviewer files when it puts its verdict in a
    // code block. Refused by the fence rule (it was refused before this ticket too),
    // and now pinned so the two rules cannot be confused with each other.
    assert(
      readAdversarialVerdict("Findings.\n\n```\nVERDICT: APPROVED\n```") === undefined,
      "a verdict inside the final ``` block signs nothing — the fence rule owns that shape, not the run rule",
    );
    assert(
      readAdversarialVerdict("VERDICT: ISSUES_FOUND\n\n```\nVERDICT: APPROVED\n```") ===
        "ISSUES_FOUND",
      "…and a fenced APPROVED under a real signature does not out-rank it",
    );
    // The pairing AC4's de-dent makes reachable: a reviewer that copies the (now
    // column-0, therefore byte-identical to its own signature) menu AND closes with
    // a fenced block instead of a blank line. A ``` line is not a token line, so it
    // BREAKS the run rather than joining it — the four pasted lines above form a run
    // on their own and are refused with the block, so even the reply's ONLY signature,
    // the fenced one, signs nothing, on either value. Pinned as a documented refusal
    // rather than an accident: exempting the run's tail cannot save it either (the
    // brief's menu ends on a value, so a plain echo would then read CRITICAL), and
    // what the reviewer is asked to do instead is close the block and sign at column
    // 0 — which the arm above shows does sign.
    for (const value of ["APPROVED", "CRITICAL_ISSUES_FOUND"]) {
      // The fence is built from the code-point rather than written inline, the way
      // `adversarial-prompts.ts` builds its own, so the delimiters cannot be mangled
      // by the formatter or by an escape here.
      const fence = String.fromCharCode(0x60, 0x60, 0x60);
      assert(
        readAdversarialVerdict(`${menu.join("\n")}\n${fence}\nVERDICT: ${value}\n${fence}`) ===
          undefined,
        `DELIBERATE: a pasted menu glued to a fenced \`${value}\` signs nothing, because the fence breaks the run and the menu alone is already a recitation`,
      );
    }
  }

  // #2322: the heading form used to judge only its TOKEN line, so a column-0
  // `### VERDICT` with an indented, bulleted, quoted, tabled or fenced value
  // line signed whatever that line said. The value line is markdown structure
  // too, and the candidate carries it as `valueIndex`, so the same per-line
  // judgement governs it (`headingValueRefused`).
  const headingValueShapes: Array<[string, string]> = [
    ["an indented value line", "    APPROVED"],
    ["a tab-indented value line", "\tAPPROVED"],
    ["a bulleted value line", "* APPROVED"],
    ["a dash-bulleted value line", "- APPROVED"],
    ["an ordered-list value line", "1. APPROVED"],
    ["a quoted value line", "> APPROVED"],
    ["a table value line", "| APPROVED |"],
  ];
  for (const [name, valueLine] of headingValueShapes) {
    const reply = `VERDICT: ISSUES_FOUND\n\n### VERDICT\n${valueLine}`;
    const lines = verdictCandidateLines(reply);
    assert(
      lines.length === 1 && (lines[0]?.status as string) === "ISSUES_FOUND",
      `a column-0 heading whose value line is ${name} contributes no candidate (#2322)`,
    );
    assert(
      readAdversarialVerdict(reply) === "ISSUES_FOUND",
      "…and does not out-rank the real signature above it",
    );
  }
  {
    // A fence marker ON the value line is not a line inside a fence, so it is
    // the fenced rule that must refuse it — and the lines below the opener are
    // inside the block the fence walk opens there and leaves open to the end of the
    // reply, so the heading states nothing either way.
    const reply = "VERDICT: ISSUES_FOUND\n\n### VERDICT\n```\nAPPROVED\n```";
    assert(
      readAdversarialVerdict(reply) === "ISSUES_FOUND",
      "a heading whose value line opens a fence states no verdict (#2322)",
    );
    const unclosed = verdictCandidateLines("VERDICT: ISSUES_FOUND\n\n### VERDICT\n```\nAPPROVED");
    assert(
      unclosed.length === 1 && (unclosed[0]?.status as string) === "ISSUES_FOUND",
      "…and so on when the fence is never closed",
    );
  }
  for (const heading of ["### VERDICT", "### VERDICT:"]) {
    assert(
      readAdversarialVerdict(`${heading}\n\nAPPROVED`) === "APPROVED",
      `the heading spelling \`${heading}\` reads its value line (#2322, AC5)`,
    );
    assert(
      readAdversarialVerdict(`VERDICT: ISSUES_FOUND\n\n${heading}\n    APPROVED`) ===
        "ISSUES_FOUND",
      `…and an indented value under \`${heading}\` still signs nothing`,
    );
  }
  // A heading decorated beyond a trailing colon is not a column-0 heading, and
  // fails closed with the other quoted shapes rather than signing: `structural`
  // MARKS the refusal (AC3's decorated-APPROVED arm) so the caller can tell
  // "refused" from "never there".
  {
    const decorated = "VERDICT: ISSUES_FOUND\n\n**### VERDICT:**\nAPPROVED";
    const lines = verdictCandidateLines(decorated);
    assert(
      lines.length === 1 && (lines[0]?.status as string) === "ISSUES_FOUND",
      "a bold-wrapped heading contributes no candidate, so the real verdict stands (AC3)",
    );
    assert(
      readAdversarialVerdict(decorated) === "ISSUES_FOUND",
      "…and a decorated APPROVED after a real ISSUES_FOUND reads ISSUES_FOUND (AC3)",
    );
    assert(
      readAdversarialVerdict("***### VERDICT***\nAPPROVED") === undefined,
      "three asterisks of emphasis around a heading sign nothing — the emphasis cap holds on the heading too",
    );
    // The other half of the cap: the same `***` on the heading's VALUE line. The
    // token line was capped by AC2 while the value matcher kept `\**`, so this shape
    // out-ranked a real objection above it while `***VERDICT:*** APPROVED` was refused
    // — the two forms claiming to share the per-line rules while disagreeing about
    // what decoration a signature may wear (#2322 round 2).
    for (const stars of ["***", "****"]) {
      const decorated = `VERDICT: CRITICAL_ISSUES_FOUND\n\n### VERDICT\n${stars}APPROVED${stars}`;
      assert(
        readAdversarialVerdict(decorated) === "CRITICAL_ISSUES_FOUND",
        `${stars}APPROVED${stars} under a column-0 heading signs nothing, so the real verdict above it stands (round 2)`,
      );
      assert(
        verdictCandidateLines(decorated).every((l) => l.status !== "APPROVED"),
        "…and the decorated value contributes no candidate at all",
      );
      assert(
        readAdversarialVerdict(`### VERDICT\n${stars}APPROVED${stars}`) === undefined,
        "…so on its own it is unreadable, not a quiet APPROVED",
      );
    }
    // The cap is a cap, not a ban: two asterisks are what reviewers write, and the
    // value line must keep signing for them.
    for (const value of ["APPROVED", "ISSUES_FOUND"]) {
      assert(
        readAdversarialVerdict(`### VERDICT\n**${value}**`) === value,
        `a bold-wrapped \`${value}\` value line still signs — the cap is two, not one`,
      );
    }
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
