#!/usr/bin/env bun
/**
 * lean/publish — the draft gate, driven end to end through the real step.
 *
 * `publish` decides one thing a reviewer acts on: is this PR mergeable as it
 * stands? A `command` criterion the gate never executed is a criterion nobody
 * checked, and a ready PR behind an unchecked criterion is exactly the claim this
 * step exists to refuse — so it holds the PR as a draft, exactly as a `manual`
 * criterion does.
 *
 * The mirror case matters just as much, and is the one a cautious renderer gets
 * wrong: a green verify that ran EVERY command criterion, with no manual criterion
 * anywhere, must open a READY PR. A step that drafted on a satisfied criterion
 * would leave a run with no way to ever be ready, and nobody would notice the PR
 * sitting there.
 *
 * Both halves go through `runPublish` — real git, a real bare origin, a recording
 * fake forge — so the assertion is about the `draft` the step handed the forge and
 * the body it rendered, not about a renderer called directly (that is
 * `test-lean-publish-body.ts`).
 */

import type { PiSpec } from "../src/lean/spec.ts";
import { ROOTS, defaultSpec, runPublish } from "./lib/lean-publish-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// --------------------- (b2) the draft gate end to end: a command criterion decides
//
// The two halves of one rule, driven through the real step rather than the
// renderer. A `command` criterion the gate never executed is a criterion nobody
// checked, and a ready PR behind an unchecked criterion is exactly the claim the
// publish step exists to refuse — so it holds the PR as a draft, exactly as a
// `manual` criterion does. The mirror case matters just as much: a green verify
// that ran every command criterion, with no manual criterion anywhere, must open a
// READY PR. A gate that drafted on a satisfied criterion would leave a run with no
// way to be ready, and nobody would notice the PR sitting there forever.
{
  const spec: PiSpec = {
    ...defaultSpec(),
    criteria: [
      { id: "AC1", text: "a transient failure is retried", verify: "test" },
      {
        id: "AC2",
        text: "the existing suite still passes",
        verify: "command",
        command: "tests/AC2-bound.test.sh",
      },
    ],
  };
  // Green verify whose record OMITS AC2 — the gate declined to run it.
  const declined = await runPublish({
    issue: 422,
    verify: { kind: "green" },
    spec,
    commandCriteria: {},
  });
  assert(
    declined.forge.prCreateCalls[0]?.draft === true,
    `(b2) a green verify that ran no command criterion keeps the PR a draft (${JSON.stringify(declined.forge.prCreateCalls[0]?.draft)})`,
  );
  assert(
    declined.body.includes("not executed (command)") && !declined.body.includes("passed (command"),
    "(b2) the body says the command criterion was not executed, and never claims it passed",
  );

  // Same spec, same green verify — but the record says the gate ran AC2 and it held.
  const executed = await runPublish({
    issue: 423,
    verify: { kind: "green" },
    spec,
    commandCriteria: { AC2: "passed" },
  });
  assert(
    executed.forge.prCreateCalls[0]?.draft === false,
    `(b2) a green verify that ran every command criterion, with no manual criterion, opens a READY PR (${JSON.stringify({ draft: executed.forge.prCreateCalls[0]?.draft, threw: executed.threw?.message })})`,
  );
  assert(
    executed.body.includes("passed (command; test file unchanged since base)"),
    "(b2) the ready body prints the command row from the gate's own record",
  );
  assert(
    !executed.body.includes("- draft:"),
    "(b2) a ready PR's body carries no draft explanation",
  );
}

for (const dir of ROOTS) {
  try {
    (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
process.exit(exit);
