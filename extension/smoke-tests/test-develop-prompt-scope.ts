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

console.log(`\nexit ${exit}`);
process.exit(exit);
