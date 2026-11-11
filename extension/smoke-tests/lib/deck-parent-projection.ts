/**
 * lib/deck-parent-projection — the byte-identity half of the #2188 ticket A
 * gate, factored out of test-dispatch-deck-parent.ts so that gate stays under
 * the AGENTS.md §12 / test-file-size-limit.ts 500-line cap (the leaf-module
 * precedent: agent-list-keys.ts, dispatch-deck-quiet.ts, dispatch-deck-rows.ts).
 *
 * The parent link is DECK-ONLY: it says which job dispatched a row, and no
 * rendered surface reads it. `dispatch-peek.ts`'s serialise() picks its fields
 * explicitly and agent-list.ts's row builder reads key/label/state/startedAt
 * via formatAgentRow — so a row that differs from its twin ONLY by parentKey
 * must project byte-for-byte identically. That is asserted here rather than
 * argued, because the acceptance criterion IS byte-identity.
 *
 * How each check is falsified by a deliberate mutant — the deck rows here are
 * REAL `startEntry` rows, so every mutation below is observed red, not argued
 * green:
 *   - `startEntry` stops copying `opts.parentKey`      → the `startEntry copies`
 *     assertions, and every linked row loses the link
 *   - `startEntry` copies it CONDITIONALLY — a gate on the row's key length,
 *     its role, or whether it/any row carries a batchKey, so long as it keeps
 *     copying on a short-key `explore` batch-free row → the planted rows below
 *     that are NOT that shape: the real-shaped-id twin, the `developer` twin
 *     and the batch-member twin each fail such a copy and are read back off the
 *     deck
 *   - `agent-list.ts` renders `e.parentKey`            → `buildAgentListLines`
 *     twin equality AND the "never prints" assertion
 *   - `dispatch-peek.ts` reads `e.parentKey` anywhere
 *     in its header projection                         → the tool-driven peek
 *     text comparisons below
 *   - `dispatch-peek.ts`'s `serialise()` spreads the
 *     row instead of picking fields                    → the peek `details`
 *     JSON comparison below (the interface alone does NOT fence a spread: a
 *     `{ ...e }` satisfies it structurally, so `tsc` stays silent)
 *   - any projection that DROPS a row instead of leaking it → the row COUNTS
 *     asserted on each surface, and the "every planted row is projected" check
 *
 * The population matters as much as the mechanism. A check over rows that all
 * share one key shape, one label and one role is falsified only by a leak that
 * happens to fire on that shape: a leak written `if (e.parentKey &&
 * e.key.length >= 14)` or `if (e.parentKey && role !== "explore")` passes a
 * fixture of short-key `explore` rows while leaking every REAL row, since real
 * job ids are `<base36 ms>-<6 chars>` (`newJobId`) and real children run as
 * `developer`, `ops` and friends. So the planted twins below span two key
 * shapes, two roles and both batch states, and the parent-link sentinel appears
 * in no field the projection is allowed to print — see `parentSentinel()`.
 *
 * The peek assertions are driven through the REGISTERED `dispatch_peek` tool,
 * not through `renderPeek` directly: `renderPeek`/`renderHeader` destructure
 * `{ state, label, key }` and read no other field, so a twin-pair comparison
 * of their output holds for ANY input and would be an assertion true by
 * construction. The tool is the surface that actually serialises a row, and
 * the twins are planted as REAL deck rows so the tool reads them itself.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildAgentListLines } from "../../src/agent-list.ts";
import type { DeckEntry } from "../../src/dispatch-deck-types.ts";
import * as dispatchDeck from "../../src/dispatch-deck.ts";
import { registerDispatchPeekTool } from "../../src/dispatch-peek.ts";

/** The minimum surface `registerDispatchPeekTool` touches. */
interface PeekTool {
  name: string;
  execute: (
    id: string,
    raw: unknown,
  ) => Promise<{ content: { type: string; text: string }[]; details: unknown }>;
}

/** The shape of `dispatch_peek`'s `details`, narrowed to what is compared. */
type PeekDetails = { entries?: { key?: string }[] };

/** Register the real peek tool and return it, so the assertions below run the
 *  same projection an operator sees via `dispatch_peek`. */
function peekTool(): PeekTool {
  const registered: PeekTool[] = [];
  registerDispatchPeekTool({
    registerTool: (t: PeekTool) => registered.push(t),
  } as unknown as ExtensionAPI);
  const tool = registered.find((t) => t.name === "dispatch_peek");
  if (!tool) throw new Error("dispatch_peek was not registered");
  return tool;
}

