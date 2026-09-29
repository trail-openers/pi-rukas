#!/usr/bin/env bun
/**
 * #835 regression guard on the #834 plain-row surface (extracted from
 * test-dispatch-deck.ts into its own file when the parent hit the 500-line
 * file limit). The section is moved VERBATIM — imports and the shared
 * `makeState` / `fakeTheme` fixtures duplicated here.
 *
 * Two same-role jobs whose keys share a prefix (the realistic newJobId
 * shape — a shared base-36 timestamp prefix) can render byte-identical
 * formatRow lines from spawn until the first updateEntry. buildAgentListLines
 * appends the collision-aware key fragment to the colliding rows so the
 * rendered rows stay distinct for their whole lifetime; the composite renders
 * them with the same fragment.
 */

import { Container, Text } from "@earendil-works/pi-tui";
import { buildCompositeFactory } from "../src/dispatch-deck-composite.ts";
import { type DeckEntry, formatRow } from "../src/dispatch-deck.ts";
import { type RunningState, emptyRunningState } from "../src/progress.ts";
import { buildAgentListLines, MAIN_ROW_KEY } from "../src/agent-list.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function makeState(role: string, opts: Partial<RunningState> = {}): RunningState {
  const base = emptyRunningState(role);
  return { ...base, ...opts, usage: { ...base.usage, ...(opts.usage ?? {}) } };
}

const fakeTheme = {
  fg: (_c: string, t: string) => t,
  bg: (_c: string, t: string) => t,
};

// 14. #835 regression guard on the #834 plain-row surface: two same-role
//jobs whose keys share a prefix (the realistic newJobId shape — a shared
// base-36 timestamp prefix) can render byte-identical formatRow lines from
// spawn until the first updateEntry. buildAgentListLines appends the
// collision-aware key fragment to the colliding rows so the rendered rows
// stay distinct for their whole lifetime; the composite renders them with
// the same fragment.
{
  const now = 4_500_000;
  const keys = ["aaaaaaaaaaa1", "aaaaaaaaaaa2"];
  const entries: DeckEntry[] = keys.map((key, i) => ({
    key,
    label: "developer",
    seq: i,
    startedAt: now - 134_000,
    state: makeState("developer", { lastEventAt: now - 1000 }),
  }));
  // Precondition: without the fragment the rows are byte-identical (the
  // bug the fragment fixes) — same label, same role, same-second elapsed.
  assert(formatRow(entries[0]!, now) === formatRow(entries[1]!, now), "14a: bare formatRow rows are identical (the #835 class)");

  // #914 — buildAgentListLines is the live projection; the fragment is
  // appended only to rows that would otherwise be byte-identical.
  const agentLines = buildAgentListLines(entries, [], 200, now);
  // Skip the leading main row.
  const jobLines = agentLines.slice(1);
  assert(jobLines.length === 2, "14b-pre: 2 job rows after the main row");
  assert(jobLines[0]?.text !== jobLines[1]?.text, `14b: buildAgentListLines rows distinct (${jobLines[0]?.text} vs ${jobLines[1]?.text})`);
  assert(
    (jobLines[0]?.text ?? "").endsWith(" · ") === false &&
      (jobLines[0]?.text ?? "").includes(" · key aaaaaaaa") &&
      (jobLines[1]?.text ?? "").includes(" · key aaaaaaaa"),
    "14c: fragment is the row suffix, prefixed `key `, preserves the shared 10-char prefix",
  );
  // The composite factory renders the same distinct rows (the production
  // surface the operator sees), with the `>` marker position-only.
  // #914 — the agent-list projection (main + job rows) adds the leading
  // main row, so the count is +1 and the indices shift by one.
  const factory = buildCompositeFactory(
    () => [],
    () => ({ running: entries, selectedKey: keys[0], showHint: false }),
    () => agentLines,
    20,
  );
  const comp = factory(null, fakeTheme);
  if (comp instanceof Container) {
    const rendered = comp.children.map((c) => (c as Text).text);
    assert(
      rendered.length === 4,
      "14d: main + 2 job rows + 1 blank separator (no hint: roster mode active, #914)",
    );
    assert(
      rendered[1]?.startsWith("> ") && !rendered[2]?.startsWith("> "),
      "14e: '>' marker on the selected row only",
    );
    assert(
      rendered[1] !== rendered[2] && rendered[1]?.slice(2) !== rendered[2]?.slice(2),
      "14f: composite renders distinct rows (fragment survives the '> ' prefix)",
    );
  }

  // 14g. Three keys sharing the first 13 chars → three pairwise-distinct
  // fragments, all starting with the shared prefix.
  const adv = ["abcdefghijklm1x", "abcdefghijklm2x", "abcdefghijklm3x"];
  const advEntries: DeckEntry[] = adv.map((key, i) => ({
    key,
    label: "developer",
    seq: i,
    startedAt: now - 134_000,
    state: makeState("developer", { lastEventAt: now - 1000 }),
  }));
  const advLines = buildAgentListLines(advEntries, [], 200, now);
  const advFragments = advLines.slice(1).map((r) => r.text.split(" · ").pop() ?? "");
  assert(
    new Set(advFragments).size === 3 &&
      advFragments.every((f) => f.startsWith("key abcdefghij")),
    `14g: 3 keys sharing 13 chars → pairwise-distinct key-fragments (${advFragments.join(" | ")})`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
