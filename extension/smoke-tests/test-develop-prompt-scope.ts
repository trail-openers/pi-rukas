#!/usr/bin/env bun
/**
 * A single-workstream developer is still a developer with a scope.
 *
 * `inlineDevelopPrompt` gated the whole scope block on
 * `workstream && workstreamId && workstreamId !== "default"`, and `runDevelop`
 * passes `ids.length > 1 ? id : undefined` — so on an N=1 cycle the developer
 * saw none of it: not the scope sentence, not the in-scope file list, not the
 * out-of-scope fence, and not the vipune memory brief.
 *
 * Measured on this host: **all 16 `.pi/work-state/*.json` files are N=1.** So on
 * every real cycle the plan step produced a scope fence that was then thrown
 * away, and the memory brief — an ~8s vipune retrieval the driver pays for
 * before every develop dispatch — was computed and discarded.
 *
 * The multi-workstream framing ("one of multiple developers running in
 * parallel") is genuinely N>1-only. The scope itself is not.
 */

import { inlineDevelopPrompt } from "../src/work-driver-prompts-early.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const ws = {
  id: "default",
  scope: "Add the retry ceiling check to the startup path",
  paths: ["extension/src/retry-config-check.ts", "extension/src/index.ts"],
  outOfScope: ["extension/src/spawn.ts", "install.sh"],
};

const BRIEF = "Prior memory: #394 calibrated the retrieval floor; do not re-derive it.";

// ------------------------------------------------ N=1: the scope still lands

{
  const prompt = inlineDevelopPrompt([664], "/tmp/scratch", ws, undefined, undefined, BRIEF);

  assert(
    prompt.includes("Add the retry ceiling check"),
    "canary: the N=1 developer is told its scope — dropped entirely before this",
  );
  assert(
    prompt.includes("extension/src/retry-config-check.ts"),
    "canary: ...and the in-scope file list",
  );
  assert(
    prompt.includes("install.sh") && /OUT OF SCOPE/i.test(prompt),
    "canary: ...and the out-of-scope fence the plan step exists to produce",
  );
  assert(
    prompt.includes("Prior memory: #394"),
    "canary: ...and the vipune memory brief, paid for on every dispatch and discarded on N=1",
  );
  assert(
    !/one of multiple developers/i.test(prompt),
    "but NOT the parallel-workstream framing — there is only one developer here",
  );
}

// ---------------------------------------- #621: commit instructions present

{
  const prompt = inlineDevelopPrompt([621], "/tmp/scratch", ws, undefined, undefined, undefined);
  assert(
    prompt.includes("git add -A"),
    "#621: inlineDevelopPrompt contains explicit `git add -A` (AC2 — commit instruction is now actionable, not just a 'natural seams' phrasing)",
  );
  assert(
    /git commit -m/.test(prompt),
    "#621: inlineDevelopPrompt contains explicit `git commit -m` (AC2)",
  );
  assert(
    /Do NOT push/i.test(prompt),
    "#621: inlineDevelopPrompt still says 'Do NOT push' (push is still @ops's job)",
  );
  assert(
    /uncommitted.*REJECT|REJECT.*uncommitted/i.test(prompt),
    "#621: inlineDevelopPrompt states uncommitted-only work WILL BE REJECTED (AC2 — the verify gate requirement is explicit, not implied)",
  );
}

// ----------------------------------------- N>1 is unchanged, framing included

{
  const prompt = inlineDevelopPrompt(
    [664],
    "/tmp/scratch",
    { ...ws, id: "task-a" },
    "task-a",
    undefined,
    BRIEF,
  );
  assert(/one of multiple developers/i.test(prompt), "N>1 keeps the parallel framing");
  assert(prompt.includes("task-a"), "...and names the workstream");
  assert(prompt.includes("Add the retry ceiling check"), "...and still carries the scope");
}

// --------------------------------------------- nothing to say, nothing said

{
  const bare = inlineDevelopPrompt(
    [664],
    "/tmp/scratch",
    undefined,
    undefined,
    undefined,
    undefined,
  );
  assert(!/OUT OF SCOPE/i.test(bare), "no workstream → no fence section invented");
  assert(!bare.includes("undefined"), "canary: and no 'undefined' leaks into the prompt");
  assert(bare.includes("664"), "...but the issue is still there");

  const noPaths = inlineDevelopPrompt(
    [664],
    "/tmp/scratch",
    { ...ws, paths: [], outOfScope: [] },
    undefined,
    undefined,
    undefined,
  );
  assert(
    /derive from the scope description/i.test(noPaths),
    "a workstream with no declared paths says so rather than printing an empty list",
  );
  assert(!noPaths.includes("undefined"), "...still no 'undefined'");
}