/** One row twin: identical to its partner in every rendered field, differing
 *  only in the parent link. Built from rows the deck itself created, so `state`
 *  and `startedAt` are the real shapes rather than a hand-rolled fixture.
 *
 *  `role` and `label` are settable because a projection that branches on either
 *  ("only explore rows show the parent") is a real leak shape, and would be
 *  invisible in a fixture where every row is the same role and label. */
function twin(
  base: DeckEntry,
  opts: { key: string; label: string; role?: string; parentKey?: string },
): DeckEntry {
  return {
    ...base,
    key: opts.key,
    label: opts.label,
    ...(opts.role === undefined ? {} : { state: { ...base.state, role: opts.role } }),
    ...(opts.parentKey === undefined ? {} : { parentKey: opts.parentKey }),
  };
}

/** The parent link the twins carry — deliberately NOT derivable from any field
 *  the projection is allowed to print. If it were ("twin" + "-parent"), the
 *  "never renders the link" assertions would be satisfied by the row's own
 *  label and would be asserting nothing. */
function parentSentinel(): string {
  return "the-parent";
}

/** A real-shaped job id, as `async-jobs-registry.ts`'s `newJobId()` mints one:
 *  `<Date.now() base36>-<6 chars>` — ≥14 chars. The short key below keeps the
 *  ≤10-char branch of the #835 key fragment live; this one is the branch every
 *  real row takes. */
const REAL_SHAPED_TWIN_KEY = "lbx2k9qw-abcdef";
const SHORT_TWIN_KEY = "twin-job-key";

/** One planted deck row, with the fields the gate read back off the deck. */
interface Planted {
  key: string;
  label: string;
  role: string;
  batchKey?: string;
  parentKey?: string;
}

/**
 * Run the projection assertions against the live deck module. Returns the
 * failure messages (empty on success) so the caller owns the pass/fail
 * reporting convention.
 *
 * Async because the peek half awaits the registered tool's `execute`.
 */
