#!/usr/bin/env bun
/**
 * #612 S4 task-b — the /work entry path's issue-body fetch is now forge-aware.
 *
 * Pre-migration, `fetchIssueBodies` (work-entry.ts) shelled out to
 * `gh issue view <N> --json title,body,labels` with a module-local `execp`
 * and no injection seam. The grouping rules read the body for link markers,
 * file paths and subsystem tags; an issue whose fetch fails gets an empty
 * body, which drops it to R5 (its own group) rather than removing it from
 * grouping entirely.
 *
 * The forge adapter (S2, #610) normalizes the `gh` call behind a single
 * `Forge` interface. This test drives the forge path with a fake `Forge`
 * (no exec, no network) and asserts:
 *
 *   - The body shape is `title: <title>\n<body>` (the grouping rules' contract).
 *   - A forge that rejects one issue yields an empty body for that issue (R5
 *     drop), not a crash.
 *   - The forge is called once per issue, in order.
 *   - The raw-gh fallback path (no forge) still works (pre-migration shape).
 */

import type { Forge } from "../src/forge.ts";
import { fetchIssueBodies } from "../src/work-entry.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** A fake Forge with a programmable issueView. */
function mkFakeForge(
  responses: Record<number, { title: string; body: string } | Error>,
): { forge: Forge; calls: number[] } {
  const calls: number[] = [];
  const forge = {
    forge: "github" as const,
    host: "github.com",
    owner: "acme",
    repo: "widget",
    cwd: "/repo",
    issueView: async (n: number) => {
      calls.push(n);
      const r = responses[n];
      if (r instanceof Error) throw r;
      if (!r) throw new Error(`unexpected issue view ${n}`);
      return {
        number: n,
        title: r.title,
        body: r.body,
        state: "OPEN" as const,
        url: `https://github.com/acme/widget/issues/${n}`,
        author: undefined,
        labels: [],
        createdAt: undefined,
        updatedAt: undefined,
      };
    },
  } as unknown as Forge;
  return { forge, calls };
}

// 1. The body shape is the grouping rules' contract: `title: <title>\n<body>`.
{
  const { forge, calls } = mkFakeForge({
    10: { title: "A feature", body: "some body text\nwith a split marker" },
    11: { title: "Another", body: "body2" },
  });
  const bodies = await fetchIssueBodies("/repo", [10, 11], forge);
  assert(
    bodies[10] === "title: A feature\nsome body text\nwith a split marker",
    "the body shape is `title: <title>\\n<body>` (the grouping rules' contract)",
  );
  assert(bodies[11] === "title: Another\nbody2", "...and works for multiple issues");
  assert(
    JSON.stringify(calls) === JSON.stringify([10, 11]),
    "the forge is called once per issue, in order",
  );
}

// 2. A forge that rejects one issue yields an empty body for that issue (R5 drop).
{
  const { forge } = mkFakeForge({
    10: new Error("gh: issue not found"),
    11: { title: "OK", body: "fine" },
  });
  const bodies = await fetchIssueBodies("/repo", [10, 11], forge);
  assert(bodies[10] === "", "a rejected issue yields an empty body (R5 drop)");
  assert(bodies[11] === "title: OK\nfine", "...and the other issue is unaffected");
}

// 3. An issue whose forge returns an empty title/body yields the expected shape.
{
  const { forge } = mkFakeForge({
    5: { title: "", body: "" },
  });
  const bodies = await fetchIssueBodies("/repo", [5], forge);
  assert(bodies[5] === "title: \n", "empty title+body yields `title: \\n` (R5-safe)");
}

// 4. An empty issues list yields an empty body map.
{
  const { forge } = mkFakeForge({});
  const bodies = await fetchIssueBodies("/repo", [], forge);
  assert(Object.keys(bodies).length === 0, "an empty issues list yields an empty body map");
}

// 5. The raw-gh fallback (no forge) — pre-migration shape.
//
// We cannot drive the raw-gh path without a real `gh` binary or a
// repo-level exec injection (the module uses its own `execp`). The
// fallback path is exercised indirectly by the existing smoke tests
// that run `fetchIssueBodies` in a real repo context. Here we only
// assert that the function does NOT throw when no forge is passed and
// the issues list is empty (no exec is needed for zero issues).
{
  const bodies = await fetchIssueBodies("/nonexistent-repo", []);
  assert(Object.keys(bodies).length === 0, "no forge + no issues: no exec, empty map");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
