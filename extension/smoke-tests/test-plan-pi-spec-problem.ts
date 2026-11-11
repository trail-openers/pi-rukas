#!/usr/bin/env bun
/**
 * #2171 — the pi-spec `problem` field is the draft's statement, not its title.
 *
 * `plan-draft.ts` already renders the caller's `descriptor` as a `Descriptor:`
 * line in `## Context & motivation`, and the mapper read the ISSUE TITLE instead
 * — so the machine field every downstream reader trusts (Lean's specify oracle,
 * the acceptance-coverage audit) carried a headline while the sentence that says
 * what is wrong sat one section away, unread.
 *
 * Split out of test-plan-pi-spec.ts (the mapper file had outgrown the size gate).
 * The parsing itself lives in `plan-pi-spec-descriptor.ts`. What the section's
 * FIRST line is allowed to be — the markdown-structure guard and its punctuation
 * exemptions — is in `test-plan-pi-spec-statement-guard.ts`, and the closer rule
 * the two readers share is pinned in `test-plan-pi-spec-fence-closer.ts`.
 */
import { descriptorProblem } from "../src/plan-pi-spec-descriptor.ts";
import { PI_SPEC_PROBLEM_MAX_CHARS, piSpecFromDraft } from "../src/plan-pi-spec.ts";
import {
  assert,
  draftBody,
  draftBodyWithDescriptor,
  mustSpec,
  specExit,
} from "./lib/plan-pi-spec-fixture.ts";

// ------------------------------------------------------- where the problem comes from