export async function checkParentLinkStaysUnrendered(): Promise<string[]> {
  const failures: string[] = [];
  const check = (cond: boolean, msg: string): void => {
    if (!cond) failures.push(msg);
  };

  const sentinel = parentSentinel();
  dispatchDeck.reset();
  // A batch is registered and one linked row is a batch MEMBER, so the deck
  // holds a batch while every assertion below runs and one row carries a
  // `batchKey` of its own. Without that, a copy written
  // `parentKey: opts.batchKey ? undefined : opts.parentKey` survives this whole
  // gate — every other row here is batch-free, so the population, not the
  // assertion, is what decides what a mutant can hide behind.
  dispatchDeck.startBatchEntry("proj-batch", { label: "batch label", size: 0 });
  dispatchDeck.startEntry("row-batched", {
    label: "plain",
    role: "explore",
    batchKey: "proj-batch",
    parentKey: sentinel,
  });
  dispatchDeck.startEntry("row-plain", { label: "plain", role: "explore" });
  dispatchDeck.startEntry("row-child", {
    label: "plain",
    role: "explore",
    parentKey: sentinel,
  });
  const snap = dispatchDeck.snapshot();
  check(
    snap.find((e) => e.key === "row-child")?.parentKey === sentinel,
    "startEntry copies opts.parentKey onto the row",
  );
  check(
    snap.find((e) => e.key === "row-batched")?.parentKey === sentinel,
    "startEntry copies opts.parentKey onto a BATCHED row too — a copy gated on `batchKey` (or on the deck holding any batch) is caught here, since every other row in this fixture is batch-free",
  );
  check(
    snap.find((e) => e.key === "row-plain")?.parentKey === undefined,
    "a row started without the option keeps parentKey undefined (an absent link, not a stale one)",
  );

  const NOW = 1_000;

  // Twin shapes: short key / real-shaped job id × `explore` / `developer`, and
  // one linked twin is ALSO a batch member. The role axis is what a role-gated
  // leak or copy hides from (`developer` is a real dispatch role, not a
  // made-up one); the key axis is what a key-length-gated one hides from; the
  // batch axis what a `batchKey`-gated one hides from.
  //
  // Labels, roles and key shapes are all DISTINCT across the set on purpose:
  // the #835 collision-fragment algorithm appends its `· key …` suffix only to
  // rows whose text would otherwise render byte-identical, and rows sharing a
  // label collide — so a shared label lets one twin's fragment appear and its
  // twin's not to, a projection difference with no `parentKey` in it.
  const base = snap.find((e) => e.key === "row-plain") as DeckEntry;
  const twinCases: {
    key: string;
    label: string;
    role?: string;
    batched?: boolean;
  }[] = [
    { key: SHORT_TWIN_KEY, label: "twin-a" },
    { key: REAL_SHAPED_TWIN_KEY, label: "twin-b" },
    { key: `${SHORT_TWIN_KEY}-c`, label: "twin-c", role: "developer" },
    { key: `${REAL_SHAPED_TWIN_KEY}-d`, label: "twin-d", role: "developer", batched: true },
  ];
  const roleOf = (t: { role?: string }): string => t.role ?? "explore";

  // Each twin is planted as a REAL row, in both link states, over both key
  // shapes, both roles and both batch states — the peek tool reads the deck, so
  // planting is the only way to get it to project a linked row whose key is a
  // real-shaped id, whose role is not `explore`, or that belongs to a batch.
  const planted: Planted[] = [];
  for (const t of twinCases) {
    for (const linked of [false, true]) {
      const row: Planted = {
        key: `${t.key}-${linked ? "l" : "p"}`,
        label: t.label,
        role: roleOf(t),
        ...(linked && t.batched ? { batchKey: "proj-batch" } : {}),
        ...(linked ? { parentKey: sentinel } : {}),
      };
      planted.push(row);
      dispatchDeck.startEntry(row.key, {
        label: row.label,
        role: row.role,
        batchKey: row.batchKey,
        parentKey: row.parentKey,
      });
    }
  }

  // The rows read back off the deck — the executed half that catches a
  // CONDITIONAL COPY in `startEntry` (as opposed to a conditional render): a row
  // the caller asked to be linked must actually hold the link, whatever its key
  // shape, role or batch state.
  const plantedSnap = dispatchDeck.snapshot();
  const rowOf = (key: string): DeckEntry | undefined => plantedSnap.find((e) => e.key === key);
  const linkFailures = planted
    .filter((p) => p.parentKey !== undefined)
    .filter(
      (p) =>
        rowOf(p.key)?.parentKey !== sentinel ||
        (p.batchKey !== undefined && rowOf(p.key)?.batchKey !== p.batchKey),
    )
    .map((p) => `${p.key}/${p.role}${p.batchKey ? "/batched" : ""}`);
  check(
    linkFailures.length === 0,
    `startEntry copies parentKey onto EVERY linked row it created — batch member, non-\`explore\` role and real-shaped job id alike (missing: ${linkFailures.join(", ") || "none"})`,
  );

  const deckLines = dispatchDeck.buildLines(NOW);
  // Batch headers + STANDALONE rows only: `buildLines` deliberately excludes
  // batch members (they get their own per-job rows in the composite, and
  // test-dispatch-deck.ts block 8 pins that contract). So 1 batch header +
  // row-batched is excluded + row-plain + row-child + the standalone twins.
  // The count is part of the assertion: a projection that DROPPED a row would
  // otherwise satisfy "no line contains the link" by not rendering the row.
  const standalonePlanted = planted.filter((p) => p.batchKey === undefined).length;
  check(
    deckLines.length === 3 + standalonePlanted && deckLines.every((l) => !l.includes(sentinel)),
    `the parent link is not rendered into any deck row (${JSON.stringify(deckLines)})`,
  );

  // The agent-list half, on the SAME twin population. ONE array, one call:
  // `buildAgentListLines`' #835 collision fragments depend on the whole visible
  // set, so projecting all the twins together is the shape the operator sees —
  // and it keeps a linked row's fragment from being computed against a set its
  // unlinked twin is absent from.
  const listA = buildAgentListLines(
    twinCases.map((t) => twin(base, t)),
    80,
    NOW,
  );
  const listB = buildAgentListLines(
    twinCases.map((t) => twin(base, { ...t, parentKey: sentinel })),
    80,
    NOW,
  );
  check(
    JSON.stringify(listA) === JSON.stringify(listB),
    `buildAgentListLines: projection byte-identical with and without parentKey over every key shape and role (${JSON.stringify([listA, listB])})`,
  );
  // 1 main row + one row per twin, and every twin present. The counts are part
  // of the assertion, for the same reason as the deck-line count above.
  check(
    listB.length === 1 + twinCases.length &&
      listB.every((l) => !l.text.includes(sentinel)) &&
      twinCases.every(
        (t) =>
          listB.filter((l) => l.key === t.key).length ===
          twinCases.filter((x) => x.key === t.key).length,
      ),
    `the agent list never prints the parent link for any twin (${JSON.stringify(listB.map((l) => l.text))})`,
  );

  // The peek half, driven through the registered tool. The tool reads the DECK
  // (deckSnapshot), not a caller-supplied array — which is why the rows above
  // are planted rather than passed in. Both paths are driven: the no-jobId path
  // renders every row (`renderPeek`/`renderHeader`) and puts `all.map(
  // serialise)` into `details`; the jobId path is the one an operator actually
  // calls.
  const tool = peekTool();
  // ONE execute for the pairwise comparison below: `serialise()` stamps
  // elapsedMs/quietMs from the wall clock, so separate calls move those fields
  // between twins and a byte comparison of their `details` would be comparing
  // timings as well as projections.
  const peekAll = await tool.execute("peek-all", {});
  // The all-rows projection must cover the WHOLE live deck — the three fixture
  // rows and every planted twin. Without this, the pairwise comparison below
  // could be satisfied by two ABSENT rows
  // (`strip` on a miss yields an empty string on both sides) and the leak checks
  // by a projection that rendered nothing at all — silence would read as a pass.
  const projectedKeys = new Set(
    ((peekAll.details as PeekDetails).entries ?? []).map((e) => e?.key ?? ""),
  );
  const liveKeys = dispatchDeck.snapshot().map((e) => e.key);
  const missing = liveKeys.filter((k) => !projectedKeys.has(k));
  check(
    missing.length === 0 &&
      projectedKeys.size === liveKeys.length &&
      planted.every((p) => projectedKeys.has(p.key)),
    `dispatch_peek's no-jobId path projects EVERY live row (${missing.length === 0 ? `all ${liveKeys.length}` : missing.join(", ")})`,
  );
  // Every planted row through the single-jobId path, not just one: that path is
  // `renderPeek`/`renderHeader` plus `serialise()` for a lone row, and a leak
  // gated on the row's key shape or role shows up on whichever planted row
  // matches its gate.
  const perRow = await Promise.all(
    planted.map((p) => tool.execute(`peek-${p.key}`, { jobId: p.key })),
  );
  const peekText = JSON.stringify(peekAll.content) + JSON.stringify(perRow.map((r) => r.content));
  check(
    !peekText.includes(sentinel),
    `dispatch_peek's operator-facing text never carries the parent link, for any row (${peekText})`,
  );
  // The twins serialised by the SAME call: their `details` differ only by the
  // key the `strip` below normalises, which is the executed form of
  // "serialise() picks its fields explicitly" — every other member of the
  // projection is byte-equal across the twins. The interface alone does NOT
  // fence a spread: a `{ ...e }` body satisfies SerialisedEntry structurally, so
  // tsc stays silent — hence an executed comparison.
  const strip = (details: PeekDetails, key: string): string =>
    JSON.stringify(details.entries?.find((e) => e?.key === key) ?? "").replaceAll(key, "«key»");
  const pairFailures: string[] = [];
  for (const t of twinCases) {
    const plain = strip(peekAll.details as PeekDetails, `${t.key}-p`);
    const linked = strip(peekAll.details as PeekDetails, `${t.key}-l`);
    // Each side must start with its OWN normalised key: a projection that
    // dropped `key` would make the find miss and compare two absent-row
    // placeholders, which is a pass about nothing.
    if (
      !plain.startsWith('{"key":"«key»"') ||
      !linked.startsWith('{"key":"«key»"') ||
      plain !== linked ||
      linked.includes(sentinel) ||
      linked.includes("parentKey")
    ) {
      pairFailures.push(`${t.key}/${roleOf(t)}: ${plain} vs ${linked}`);
    }
  }
  check(
    pairFailures.length === 0,
    `serialise() projects the same fields with and without parentKey, for every key shape and role (${pairFailures.join(" | ")})`,
  );
  // And every linked row's single-row `details`. Selected off `planted`, not off
  // the JSON, so a projection that dropped a field cannot quietly shrink the
  // population being asserted.
  const linkedDetails = perRow
    .map((r, i) => ({ json: JSON.stringify(r.details), row: planted[i] as Planted }))
    .filter((x) => x.row.parentKey !== undefined);
  check(
    linkedDetails.length === twinCases.length &&
      linkedDetails.every((x) => !x.json.includes(sentinel) && !x.json.includes("parentKey")),
    `dispatch_peek's details for a linked row carry no parent member (${linkedDetails.map((x) => `${x.row.key}=${x.json}`).join(" | ")})`,
  );

  dispatchDeck.reset();
  return failures;
}
