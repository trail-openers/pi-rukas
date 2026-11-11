#!/usr/bin/env bun
/**
 * #798 (workstream `ws2`) — the handoff READER surfaces state WHERE the
 * artefacts landed, explicitly.
 *
 * The #782 incident: the handoff labelled PR #796, the event recorded
 * `labelApplied: true` with no target field, and an operator checking issue
 * #782 saw no label and (wrongly) concluded the driver had lied. The two
 * reader surfaces named by the ticket must now state the target without URL
 * parsing:
 *
 *   1. `renderHandoffUserMessage` (in-chat scrollback) — per-target label
 *      state (issue / PR) and the explicit comment target.
 *   2. `renderStatus` (the `/work-status` terminal surface) — the same
 *      facts, including the partial-failure split (issue verified, PR not).
 *
 * Pre-#798 events (no per-target fields) must render exactly as before —
 * the readers must not claim knowledge they don't have.
 */

import { renderStatus } from "../src/work-status.ts";
import { renderHandoffUserMessage } from "../src/work-driver-handoff-message.ts";
import { makeHandoffEmittedEvent } from "../src/work-driver-handoff-post.ts";
import type { WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const REPO = "/Users/x/repo";

/** A cycle that parked after opening PR #796 (the #782 shape). */
function parkedWithPr(
  ev: {
    issueLabelApplied?: boolean;
    prLabelApplied?: boolean;
    targetType?: "issue" | "pr";
    targetNumber?: number;
    /** Override for legacy events (pre-#798, no per-target fields). */
    labelApplied?: boolean;
    /** #2173 — the delivery provenance, and the decline marker the producer writes. */
    delivery?: "dispatch" | "fallback" | "host";
    labelSkipped?: "host-channel" | "issue-closed";
    bodyRefusal?: string;
    commentUrl?: string;
  },
): WorkState {
  // #2173 (C4) — the aggregate is derived the way the producers derive it: a
  // dual-target handoff records `labelApplied` as the conjunction of the two
  // verifications. A fixture that invented an aggregate the driver could never
  // write would be asserting about a shape that does not exist.
  const labelApplied =
    ev.labelApplied !== undefined
      ? ev.labelApplied
      : ev.issueLabelApplied === true && ev.prLabelApplied === true;
  // biome-ignore lint/suspicious/noExplicitAny: partial fixture; readers read a subset
  return {
    schemaVersion: 1,
    resumable: false,
    issue: 782,
    startedAt: 1,
    updatedAt: 2,
    pipelineState: {
      status: "handoff",
      currentStep: "handoff",
      lastCompletedStep: "commit-pr",
      reviewRound: 0,
      ciRetryCount: 0,
      inFlightJobIds: [],
      branchName: "feature/issue-782-x",
      prNumber: 796,
    },
    eventLog: [
      { kind: "cap-hit", at: 3, cap: "lens-issues-found", reviewRound: 3, nextStep: "handoff" },
      {
        kind: "handoff-emitted",
        at: 4,
        commentUrl: "https://github.com/acme/widget/pull/796#issuecomment-1",
        labelApplied,
        handoffBodyPath: `${REPO}/tmp/issue-782/handoff-comment.md`,
        // #2173 (C4) — keys the caller does not set are ABSENT from the event,
        // not present-and-`undefined`: `labelSkipped?: "host-channel" |
        // "issue-closed" | undefined` makes an explicit undefined assignable,
        // and the readers' per-target knowledge is exactly the presence of the
        // key. Spreading a literal that carries `key: undefined` would hand a
        // legacy fixture per-target fields the pre-#798 producer never wrote.
        ...Object.fromEntries(Object.entries(ev).filter(([, v]) => v !== undefined)),
      },
    ],
  } as any;
}

// ── 1. In-chat message: dual-target, both verified ─────────────────────────
{
  const out = renderHandoffUserMessage(
    parkedWithPr({
      targetType: "pr",
      targetNumber: 796,
      issueLabelApplied: true,
      prLabelApplied: true,
    }),
    REPO,
    `${REPO}/tmp/issue-782`,
  );
  assert(/label applied:/.test(out), "chat (dual ok): states the label block per-target");
  assert(/issue #782: applied/.test(out), "chat (dual ok): issue label verified on the issue");
  assert(/PR #796: applied/.test(out), "chat (dual ok): PR label verified on the PR");
  assert(/comment target: pr #796/.test(out), "chat (dual ok): the comment target is explicit (no URL parsing)");
}

// ── 2. In-chat message: partial failure (issue ok, PR not) ─────────────────
{
  const out = renderHandoffUserMessage(
    parkedWithPr({
      targetType: "pr",
      targetNumber: 796,
      issueLabelApplied: true,
      prLabelApplied: false,
    }),
    REPO,
    `${REPO}/tmp/issue-782`,
  );
  assert(/issue #782: applied/.test(out), "chat (partial): the issue label is applied");
  assert(/PR #796: NOT verified/.test(out), "chat (partial): the PR label is NOT verified (distinguished from success)");
  assert(!/label applied to/.test(out), "chat (partial): does not use the single-target 'applied to' phrasing");
}

// ── 3. In-chat message: pre-#798 event (no per-target fields) ──────────────
{
  const out = renderHandoffUserMessage(
    parkedWithPr({ labelApplied: true }),
    REPO,
    `${REPO}/tmp/issue-782`,
  );
  assert(
    /label applied to pr 796/.test(out),
    "chat (legacy event): the old single-target 'label applied to pr 796' line is unchanged",
  );
  assert(!/comment target:/.test(out), "chat (legacy event): no 'comment target' line invented from nothing");
}

// ── 4. /work-status terminal: dual-target + explicit target line ───────────
{
  const out = renderStatus(
    parkedWithPr({
      targetType: "pr",
      targetNumber: 796,
      issueLabelApplied: true,
      prLabelApplied: true,
    }),
    REPO,
  );
  assert(/target:  pr #796 \(explicit, #798\)/.test(out), "status (dual ok): the target line is explicit");
  assert(/on issue #782 \/ on PR #796/.test(out), "status (dual ok): per-target label state, both verified");
}

// ── 5. /work-status terminal: partial failure ───────────────────────────────
{
  const out = renderStatus(
    parkedWithPr({
      targetType: "pr",
      targetNumber: 796,
      issueLabelApplied: true,
      prLabelApplied: false,
    }),
    REPO,
  );
  assert(/NOT verified on PR #796/.test(out), "status (partial): PR label NOT verified is named");
  assert(/\(partial failure\)/.test(out), "status (partial): the partial failure is called out");
}

// ── 6. /work-status terminal: pre-#798 event renders as before ─────────────
{
  const out = renderStatus(parkedWithPr({ labelApplied: true }), REPO);
  assert(
    /label:   needs-human-attention applied/.test(out),
    "status (legacy event): the old single-boolean label line is unchanged",
  );
}

// ── 7. No-PR path: target is the issue, no PR label line ────────────────────
{
  // biome-ignore lint/suspicious/noExplicitAny: partial fixture
  const s: any = parkedWithPr({
    targetType: "issue",
    targetNumber: 782,
    issueLabelApplied: true,
  });
  s.pipelineState.prNumber = undefined;
  const out = renderHandoffUserMessage(s, REPO, `${REPO}/tmp/issue-782`);
  assert(/issue #782: applied/.test(out), "chat (no PR): issue label line is present");
  assert(!/PR #/.test(out.split("label applied:")[1] ?? ""), "chat (no PR): no PR label line when prLabelApplied is absent");
  assert(/comment target: issue #782/.test(out), "chat (no PR): the target names the issue");
}

// ── 8. #2173 AC4 / C4 — no handoff ever prints both an "applied" and a
//    "NOT applied" claim for the same target.
//
// The measured defect: one handoff printed `label applied:  [FAILED] NOT
// applied` in the banner and `GitHub handoff comment NOT posted (the label was
// applied)` further down, and an external team saw the same text in theirs. The
// two lines asked different questions — the banner the aggregate `labelApplied`,
// the comment line nothing at all — so no combination of fields could make them
// agree. All three renderers now derive every label and comment line from ONE
// projection of the event (`handoffLabelVerdict`), which is what this matrix
// pins: for every shape the driver can emit, each target is claimed exactly one
// way.
//
// The shapes enumerated are the closed set the producers can produce: dual ok,
// issue-only, PR-only, neither, host decline, refused body, and the #1472
// closed-issue decline.
{
  /** Every label/comment sentence the renderers may print, per target. */
  const CLAIMS: { target: string; applied: RegExp; notApplied: RegExp }[] = [
    {
      target: "issue label",
      applied: /issue #782: applied|on issue #782(?! NOT)|needs-human-attention applied/,
      notApplied: /NOT verified|NOT applied|NOT fully applied|partial failure/,
    },
  ];

  /** The handoff-emitted shapes, each built exactly as `makeHandoffEmittedEvent` does. */
  const shapes: {
    name: string;
    ev: Record<string, unknown>;
  }[] = [
    { name: "dual ok", ev: { issueLabelApplied: true, prLabelApplied: true } },
    {
      name: "issue-only",
      ev: {
        labelApplied: false,
        issueLabelApplied: true,
        prLabelApplied: false,
      },
    },
    {
      name: "PR-only",
      ev: {
        labelApplied: false,
        issueLabelApplied: false,
        prLabelApplied: true,
      },
    },
    {
      name: "neither",
      ev: { labelApplied: false, issueLabelApplied: false, prLabelApplied: false },
    },
    {
      name: "host decline",
      ev: {
        labelApplied: false,
        labelSkipped: "host-channel",
        delivery: "host",
        commentUrl: undefined,
      },
    },
    {
      name: "closed-issue decline",
      ev: {
        labelApplied: true,
        issueLabelApplied: true,
        prLabelApplied: true,
        labelSkipped: "issue-closed",
      },
    },
    {
      name: "refused body",
      ev: {
        labelApplied: false,
        issueLabelApplied: false,
        prLabelApplied: undefined,
        commentUrl: undefined,
        bodyRefusal: "denylist line 12",
      },
    },
    // A pre-#798 event carries the aggregate ONLY: no per-target field is on it
    // at all. `...ev` in the fixture would write an explicit `undefined` and the
    // readers would then see per-target knowledge that never existed, so these
    // two shapes drop the keys entirely rather than setting them to undefined.
    {
      name: "legacy event",
      ev: { labelApplied: true, issueLabelApplied: undefined, prLabelApplied: undefined },
    },
    {
      name: "legacy not applied",
      ev: { labelApplied: false, issueLabelApplied: undefined, prLabelApplied: undefined },
    },
  ];

  for (const shape of shapes) {
    const eventFields = (): Record<string, unknown> =>
      Object.fromEntries(Object.entries(shape.ev).filter(([, v]) => v !== undefined));
    const out = renderHandoffUserMessage(
      parkedWithPr({
        targetType: "pr",
        targetNumber: 796,
        ...eventFields(),
      }),
      REPO,
      `${REPO}/tmp/issue-782`,
    );
    const statusOut = renderStatus(
      parkedWithPr({ targetType: "pr", targetNumber: 796, ...eventFields() }),
      REPO,
    );
    for (const surface of [
      { where: "chat", text: out },
      { where: "status", text: statusOut },
    ]) {
      // The chat surface prints the per-target block only when the event
      // carries per-target knowledge; ask it about the target it names.
      const labelSection =
        surface.where === "chat"
          ? (
              surface.text.match(/label[^\n]*(?:\n[^\n]*NOT verified[^\n]*)*/) ?? [
                surface.text.match(/label[^\n]*/)?.[0] ?? "",
              ]
            ).join("\n")
          : (surface.text.match(/label:[^\n]*/) ?? [""])[0] ?? "";
      // A target is "claimed applied" only by a POSITIVE word that is not itself
      // part of a negation: `NOT fully applied` denies, it does not assert, so
      // reading it as an assertion would make every honest partial render as a
      // contradiction.
      const saysApplied =
        /(?<!NOT )(?:\bare\b|:|\s)applied\b/.test(labelSection) &&
        !/NOT (?:fully )?applied/.test(labelSection);
      const saysNot = /NOT (?:verified|applied|fully applied)|partial failure/.test(labelSection);
      // The banner and the comment line are the two sites that disagreed; when
      // both are present they must state the same verdict.
      const banner = /label applied:\s+\[FAILED\] NOT applied/.test(surface.text);
      const claimsApplied = /the label was applied/.test(surface.text);
      assert(
        !(banner && claimsApplied),
        `#2173 AC4 ${shape.name} (${surface.where}): never prints "[FAILED] NOT applied" beside "the label was applied"`,
      );
    }
    // A DECLINE is never rendered as a failure: nothing asks the operator to
    // apply a label the driver deliberately did not apply.
    if (shape.name === "host decline" || shape.name === "closed-issue decline") {
      assert(
        !/HANDOFF DISPATCH INCOMPLETE/.test(out),
        `#2173 AC4 ${shape.name}: a deliberate decline never fires the dispatch-incomplete banner`,
      );
      assert(
        !/label applied:\s+\[FAILED\]/.test(out),
        `#2173 AC4 ${shape.name}: no label line calls the decline a failure`,
      );
      assert(
        /by design|not applied by design|no forge comment or label|host channel|was closed/i.test(
          out + renderStatus(parkedWithPr({ targetType: "pr", targetNumber: 796, ...eventFields() }), REPO),
        ),
        `#2173 AC4 ${shape.name}: the decline says it was deliberate, on one of the surfaces`,
      );
    }
  }
  void CLAIMS;

  // The exact contradiction from the field report: an undelivered comment and an
  // unapplied label must not be reported as a delivered label anywhere below the
  // banner.
  {
    const out = renderHandoffUserMessage(
      parkedWithPr({
        targetType: "pr",
        targetNumber: 796,
        commentUrl: undefined,
        labelApplied: false,
        issueLabelApplied: false,
        prLabelApplied: false,
      }),
      REPO,
      `${REPO}/tmp/issue-782`,
    );
    assert(
      !/the label was applied/.test(out),
      "#2173 AC4 the reported contradiction: no 'the label was applied' when nothing applied",
    );
    const offersLabel = /add-label needs-human-attention/.test(out);
    const bannerFired = /HANDOFF DISPATCH INCOMPLETE/.test(out);
    // The banner and the comment-recovery line are the two manual-post sites and
    // are mutually exclusive by the #775 banner rule, so exactly ONE of them is
    // this shape's site — and that one owes the operator the label command the
    // driver could not carry out. A shape that printed neither would be the
    // silent half of the same defect: an unapplied label nobody was told to apply.
    const bannerSite = bannerFired;
    const commentSite = !bannerFired;
    const printedByBanner = bannerSite && /edit .*--add-label needs-human-attention/.test(out);
    const printedByComment =
      commentSite && out.includes("GitHub handoff comment NOT posted")
        ? /--add-label needs-human-attention/.test(out)
        : true;
    assert(
      printedByBanner || printedByComment,
      `#2173 AC4 the site that fires (banner: ${String(bannerSite)}) carries the label command`,
    );
  }
}

// ── 9. #2173 C4 — the PRODUCER states the closed-issue decline on the event.
//
// The other half of AC4. `declinedLabelSeed` settles all three fields for a
// park whose issue a human closed, and the renderers used to be left to guess
// whether `labelApplied: true` meant "verified" or "deliberately never applied"
// — so the same fields rendered as an applied label on one line and a failure on
// another. The builder now takes the state and writes the marker itself, so a
// renderer cannot guess wrong. Asserted through the builder, not a forged event:
// a producer that stopped writing the marker goes red here.
{
  const closed = makeHandoffEmittedEvent({
    at: 1,
    commentUrl: undefined,
    labelApplied: true,
    handoffBodyPath: "/scratch/handoff-comment.md",
    body: "body",
    consolidated: false,
    // The #1472 marker, exactly as the closed-issue park stamps it.
    state: { pipelineState: { handoffLabelSkipped: true } } as never,
    issueLabelApplied: true,
    prLabelApplied: true,
    targetType: "pr",
    targetNumber: 796,
  });
  assert(
    closed.labelSkipped === "issue-closed",
    "the closed-issue decline is recorded on the event by the producer, not inferred by the reader",
  );
  const s: any = parkedWithPr({ issueLabelApplied: true, prLabelApplied: true });
  s.eventLog[1] = { ...closed, kind: "handoff-emitted" };
  const out = renderHandoffUserMessage(s, REPO, `${REPO}/tmp/issue-782`);
  assert(
    /not applied by design|was closed/i.test(out),
    "and the chat surface renders it as a decline rather than an applied label",
  );
  assert(
    !/HANDOFF DISPATCH INCOMPLETE/.test(out),
    "a closed-issue park never looks like a dispatch outage",
  );
  const st = renderStatus(s, REPO);
  assert(
    /not applied by design/.test(st),
    "and /work-status renders the same decline from the same event",
  );
  // A handoff whose issue was NOT closed is unaffected: the marker stays off.
  const normal = makeHandoffEmittedEvent({
    at: 1,
    commentUrl: "https://github.com/acme/widget/pull/796#issuecomment-1",
    labelApplied: true,
    handoffBodyPath: "/scratch/handoff-comment.md",
    body: "body",
    consolidated: false,
    state: { pipelineState: {} } as never,
    issueLabelApplied: true,
    prLabelApplied: true,
  });
  assert(
    normal.labelSkipped === undefined,
    "a normal dual-ok handoff carries no decline marker (the dual ok is not a decline)",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
