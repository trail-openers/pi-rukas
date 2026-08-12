#!/usr/bin/env bun
/**
 * The driver must read the signal it writes.
 *
 * `needs-human-attention` has ten references in the source and all ten APPLY
 * it. Nothing ever read it back, so `/work N` on a handed-off issue restarted
 * the whole pipeline against an unchanged issue body, hit the same review cap,
 * and produced the same handoff — while the human the label was addressed to
 * was never consulted.
 *
 * The incident: a PM noticed by hand, killed the cycle, could not restart it,
 * and reimplemented the driver manually — no state file, no queue, no handoff,
 * no review-cap timer, and a branch the driver knew nothing about.
 */

import { ATTENTION_LABEL, judgeAttention, parseLabels } from "../src/work-driver-attention.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// --------------------------------------------------------------- the refusal

{
  const v = judgeAttention(664, ["bug", ATTENTION_LABEL, "P1"]);
  assert(
    v.refuse,
    "canary: a flagged issue is refused — before this it ran the full pipeline again",
  );
  assert(v.checked, "...and the check is recorded as having run");
  assert(/--restart/.test(v.message ?? ""), "the message names the override that clears it");
  assert(
    new RegExp(`--remove-label ${ATTENTION_LABEL}`).test(v.message ?? ""),
    "...and the escape hatch for a stale label",
  );
  assert(
    /review cap/.test(v.message ?? ""),
    "...and says WHY it is flagged, so the operator knows what to fix",
  );
}

// ------------------------------------------------------------- not refused

{
  assert(!judgeAttention(664, ["bug", "P1"]).refuse, "an unflagged issue proceeds");
  assert(!judgeAttention(664, []).refuse, "an issue with no labels proceeds");
  assert(
    !judgeAttention(664, [ATTENTION_LABEL], { restart: true }).refuse,
    "--restart overrides: the operator has already answered the question the label asks",
  );
  assert(
    judgeAttention(664, [ATTENTION_LABEL], { restart: true }).checked,
    "...and that is a real answer, not an unchecked one",
  );
  assert(
    !judgeAttention(664, ["needs-human-attention-followup"]).refuse,
    "a label that merely CONTAINS the name does not trigger it — exact match only",
  );
}

// ---------------------------------------------------------- parsing gh output

{
  const real = JSON.stringify({
    labels: [
      { id: "x", name: "bug", color: "d73a4a" },
      { id: "y", name: ATTENTION_LABEL, color: "FFAA00" },
    ],
  });
  assert(
    parseLabels(real).includes(ATTENTION_LABEL),
    "the real `gh issue view --json labels` shape parses",
  );
  assert(parseLabels("").length === 0, "empty output is not a crash");
  assert(parseLabels("not json").length === 0, "garbage is not a crash");
  assert(parseLabels("{}").length === 0, "a response with no labels key is not a crash");
  assert(
    parseLabels(JSON.stringify({ labels: [{ color: "x" }, { name: 7 }] })).length === 0,
    "malformed label entries are dropped, not coerced",
  );
}

// -------------------------------------------- an unreadable answer is disclosed

{
  // The gate must not silently approve when it cannot see. It also must not
  // refuse — every later step needs `gh` anyway, and a `gh` that cannot answer
  // here fails the branch step minutes later with a clearer error. So the
  // contract is: proceed, but report `checked: false`.
  //
  // `judgeAttention` with an empty label list is indistinguishable from "no
  // labels", which is why the unreadable case is signalled by the field rather
  // than by an empty list — asserted here so the distinction cannot be lost.
  const noLabels = judgeAttention(664, []);
  assert(
    noLabels.checked && !noLabels.refuse,
    "'no labels' is a CHECKED pass, distinct from an unreadable one",
  );
}

// ------------------------------ every issue in the group, not just the primary

{
  // `claimCycle(ctx.issue, ctx.issues)` keys the in-process registry on every
  // issue in the group. This check was written on the adjacent line in the same
  // PR and keyed on the primary alone, so a grouped cycle for #10+#11 where
  // #11 carried the label started anyway — the exact case the label exists to
  // stop, surviving in the grouped path.
  //
  // `judgeAttention` is per-issue by construction; what follows asserts the
  // contract the caller must honour, so a future refactor cannot quietly drop
  // the group again.
  const flagged = judgeAttention(11, [ATTENTION_LABEL]);
  assert(flagged.refuse, "a non-primary issue's label is judged the same as a primary's");
  assert(
    (flagged.message ?? "").includes("#11"),
    "canary: the refusal names the issue that is actually flagged (#11), not the cycle's primary",
  );
  assert(
    (flagged.message ?? "").includes("/work 11 --restart"),
    "...and the recovery command targets that issue",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
