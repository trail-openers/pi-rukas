#!/usr/bin/env bun
/**
 * #612 S4 task-b — the attention gate's issue-view is now forge-aware.
 *
 * Pre-migration, `checkAttentionLabel` (work-driver-attention.ts) shelled
 * out to `gh issue view <N> --json labels` via a module-local `execp` and
 * parsed the labels with the pure `parseLabels`. The forge adapter (S2,
 * #610) normalizes the issue-view behind `Forge.issueView`, which returns
 * the labels as `NormalizedLabel[]`.
 *
 * This test drives `checkAttentionLabel` with a fake `Forge` (injected via
 * the new `opts.forge` seam) and asserts:
 *
 *   - A flagged issue (the attention label in the forge's response) is refused.
 *   - An unflagged issue proceeds.
 *   - The forge is called once per issue in the group.
 *   - `--restart` short-circuits before the forge is called.
 *   - A forge that rejects one issue yields `checked: false` (not a crash,
 *     not a silent pass).
 */

import type { Forge } from "../src/forge.ts";
import {
  ATTENTION_LABEL,
  checkAttentionLabel,
} from "../src/work-driver-attention.ts";

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
  responses: Record<number, Array<{ name: string }> | Error>,
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
        title: `Issue ${n}`,
        body: "body",
        state: "OPEN" as const,
        url: `https://github.com/acme/widget/issues/${n}`,
        author: undefined,
        labels: r,
        createdAt: undefined,
        updatedAt: undefined,
      };
    },
  } as unknown as Forge;
  return { forge, calls };
}

// 1. A flagged issue is refused.
{
  const { forge, calls } = mkFakeForge({
    10: [{ name: "bug" }, { name: ATTENTION_LABEL }],
  });
  const v = await checkAttentionLabel("/repo", 10, { forge });
  assert(v.refuse, "a flagged issue is refused");
  assert(v.checked, "the check is recorded as having run");
  assert(calls.length === 1, "the forge was called once");
}

// 2. An unflagged issue proceeds.
{
  const { forge } = mkFakeForge({
    10: [{ name: "bug" }],
  });
  const v = await checkAttentionLabel("/repo", 10, { forge });
  assert(!v.refuse, "an unflagged issue proceeds");
  assert(v.checked, "...and the check is recorded");
}

// 3. A label that merely contains the name does not trigger it.
{
  const { forge } = mkFakeForge({
    10: [{ name: "needs-human-attention-followup" }],
  });
  const v = await checkAttentionLabel("/repo", 10, { forge });
  assert(!v.refuse, "a label that merely contains the name does not trigger it (exact match)");
}

// 4. --restart short-circuits before the forge is called.
{
  const { forge, calls } = mkFakeForge({
    10: [{ name: ATTENTION_LABEL }],
  });
  const v = await checkAttentionLabel("/repo", 10, { forge, restart: true });
  assert(!v.refuse, "--restart overrides a flagged issue");
  assert(calls.length === 0, "the forge is NOT called on --restart (short-circuit)");
}

// 5. A forge that rejects one issue in a group yields checked: false.
{
  const { forge } = mkFakeForge({
    10: new Error("gh: issue not found"),
    11: [{ name: "bug" }],
  });
  const v = await checkAttentionLabel("/repo", 10, { forge, issues: [10, 11] });
  assert(!v.refuse, "a rejected issue does not refuse (it cannot be read)");
  assert(!v.checked, "but the check is recorded as NOT having fully run (checked: false)");
}

// 6. EVERY issue in the group is checked, not just the primary.
{
  const { forge, calls } = mkFakeForge({
    10: [{ name: "bug" }],
    11: [{ name: ATTENTION_LABEL }],
  });
  const v = await checkAttentionLabel("/repo", 10, { forge, issues: [10, 11] });
  assert(v.refuse, "a non-primary issue's label is judged the same as a primary's");
  assert(calls.length === 2, "the forge is called for every issue in the group");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