{
  const mapped = mustSpec(
    piSpecFromDraft({
      type: "feature",
      title: "feat: the headline an operator skimmed",
      body: draftBodyWithDescriptor(["a"], "the oracle never sees the issue's own words"),
    }),
    "problem: descriptor",
  );
  assert(
    mapped.problem === "the oracle never sees the issue's own words",
    `problem: the field is the Descriptor text, not the title (got ${JSON.stringify(mapped.problem)})`,
  );

  // No descriptor at all — the section is absent — falls back to the title, which
  // is the pre-feature behaviour and must stay byte-identical. The fixture builds
  // its body from scratch, so "no section" is spelled here as a body that has only
  // the criteria: `draftBody` always writes a `Descriptor: d` line, and passing it
  // a section of our own would not remove it.
  const noSection = mustSpec(
    piSpecFromDraft({
      type: "feature",
      title: "just a title",
      body: "## Acceptance criteria\n\n- a\n",
    }),
    "problem: fallback",
  );
  assert(
    noSection.problem === "just a title",
    `problem: with no Context & motivation section the title is still the problem (got ${JSON.stringify(noSection.problem)})`,
  );

  // An empty descriptor is the same case as no section: "" is not a statement, and
  // `parsePiSpec` would refuse a spec whose problem is empty, so the fallback has
  // to fire on whitespace too.
  for (const blank of ["", "   ", "\t"]) {
    const fallback = mustSpec(
      piSpecFromDraft({
        type: "feature",
        title: "title wins",
        body: draftBodyWithDescriptor(["a"], blank),
      }),
      `problem: blank ${JSON.stringify(blank)}`,
    );
    assert(
      fallback.problem === "title wins",
      `problem: a Descriptor that is only ${JSON.stringify(blank)} falls back to the title (got ${JSON.stringify(fallback.problem)})`,
    );
  }

  // `Type:` is a classification, not a statement. The drafter renders it under the
  // descriptor, so a body that lost its descriptor line must not have the field
  // filled with the literal word `feature`.
  const typeOnly = mustSpec(
    piSpecFromDraft({
      type: "feature",
      title: "title wins again",
      body: `${draftBody(["a"])}\n\n## Context & motivation\n\nType: feature\n`,
    }),
    "problem: type only",
  );
  assert(
    // The draft carries TWO `Context & motivation` sections here (the fixture's own
    // plus this one), which is what a body a drafter or an operator edited by hand
    // looks like: the reader keeps the FIRST section and the fixture's descriptor
    // wins, so the assertion is that the stray `Type:` line never leaks into the
    // field — neither as the classification itself nor as the whole problem.
    typeOnly.problem === "d" && !typeOnly.problem.includes("Type"),
    `problem: a \`Type: feature\` line is never the statement, in a body that carries the section twice (got ${JSON.stringify(typeOnly.problem)})`,
  );

  // And when the `Type:` line is the ONLY thing the one section holds, the title
  // is the problem — a classification is not a statement.
  const typeOnlySingle = mustSpec(
    piSpecFromDraft({
      type: "feature",
      title: "title wins again",
      body: "## Context & motivation\n\nType: feature\n\n## Acceptance criteria\n\n- a\n",
    }),
    "problem: type only, single section",
  );
  assert(
    typeOnlySingle.problem === "title wins again",
    `problem: a section holding only \`Type: feature\` yields the title, never the classification (got ${JSON.stringify(typeOnlySingle.problem)})`,
  );

  // Only the FIRST paragraph is the statement: the rest of the section is rationale
  // nobody asked the machine field to carry.
  const firstPara = mustSpec(
    piSpecFromDraft({
      type: "feature",
      title: "t",
      body: draftBodyWithDescriptor(
        ["a"],
        "the statement line\n\nand the rationale nobody asked for",
      ),
    }),
    "problem: first paragraph",
  );
  assert(
    firstPara.problem === "the statement line" && !firstPara.problem.includes("rationale"),
    `problem: only the first paragraph of the section becomes the field (got ${JSON.stringify(firstPara.problem)})`,
  );

  // The same bound in both directions: a descriptor longer than the field's cap is
  // clipped exactly as a long title always was, so the ceiling the section budget
  // reserves still holds whatever the drafter was handed.
  const long = mustSpec(
    piSpecFromDraft({
      type: "feature",
      title: "t",
      body: draftBodyWithDescriptor(["a"], "x".repeat(PI_SPEC_PROBLEM_MAX_CHARS + 120)),
    }),
    "problem: clipped",
  );
  assert(
    long.problem.length === PI_SPEC_PROBLEM_MAX_CHARS,
    `problem: an over-long descriptor is clipped to the field's bound, as a title was (got ${long.problem.length})`,
  );

  // A code sample first must not be read as the statement: the scan jumps a fence
  // to its closer, so the descriptor below it is what the field carries.
  // A code sample FIRST must not be read as the statement. The sample's own fence
  // is terminated with a LONGER run than it opened, which is legal CommonMark and
  // the shape that distinguishes this reader from a naive one: a scan that only
  // looked for a line starting with three backticks would call the closer a NEW
  // opener and read everything after it as prose, and a scan that swallowed an
  // unterminated fence to the end would lose the statement entirely.
  const fenced = mustSpec(
    piSpecFromDraft({
      type: "feature",
      title: "t",
      body: `## Context & motivation

${["```ts", "Descriptor: not this line at all", "````", "", "the real statement"].join("\n")}

## Acceptance criteria

- a
`,
    }),
    "problem: fenced",
  );
  // A CLOSED block leaves nothing behind — opener, sample and closer all go — so
  // the first prose line the section holds IS the statement, and the sample's own
  // `Descriptor:` line contributed nothing. (The longer closer is legal CommonMark
  // and the shape that separates a reader that tracks fence length from one that
  // only looks for a line starting with a fence run.)
  assert(
    fenced.problem === "the real statement",
    `problem: a \`Descriptor:\` line inside a closed code fence is never the statement (got ${JSON.stringify(fenced.problem)})`,
  );
  assert(
    !fenced.problem.includes("not this line"),
    "problem: the quoted sample's own text never reaches the field",
  );

  // A body whose descriptor line is absent but whose section states prose first
  // still yields that prose — the mapper reads what the section says, and the
  // drafter's prefix is a convention, not a second contract.
  // …and an UNTERMINATED fence is not a block, so its lines stay — which is the
  // case an eat-to-end implementation fails (it loses the statement below it). The
  // fenced lines themselves are still text, and under the mapper's neutralisation
  // the leftover fence run reads as the look-alike character: the assertion is
  // that the body kept its shape and the strip ate nothing.
  const unterminated = mustSpec(
    piSpecFromDraft({
      type: "feature",
      title: "t",
      body: `## Context & motivation

${["```ts", "Descriptor: not this line at all", "", "the real statement"].join("\n")}

## Acceptance criteria

- a
`,
    }),
    "problem: unterminated fence",
  );
  // The mapper neutralises every fence run in a field (`neutraliseFenceRuns`), so
  // the surviving opener reads as U+02CB MODIFIER LETTER GRAVE ACCENT, not as a
  // backtick — and that is the form the block will actually carry.
  const NEUTRALISED_OPEN = String.fromCharCode(0x2cb, 0x2cb, 0x2cb);
  // Both halves of this claim are needed, and the second is what makes the first
  // mean something. The look-alike spelling is what keeps the field safe to print
  // unfenced (see the loop below), so the expected string is the look-alikes
  // themselves: an assertion that only demanded "no backtick run" would also pass
  // with the opener line dropped altogether, which is different — and wrong —
  // behaviour.
  assert(
    unterminated.problem === `${NEUTRALISED_OPEN}ts`,
    `problem: an unclosed fence keeps its own lines, neutralised — a strip that ate to the end would have reached the statement below and lost this one (got ${JSON.stringify(unterminated.problem)})`,
  );
  assert(
    !unterminated.problem.includes("Descriptor") && !unterminated.problem.includes("statement"),
    "problem: the sample's own lines never masquerade as the statement, closed fence or not",
  );
  // A `## ` line INSIDE a code sample must not truncate the section the walker
  // reads. A fence-blind slice ends at the next line beginning `## ` wherever it
  // sits — so here it would stop at the heading INSIDE the sample and the statement
  // below it would never arrive. The walker is fence-aware: it jumps a CLOSED
  // sample whole, so the sample above the statement cannot take it away. (The
  // section opening without any sample is the `bare` case below.)
  assert(
    descriptorProblem(
      "## Context & motivation\n\n```md\n## Acceptance criteria\n```\n\nthe real statement\n\n## Acceptance criteria\n\n- a\n",
    ) === "the real statement",
    "problem: a `## ` line inside a code sample cannot truncate the section — the walker jumps the closed sample (got the statement, not the title)",
  );

  const bare = mustSpec(
    piSpecFromDraft({
      type: "feature",
      title: "t",
      body:
        "## Context & motivation\n\nThe retry helper loses its message.\n\nType: feature\n\n" +
        "## Acceptance criteria\n\n- a\n",
    }),
    "problem: bare prose",
  );
  assert(
    bare.problem === "The retry helper loses its message.",
    `problem: a bare first line is the statement even without the \`Descriptor:\` prefix (got ${JSON.stringify(bare.problem)})`,
  );

  // The shape that turns a fence-blind section reader into a whole dropped spec
  // rather than a misread field: a `## Acceptance criteria` line QUOTED inside a
  // code sample, above the real one. A reader that stopped at the quoted line
  // answered zero criteria, and `piSpecFromDraft` returned undefined BEFORE its
  // title fallback could fire — the draft filed no machine block at all, silently,
  // because a zero-criteria draft is a legitimate shape. So the assertion is not
  // "the problem reads X" but "the criteria were filed", which is the fact an
  // operator notices.
  //
  // The fence has to be a REAL one. A `'''` spelling is not a code sample at all
  // — CommonMark opens a fenced block with a run of three or more backticks or
  // tildes, and nothing else — so a `## ` line under it is an ordinary heading
  // that legitimately ends the section, and a reader that skipped it as sample
  // text would be wrong in the other direction. Both spellings are pinned so the
  // distinction is recorded rather than assumed.
  const criteriaBlock = "## Acceptance criteria\n\n- one\n- two\n";
  const drafted = (quoted: string) =>
    `## Context & motivation\n\n${quoted}Descriptor: the retry helper loses its message\n\n`;

  const quotedHeading = piSpecFromDraft({
    type: "feature",
    title: "a title",
    body: drafted("```md\n## Acceptance criteria\n```\n\n") + criteriaBlock,
  });
  assert(
    quotedHeading !== undefined && quotedHeading.criteria.length === 2,
    `problem: a \`## \` line quoted inside a code sample cannot take the criteria away (got ${quotedHeading === undefined ? "NO BLOCK — the whole spec was dropped" : quotedHeading.criteria.length + " criteria"})`,
  );

  // The same shape with the other fence character CommonMark accepts, with a
  // sample holding several headings, and with an opener indented within 0–3: the
  // reader jumps the sample, it does not stop at its first line.
  for (const [name, quoted] of [
    ["tilde fence", "~~~md\n## Acceptance criteria\n~~~\n\n"],
    ["several headings", "```md\n## Prior context inventory\n## Acceptance criteria\n## Out of scope\n```\n\n"],
    ["indented 3 spaces", "   ```md\n## Acceptance criteria\n   ```\n\n"],
  ] as const) {
    const mapped = piSpecFromDraft({
      type: "feature",
      title: "a title",
      body: drafted(quoted) + criteriaBlock,
    });
    assert(
      mapped !== undefined && mapped.criteria.length === 2,
      `problem: a \`## \` line in a ${name} is sample text, not a section boundary (got ${mapped === undefined ? "NO BLOCK" : mapped.criteria.length + " criteria"})`,
    );
  }

  // …and the closer-LENGTH rule, which is the difference between a body that reads
  // and one that files nothing. A run SHORTER than its opener is CONTENT, so the
  // four-run sample is still open at the three-run "closer": under CommonMark the
  // second `## Acceptance criteria` is sample text, not a section, and only the
  // bullets ABOVE the sample are read. A scan that accepted that short run as the
  // closer read it the other way round — it stopped the section at the "closer", so
  // `- one` is never reached: zero bullets come back, a legitimate shape, so
  // `piSpecFromDraft` returns undefined BEFORE its title fallback and the draft
  // files no machine block at all, silently — the whole-spec loss this pins, and
  // the reason the assertion is "the block was filed" rather than "the criteria
  // read X". The sample line is deliberately not a heading: a `## ` line here would
  // end the section under BOTH readings and the case would prove nothing. Pinned
  // beside `stripPiSpecBlocks`' own shorter-than-opener case in `test-lean-spec.ts`:
  // two readers of the same bytes, one rule.
  const shorterRun = piSpecFromDraft({
    type: "feature",
    title: "a title",
    body: [
      "## Acceptance criteria",
      "",
      "- one",
      "````md",
      "Sentinel sample line",
      "```",
    ].join("\n"),
  });
  assert(
    shorterRun !== undefined && shorterRun.criteria.map((c) => c.text).join(",") === "one",
    `problem: a closer SHORTER than its opener is sample content, so the section still holds its bullet (a lenient closer reached none and filed NO block) (got ${shorterRun === undefined ? "NO BLOCK — the whole spec was dropped" : JSON.stringify(shorterRun.criteria.map((c) => c.text))})`,
  );

  // …and the opposite length: a run LONGER than its opener DOES close the sample,
  // so a scan that only looked for "a line starting with a fence run" would call
  // that closer a NEW opener and read everything after it as sample — including the
  // statement. The sample is deliberately not a heading, so only the walk that
  // stopped ON the closer reaches the statement below it.
  assert(
    descriptorProblem(drafted("```md\nSentinel sample line\n````\n\n") + criteriaBlock) ===
      "the retry helper loses its message",
    "problem: a closer LONGER than its opener closes the sample, so the statement below it is read (not the sample's own text)",
  );

  // …and what an UNCLOSED sample can and cannot contribute to the field. It can:
  // its lines stay, and the mapper neutralises every fence run in a field, so a
  // surviving opener is carried as U+02CB look-alikes (`NEUTRALISED_OPEN` above) —
  // a cosmetic cost, not a breach, and the assertion below is what says so. It
  // cannot: open a block in the prompt. The two prompts print `spec.problem` as bare
  // prose between `## The problem` and the next heading, so a line that opened a
  // fence there would begin a block the step never wrote — and that shape never
  // arrives, because a line that OPENS a sample is not a heading, so the walker
  // cannot take one as the section's first line and cannot carry `#` structure from
  // it either. The three spellings are the openers a fence-blind reader would leak.
  for (const [name, opener] of [
    ["backtick", "```ts"],
    ["tilde", "~~~sh"],
    ["indented 3", "   ```"],
  ] as const) {
    const mapped = mustSpec(
      piSpecFromDraft({
        type: "feature",
        title: "the title",
        body: [
          "## Context & motivation",
          "",
          opener,
          "## INJECTED HEADING",
          "instructions that are not the statement",
          "",
          "## Acceptance criteria",
          "",
          "- a",
        ].join("\n"),
      }),
      `problem: unclosed ${name}`,
    );
    assert(
      !/^#/m.test(mapped.problem) && !mapped.problem.includes("INJECTED"),
      `problem: an unclosed ${name} sample contributes no heading to the field the prompts print unfenced (got ${JSON.stringify(mapped.problem)})`,
    );
  }

  // …and a `'''` block is NOT a sample: its `## ` line is a real heading, so the
  // section legitimately ends there and the criteria really are absent. Pinning
  // this is what stops the fix being written as "skip anything after three quote
  // characters", which would file a spec the draft never made.
  const notAFence = piSpecFromDraft({
    type: "feature",
    title: "a title",
    body: drafted("'''md\n## Acceptance criteria\n'''\n\n") + criteriaBlock,
  });
  assert(
    notAFence === undefined,
    `problem: a \`## \` line under a \`'''\` block is a real heading and does end the section — three apostrophes are not a fence (got ${notAFence === undefined ? "NO BLOCK, as they should be" : notAFence.criteria.length + " criteria"})`,
  );

  // …and the OTHER way a sample escapes this reader: where its closing fence sits.
  // A sample opened under a list item closes on a run indented as deeply as that
  // item's content — the same 0–3 bound an opener carries — so its lines are sample
  // text and its bullets are NOT criteria. A reader that applied the indent rule to
  // openers alone, recognising a closer at column 0, never closes that sample: it
  // reads the lines as section text and files a bullet written inside the code
  // sample as a real criterion, which `placePiSpecSection` then embeds in the filed
  // `pi-spec v1` block — the oracle's contract claiming a check the task statement
  // never asked for, the class this issue exists to close.
  const indentedCloser = piSpecFromDraft({
    type: "feature",
    title: "a title",
    body: [
      "## Acceptance criteria",
      "",
      "- one",
      "  ```md",
      "- the check runs before the draw",
      "  ```",
      "- two",
    ].join("\n"),
  });
  assert(
    indentedCloser !== undefined &&
      indentedCloser.criteria.map((c) => c.text).join(",") === "one,two",
    `problem: a sample whose closer is indented with its list item keeps that bullet out of the criteria (got ${indentedCloser === undefined ? "NO BLOCK" : JSON.stringify(indentedCloser.criteria.map((c) => c.text))})`,
  );
}

// …and what the FIRST line of the section is allowed to be — the structural guard,
// its punctuation exemptions, and kept sample text — in
// test-plan-pi-spec-statement-guard.ts, which shares this fixture.

process.exit(specExit());
