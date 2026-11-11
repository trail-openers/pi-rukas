#!/usr/bin/env bun
/**
 * lean/challenge — the command's handler table, not the round.
 *
 * `phase1Handlers` is what the machine dispatches on, so the two facts that
 * matter are that `challenge` is the REAL step and that no state still on the
 * table answers with the not-built stub. A stub that returned an outcome kind the
 * table does not list would end the run on `no transition for <state> + "…"`,
 * blaming the machine for a stage nobody built.
 *
 * Split out of test-lean-challenge.ts, which is the round's git/worktree
 * behaviour and had outgrown the size gate; the fixture is shared, so both files
 * run the same step.
 */
import { phase1Handlers } from "../src/lean/command.ts";
import { HANDLER_STATES } from "../src/lean/machine.ts";
import { challengeFixture, git, runChallenge } from "./lib/lean-challenge-fixture.ts";
import { assert, specExit } from "./lib/plan-pi-spec-fixture.ts";

// ------------------------------ (m) phase1Handlers wires the real challenge step
//
// The not-built stub THROWS "… is not built yet"; the real step refuses a
// missing worktree by naming it, so the two cannot be confused.
{
  const built = challengeFixture(213);
  git(built.repoRoot, "worktree", "remove", "--force", built.worktree);
  const handler = phase1Handlers(built.repoRoot, 213).challenge;
  const settled = handler
    ? await handler(built.ctx).then(
        (o) => o,
        (err: unknown) => err,
      )
    : "no challenge handler";
  assert(
    settled instanceof Error && settled.message.includes("does not exist"),
    `(m) phase1Handlers.challenge is the real step (got ${settled instanceof Error ? settled.message : JSON.stringify(settled)})`,
  );
  assert(
    !(settled instanceof Error && /not built yet/.test(settled.message)),
    "(m) it is not the notBuilt stub answering for the challenge state",
  );
}

// ------------------- (n) every state's handler is the real step, not the stub
//
// A stub that returned an outcome kind the table does not list would end the run
// on `no transition for <state> + "…"`, blaming the machine for a stage nobody
// built. A throw is what the engine already turns into a handed-back run whose
// reason names the missing stage. `verify`, `handback`, `publish`, `review`,
// `ci` and `land` are not in the list: each is a real step now, and
// `test-lean-verify-wiring.ts` / `test-lean-publish.ts` /
// `test-lean-review-wiring.ts` / `test-lean-ci-land-wiring.ts` assert each is
// the step rather than the stub.
//
// `ci` and `land` came off this list when their steps landed, and `review` was
// already real. Every state in `HANDLER_STATES` now has a handler, so there is
// no stage left to assert as a stub: this case asserts the property the empty
// list would have asserted vacuously (every state has a handler at all, so the
// engine reaches it) plus the one that still means something now — that no
// handler still answers with the stub's `not built yet`, which is how a
// half-landed step looks from the outside. A stub that RETURNED an outcome kind
// the table does not list is caught by `test-lean-machine.ts`, which enumerates
// the graph; this case catches the other shape, a step wired to the stub.
{
  const built = challengeFixture(214);
  const handlers = phase1Handlers(built.repoRoot, 214);
  const states = HANDLER_STATES;
  const messages = await Promise.all(
    states.map((s) =>
      (handlers[s] as (c: never) => Promise<unknown>)(built.ctx as never).then(
        String,
        (e: unknown) => (e as Error).message,
      ),
    ),
  );
  assert(
    states.length > 0 && states.every((s) => typeof handlers[s] === "function"),
    `(n) every state in the table has a handler, so the engine reaches it rather than falling off the table (got ${String(states.length)})`,
  );
  assert(
    messages.every((m, i) => !String(m).includes(`work-lean stage ${states[i]} is not built yet`)),
    `(n) no handler still answers with the notBuilt stub's reason for its own state (got ${JSON.stringify(messages.map((m) => String(m).slice(0, 40)))})`,
  );
}

process.exit(specExit());
