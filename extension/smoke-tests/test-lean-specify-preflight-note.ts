#!/usr/bin/env bun
/**
 * lean/specify — the runner probe's disclosure is BOUNDED (#2202).
 *
 * Split from `test-lean-specify-preflight-py.ts` for the §12 line cap, along the
 * seam that file already had: those cases are about WHERE the probe goes and what
 * one exit status MEANS, and this file is about the ONE LINE the step records when
 * the answer is "the runner refused the probe". It is a different contract because
 * the payload is different — `proof.cmd` is the project's OWN `verify.test` template
 * with the probe path substituted, so it is text from outside this process, joined
 * onto a reason the durable record stores and the handback comment prints.
 *
 *   (n) the disclosure is CLIPPED, so a project-authored template cannot widen the
 *       reason line, and a clipped command says it was cut rather than ending as if
 *       the command did;
 *   (q) the bound holds at the JOIN, not only at the writer — the clause this step
 *       contributes to someone else's sentence is as bounded as that sentence, and a
 *       template with control characters in it is FLATTENED rather than interpolated.
 *
 * `oneLine` and not a bare interpolation is the whole rule here, so both cases put
 * the hostile text in the TEMPLATE and read the note the step produced.
 */

import { rmSync } from "node:fs";
import { PROBE_NOTE_MAX_CHARS, PROBE_REJECTED } from "../src/lean/specify-preflight-write.ts";
import { joinNotes } from "../src/lean/text-fence.ts";
import { PY_PROBE, probeDir, runPreflight, runner } from "./lib/lean-preflight-probe-fixture.ts";
import { ROOTS } from "./lib/lean-specify-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ── (n) the disclosure is clipped, so a template cannot widen the reason line
{
  // `proof.cmd` is the project's OWN `verify.test` template with the probe path
  // substituted, and the disclosure is joined onto the step's reason. Sibling
  // renderers clip a printed command for exactly that reason (`publish-body.ts`);
  // an unclipped one here let a config widen the line, and the ellipsis is what
  // tells the reader the command continued.
  const dir = probeDir();
  // The template is project-authored text, so this is a template with many
  // arguments rather than an impossibly long file name: what is bounded is the width
  // of the reason line the disclosure is joined onto, and `validateTestRunner` has
  // already refused the metacharacters that would make a fat template any other way.
  const args = Array.from({ length: 40 }, (_, i) => `--flag${String(i)}`).join(" ");
  // The runner is the fixture's `throwOnRun` seam rather than a script, so the status
  // under test is 4 itself — the one status the step reads as a disclosure. An exit 2
  // would have been classified as a hand-back and the case would be about nothing.
  const clipped = await runPreflight({
    wt: dir,
    template: `sh ${args} exit4many.sh {file}`,
    testLocation: { testDir: "tests", testGlob: "test_*.py" },
    throwOnRun: () => ({ code: 4, stderr: "no collector for file" }),
  });
  assert(
    clipped.note !== undefined,
    `(n) the long-template run still discloses (got ${clipped.threw?.message ?? clipped.note})`,
  );
  assert(
    clipped.note !== undefined && clipped.note.length < 250,
    `(n) the disclosure is CLIPPED to a reason-sized line (got ${String(clipped.note?.length)} chars)`,
  );
  assert(
    clipped.note !== undefined && /…$/.test(clipped.note),
    `(n) and it says it was cut, rather than ending as if the command did (got ${clipped.note})`,
  );
  assert(
    clipped.note !== undefined && !clipped.note.includes("r".repeat(30)),
    `(n) so the template is not quoted back whole (got ${clipped.note})`,
  );
}
// ── (q) the disclosure clause the step JOINS onto its reason stays reason-sized
{
  // The note is not only a fixture return value: `specify.ts` joins it onto the
  // step's own reason, which the durable record stores and the handback comment
  // prints. A clause a project-authored template could lengthen without bound is a
  // clause that widens someone else's sentence — so the bound is asserted on the
  // clause itself, at its writer, and on the join that composes it.
  //
  // The runner here is the fixture's `throwOnRun` seam answering 4 through a
  // template padded with forty arguments: padding is the only legal way to make a
  // fat template, since `validateTestRunner` refuses the shell metacharacters that
  // would do it otherwise.
  const dir = probeDir();
  const args = Array.from({ length: 40 }, (_, i) => `--padding-flag-${String(i)}=`).join(" ");
  // A second arm puts control characters INTO the template. `validateTestRunner`
  // refuses them at the config boundary, but the disclosure is rendered from the
  // command string, and a renderer that only clipped length would still let a
  // newline end the reason line or a `|` open a column in the table it is printed
  // in — which is why the note goes through `oneLine` and not a `slice`.
  const hostile = await runPreflight({
    wt: dir,
    template: `sh $'a\nb'|c\tpadded.sh {file}`,
    testLocation: { testDir: "tests", testGlob: "test_*.py" },
    throwOnRun: () => ({ code: 4, stderr: "no collector for file" }),
  });
  const got = await runPreflight({
    wt: dir,
    template: `sh ${args} padded.sh {file}`,
    testLocation: { testDir: "tests", testGlob: "test_*.py" },
    throwOnRun: () => ({ code: 4, stderr: "no collector for file" }),
  });
  const clause = got.note ?? "";
  // The command is what gets clipped, so at this width the probe path has scrolled
  // past the bound: the assertion is that the NOTE still leads with the fact it is
  // disclosing, and that a SHORT command keeps the path the reader acts on.
  assert(
    clause.startsWith(PROBE_REJECTED) && clause.includes("sh --padding-flag-0="),
    `(q) the clause leads with the rejection and quotes the command's front (got ${clause})`,
  );
  assert(
    clause.length <= PROBE_NOTE_MAX_CHARS,
    `(q) the clause stays within the bound the step joins it under (${String(PROBE_NOTE_MAX_CHARS)}) (got ${String(clause.length)})`,
  );
  assert(
    /…$/.test(clause),
    `(q) a clipped command says it was cut rather than ending as if it did (got ${clause})`,
  );
  assert(
    !clause.includes("\n") && !clause.includes("|"),
    `(q) the clause is one line with no table column, so it cannot end or widen the reason it is joined onto (got ${JSON.stringify(clause)})`,
  );
  const hostileNote = hostile.note ?? "";
  assert(
    hostileNote.includes("rejected the probe file"),
    `(q) the control-character template still gets its disclosure (got ${JSON.stringify(hostileNote)})`,
  );
  assert(
    !hostileNote.includes("\n") && !hostileNote.includes("\t"),
    `(q) the note FLATTENS control characters rather than passing them through (got ${JSON.stringify(hostileNote)})`,
  );
  const short = await runPreflight({
    wt: dir,
    template: runner(dir, "short4.sh", "exit 4"),
    testLocation: { testDir: "tests", testGlob: "test_*.py" },
    throwOnRun: () => ({ code: 4, stderr: "no collector for file" }),
  });
  assert(
    (short.note ?? "").includes(PY_PROBE),
    `(q) and a template inside the bound still names the probe it was refused for (got ${short.note})`,
  );
  // The join itself, at the same bound: two clauses and a separator must not exceed
  // the record's reason bound by the probe clause's width.
  const joined = joinNotes(["the child never submitted a test", clause]);
  assert(
    joined.length <= "the child never submitted a test".length + 2 + PROBE_NOTE_MAX_CHARS,
    `(q) and the joined reason grows only by the clause's own bound (got ${String(joined.length)})`,
  );
  assert(
    joined.includes("the child never submitted a test") && joined.includes("; "),
    `(q) the decline still reads first, with the disclosure appended (got ${joined})`,
  );
}
for (const dir of ROOTS) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the OS reaps tmpdir */
  }
}

process.exit(exit);
