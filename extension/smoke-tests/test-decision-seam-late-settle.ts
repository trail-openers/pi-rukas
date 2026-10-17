#!/usr/bin/env bun
/**
 * A backend that answers after the ABORT won is traced as discarded (#1393).
 *
 * The timeout racer has always traced a late settle. The abort racer did not, so
 * the exact same event — a judge replying after nobody is waiting for it — was
 * invisible whenever the caller was killed rather than the bound expiring. A
 * backend that IGNORES its cancellation signal is the shape that produces it, so
 * the backend here resolves on its own timer and only on its own timer: if the
 * abort were what settled it, the trace below would be reporting a normal answer.
 *
 * Split from test-decision-seam-abort.ts (the 500-line cap), which owns the
 * rest of the abort contract; this file is that one claim. Offline: the backend
 * is a closure, no network.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Backend, BackendInput, BackendResult } from "../src/decision-backends.ts";
import { SEAMS, type SeamSpec } from "../src/decision-seam-registry.ts";
import { decide } from "../src/decision-seam.ts";
import { makeAssert, tmpDir } from "./lib/decision-fixtures.ts";

const { assert, state } = makeAssert();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SEAM_BOUND_MS = 3_000;
/** The abort arrives well before the backend's own settle. */
const ABORT_AT_MS = 100;
/** The deaf backend's own settle: after the abort, well before the bound. */
const DEAF_SETTLE_MS = 400;

const seam = "fixture-abort-late-settle";
(SEAMS as Record<string, SeamSpec>)[seam] = {
  id: seam,
  kind: "choice",
  instructions: "Does the thing look ok?",
  labels: { ok: "fine", flag: "needs a human" },
  ruleDefault: "flag",
  passing: ["ok"],
  composition: "advisory",
  defaultMode: "shadow",
  evidence: "none",
  owner: "test-decision-seam-late-settle.ts",
  timeoutMs: SEAM_BOUND_MS,
  tokenBudget: 8_000,
};

{
  const root = tmpDir("abort-late-settle");
  // A bare `.git` directory makes the temp dir its own checkout, so the record
  // cannot be re-routed to this repo's main checkout by `mainCheckout`.
  mkdirSync(path.join(root, ".git"), { recursive: true });
  const warned: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    const line = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    if (line.includes("settled after its")) warned.push(line);
    else realWrite(chunk as never, ...(rest as []));
    return true;
  }) as typeof process.stderr.write;

  const ac = new AbortController();
  setTimeout(() => ac.abort(), ABORT_AT_MS);
  const deaf: Backend = {
    name: "ignores-its-signal",
    source: "llm",
    run: (_input: BackendInput, _signal: AbortSignal) =>
      // Deliberately does NOT resolve on `signal` — a backend that keeps
      // streaming after being told to stop.
      new Promise<BackendResult>((resolve) => {
        setTimeout(() => resolve({ ok: true, answer: "ok" }), DEAF_SETTLE_MS);
      }),
  };
  const d = await decide(
    seam as never,
    { state: { probe: "value" }, question: "q", rule: "ok" },
    {
      backends: [deaf],
      signal: ac.signal,
      repoRoot: root,
    },
  );
  assert(
    d.source === "rule" && d.abstained,
    `the aborted call answered from the rule while the deaf backend kept going (${d.source})`,
  );
  // Wait past the backend's own settle so the late resolution happens for real.
  await sleep(SEAM_BOUND_MS * 0.5);
  process.stderr.write = realWrite;
  assert(
    warned.some((w) => /ignores-its-signal/.test(w) && /abort/.test(w) && /discarded/.test(w)),
    `a backend that settles after the ABORT won is traced as discarded, the way a post-bound settle is (${JSON.stringify(warned)})`,
  );
  assert(
    !warned.some((w) => /bound/.test(w)),
    `...and it is attributed to the abort, not to the bound, which never fired (${JSON.stringify(warned)})`,
  );
}

console.log(`\nexit ${state.exit}`);
process.exit(state.exit);