// ---------- #679 CASE 1: sibling-workstream injection for N>1 only ----------

{
  const a = {
    id: "task-a",
    scope: "Plan-prompt contract lines",
    paths: ["extension/src/work-driver-prompts-early.ts"],
    outOfScope: ["extension/src/work-driver-plan.ts"],
  };
  const b = {
    id: "task-b",
    scope: "Develop-prompt sibling injection",
    paths: ["extension/src/work-driver-prompts-late.ts"],
    outOfScope: [],
  };

  // The N>1 case: each developer is told what the SIBLING workstreams are
  // (id, scope, declared paths) — informational only, NOT their scope.
  const promptB = inlineDevelopPrompt([679], "/tmp/scratch", b, "task-b", undefined, undefined, [a]);
  assert(/Sibling workstreams in this cycle/i.test(promptB), "#679: N>1 developer prompt names the sibling block");
  assert(promptB.includes("task-a"), "#679: sibling id appears in the developer prompt");
  assert(promptB.includes("Plan-prompt contract lines"), "#679: sibling scope appears in the developer prompt");
  assert(
    promptB.includes("extension/src/work-driver-prompts-early.ts"),
    "#679: sibling declared paths appear in the developer prompt",
  );
  assert(
    /informational only/i.test(promptB) && /NOT your scope/i.test(promptB),
    "#679: the sibling block is framed as informational only (NOT your scope)",
  );
  assert(
    promptB.includes("task-b") && /one of multiple developers/i.test(promptB),
    "#679: the N>1 parallel framing + own workstream id are still present",
  );

  // The sibling workstream's own paths must NOT bleed into the receiver's
  // scope: the receiver's in-scope file list is still its own, and the
  // out-of-scope fence is unchanged.
  assert(
    /In-scope files: extension\/src\/work-driver-prompts-late\.ts/.test(promptB),
    "#679: the receiver's in-scope file list is its own, not the sibling's",
  );

  // Symmetric: A also sees B.
  const promptA = inlineDevelopPrompt([679], "/tmp/scratch", a, "task-a", undefined, undefined, [b]);
  assert(promptA.includes("task-b"), "#679: symmetric — A's prompt names B");

  // No siblings → no sibling block (same prompt as before the #679 change
  // for this input). The driver only passes siblings for N>1 cycles.
  const solo = inlineDevelopPrompt([679], "/tmp/scratch", a, "task-a", undefined, undefined, []);
  assert(
    !/Sibling workstreams in this cycle/i.test(solo),
    "#679: an N>1-framed workstream with an empty sibling list gets no sibling block",
  );

  // A sibling listing that happens to include the receiver's own id is
  // filtered out (defensive: the driver shouldn't pass it, but the prompt
  // must not render the workstream as its own sibling).
  const self = inlineDevelopPrompt([679], "/tmp/scratch", b, "task-b", undefined, undefined, [a, b]);
  assert(
    (self.match(/task-b/g) ?? []).length <= 2,
    "#679: the workstream never lists itself as a sibling (self-entry filtered)",
  );
}

// ---------- #679: N=1 `default` path stays byte-identical ------------------

{
  const before = inlineDevelopPrompt([664], "/tmp/scratch", ws, undefined, undefined, BRIEF, undefined);
  assert(!/Sibling workstreams in this cycle/i.test(before), "#679: N=1 prompt has no sibling block");
  // The N=1 prompt built with NO siblings passed is byte-identical to the
  // pre-#679 shape: the sibling param is purely additive for N>1.
  const noArg = inlineDevelopPrompt([664], "/tmp/scratch", ws, undefined, undefined, BRIEF);
  assert(
    before === noArg,
    "#679: passing an undefined sibling list is byte-identical to omitting the arg (N=1 invariant)",
  );
  // And a N=1 prompt that somehow received a sibling list (defensive) stays
  // silent: the gate is `parallel`, not the list's length.
  const n1WithSiblings = inlineDevelopPrompt(
    [664],
    "/tmp/scratch",
    ws,
    undefined,
    undefined,
    BRIEF,
    [{ id: "task-x", scope: "sibling scope", paths: ["src/x.ts"] }],
  );
  assert(
    !/Sibling workstreams in this cycle/i.test(n1WithSiblings),
    "#679: N=1 (no workstreamId) never shows the sibling block, even if one is passed",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
