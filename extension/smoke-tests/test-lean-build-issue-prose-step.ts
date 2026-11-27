#!/usr/bin/env bun
/**
 * #2228 — the builder's seat gets the issue section, at the STEP boundary.
 *
 * `build.ts`'s `specOf` awaited the fetch, parsed the `pi-spec` block out of the
 * body and returned `parsed.spec` alone, so the text was gone before the prompt
 * was assembled. The fixture's default body is a bare `pi-spec` fence with no
 * prose around it, which is exactly why no existing build case could notice the
 * gap: a renderer that printed nothing still passed. This file injects a body
 * with a requirement in prose OUTSIDE the block (#2171's fixture shape) and
 * asserts the builder's brief carries it — and that the step still reads the
 * issue exactly ONCE, since threading the body means handing on the bytes the
 * spec was parsed from, never a second `gh` round-trip.
 */
import { LEAN_BUILD_ISSUE_LEAD } from "../src/lean/issue-prose.ts";
import { SPEC_BODY_WITH_PROSE } from "./lib/lean-build-asserts.ts";
import { put, runBuild } from "./lib/lean-build-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const PROSE_BODY = SPEC_BODY_WITH_PROSE;
// The two sides of the block are asserted SEPARATELY, each on a string only that
// side carries — the strip removes one contiguous region, so a single conjunctive
// assertion cannot tell "both halves survived" from "the head survived and the
// tail went unnoticed". The tail line used to re-print a criterion verbatim, so a
// renderer that clipped the body at the block still satisfied it; `TAIL-ONLY:` is
// in neither the spec object nor the criteria, so only the strip-and-print path
// can put it in the brief, and its position pins that it landed INSIDE the section
// rather than echoed somewhere else in it.

const r = await runBuild({
  issue: 2228,
  specBody: PROSE_BODY,
  child: (wt) => put(wt, "src/retry.ts", "export const retry = () => 7;\n"),
});
const prompt = r.prompts[0] ?? "";
assert(
  r.threw === undefined && r.outcome?.kind === "ok",
  `(a) the round ran: ${r.threw?.message ?? r.outcome?.kind}`,
);
assert(r.fetched === 1, `(a) the issue was read exactly once (got ${r.fetched})`);
assert(
  prompt.includes("Add retry to the meter's quota check."),
  "(a) the prose ABOVE the spec block reaches the builder's brief",
);
assert(
  prompt.includes('TAIL-ONLY: the exception message must remain exactly "quota exceeded"'),
  "(a) the prose BELOW the block reaches it too — a strip or a renderer that lost the tail fails here",
);
assert(
  prompt.indexOf("## The issue") < prompt.indexOf("TAIL-ONLY:") &&
    prompt.indexOf("TAIL-ONLY:") < prompt.indexOf("## The acceptance criteria"),
  "(a) the tail sits INSIDE the section, not echoed somewhere else in the brief",
);
assert(
  !prompt.includes('"verify": "test"'),
  "(a) the spec block itself is stripped — the criteria are printed below, not embedded twice",
);
assert(
  prompt.includes("`pi-spec v1`"),
  "(a) the prose that QUOTES the block format survives the strip and the fence guard — only a surviving spec-shaped FENCE refuses the section",
);
assert(
  prompt.includes("```text") &&
    prompt.indexOf("## The issue") < prompt.indexOf("## The acceptance criteria"),
  "(a) the section sits between the problem and the criteria, behind the fence",
);
assert(
  prompt.includes(LEAN_BUILD_ISSUE_LEAD),
  "(a) the builder's own lead is the sentence that tells it what the prose is for",
);

process.exit(exit);
