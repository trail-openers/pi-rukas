#!/usr/bin/env bun
/**
 * A non-Error throw must not lose the filing detail (PR #635 lens LOW).
 *
 * `const msg = (err as Error).message` is `undefined` when a non-Error is
 * thrown, so the `detail` D7 added specifically so operators see WHY filing
 * failed is silently empty — degrading exactly the path the PR hardened.
 * The fix uses `err instanceof Error ? err.message : String(err)` for both
 * the trace and the detail.
 */

import { fileIssue } from "../src/plan-filing.ts";
import type { Forge } from "../src/forge.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function throwingForge(throwable: unknown): Forge {
  return {
    issueCreate: () => Promise.reject(throwable),
  } as unknown as Forge;
}

{
  // A non-Error throw (a plain string, as CLIs and JSON parsers actually throw).
  const r = await fileIssue("title", "body", () =>
    Promise.resolve(throwingForge("gh: HTTP 403 (rate limit)")),
  );
  assert(r.url === undefined, "non-Error throw: no url");
  assert(
    r.failure?.reason === "create-error",
    `non-Error throw: reason is create-error (got ${String(r.failure?.reason)})`,
  );
  assert(
    r.failure?.detail?.includes("rate limit") === true,
    `non-Error throw: detail carries the thrown string (got ${JSON.stringify(r.failure?.detail)})`,
  );
}

{
  // A real Error still works (no regression).
  const r = await fileIssue("title", "body", () =>
    Promise.resolve(throwingForge(new Error("gh: auth expired"))),
  );
  assert(
    r.failure?.detail?.includes("auth expired") === true,
    `Error throw: detail carries the Error.message (got ${JSON.stringify(r.failure?.detail)})`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
