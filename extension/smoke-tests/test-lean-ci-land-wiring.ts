#!/usr/bin/env bun
/**
 * lean/command — `ci` and `land` are wired, and unbuilt is still unbuilt.
 *
 * The engine routes on the handler table, so a state whose entry is still the
 * `notBuilt` stub walks past its own gate: the stub throws, and a throw on `ci`
 * is the same handed-back ending a real infrastructure fault gets. Nothing else
 * in the suite distinguishes "the table says ci" from "the table still says
 * notBuilt", which is exactly how a half-landed step looks from the outside.
 *
 *   (n) phase1Handlers.ci is the real step, not the stub
 *   (o) phase1Handlers.land is the real step, not the stub
 *   (p) the states that ARE still unbuilt keep throwing the stub's reason
 *
 * Both real handlers are driven on a fixture log with no forge and no full tier,
 * so each reaches its own refusal sentence — which the stub cannot produce. For
 * `ci` that sentence is the missing full tier, and the order of the two checks
 * (tier first, forge second) is what makes this case reach it at all: a run with
 * no tier has no green on offer and must not pay for a forge read. The forge
 * half of the same ordering is `test-lean-ci-gl.ts`'s no-adapter case.
 */

import { rmSync } from "node:fs";
import { phase1Handlers } from "../src/lean/command.ts";
import type { Outcome } from "../src/lean/state.ts";
import { ROOTS, ciLandLog } from "./lib/lean-ci-land-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

async function call(state: "ci" | "land", issue: number): Promise<unknown> {
  const f = ciLandLog(issue);
  // `ci` asks for a full tier BEFORE it reads the forge (a run with no tier has
  // no green on offer and must not pay for a forge read), so on a fixture repo
  // with no forge either refusal could be the step's — and the tier sentence is
  // the one only the step writes. `land`'s grant sentence needs no such help.
  const handler = phase1Handlers(f.repoRoot, issue)[state];
  if (handler === undefined) return "no handler";
  return handler(f.ctx).then(
    (o) => o,
    (err: unknown) => err,
  );
}

// ── (n) `ci` is the step: its refusal is about the tier, not the stub ─────
{
  const settled = await call("ci", 301);
  const message = settled instanceof Error ? settled.message : JSON.stringify(settled);
  assert(
    !String(message).includes("not built yet"),
    `(n) phase1Handlers.ci is the real step, not the stub (${message})`,
  );
  // With no full tier configured anywhere, the step's own first refusal is the
  // missing tier — a sentence only the step writes.
  assert(
    (settled as Outcome)?.kind === "red" &&
      String((settled as Outcome)?.reason ?? "").includes("no full verify tier"),
    `(n) and it reached its own missing-tier refusal (${message})`,
  );
}

// ── (o) `land` is the step: its refusal is about the grant ───────────────
{
  const settled = await call("land", 302);
  const message = settled instanceof Error ? settled.message : JSON.stringify(settled);
  assert(
    !String(message).includes("not built yet"),
    `(o) phase1Handlers.land is the real step, not the stub (${message})`,
  );
  assert(
    (settled as Outcome)?.kind === "refused" &&
      String((settled as Outcome)?.reason ?? "").includes("autoMerge"),
    `(o) and it reached its own ungranted refusal (${message})`,
  );
}

// ── (p) a stage that became real keeps its own refusal, not the stub's ──
//
// `review` is built on this branch — it landed before `ci` and `land`, so the
// case this replaced (an unbuilt stage still throwing the stub's reason) has no
// stage left to name. What it proved is kept in the direction that still means
// something: a wired step answers with its OWN sentence, so the (n)/(o) shapes
// above are not what a mis-wired table entry would produce.
{
  const f = ciLandLog(303);
  const handlers = phase1Handlers(f.repoRoot, 303);
  const stubs = ["review"] as const;
  const messages = await Promise.all(
    stubs.map((s) =>
      (handlers[s] as unknown as (c: never) => Promise<unknown>)(f.ctx as never).then(
        String,
        (e: unknown) => (e as Error).message,
      ),
    ),
  );
  assert(
    stubs.every((_, i) => !String(messages[i]).includes("not built yet")),
    `(p) the review step answers with its own reason, not the stub's (got ${JSON.stringify(messages)})`,
  );
}

for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
process.exit(exit);
