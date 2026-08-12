#!/usr/bin/env bun
/**
 * The gate must mean what its own prompt says.
 *
 * `agents-base/adversarial-developer.md:81-93` defines four verdicts and calls
 * two of them non-blocking:
 *
 *     ISSUES_FOUND       — "Should address, not blocking"
 *     MINOR_OBSERVATIONS — "Non-blocking, author's discretion"
 *
 * `adversarial.ts` knew three of them and exited only on APPROVED, so the
 * verdict its own doctrine calls *not blocking* halted the cycle, and
 * MINOR_OBSERVATIONS — absent from the enum — failed to parse, fell through to
 * the ISSUES_FOUND default, and was punished as a malfunction.
 *
 * Measured over 253 loops recovered from the durable session store: 49 ended
 * REJECTED, and **41 of those 49 (83.7%) ended on ISSUES_FOUND**. Only 8 ended
 * on CRITICAL. A loop still alive at round 3 was roughly 2:1 to be rejected.
 *
 * lantern #664 is the worked example. Its final round said "quality gates pass
 * … the overall design is sound", filed one item under `### ISSUES` and the
 * rest under `### MINOR_OBSERVATIONS`, and returned ISSUES_FOUND. The cycle
 * died with no commit and no PR.
 */

import { decideLoopAction, parseVerdict } from "../src/adversarial-verdict.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const MAX = 3;

// ------------------------------------------------- the vocabulary parses

{
  assert(parseVerdict("VERDICT: APPROVED").status === "APPROVED", "APPROVED parses");
  assert(parseVerdict("VERDICT: ISSUES_FOUND").status === "ISSUES_FOUND", "ISSUES_FOUND parses");
  assert(
    parseVerdict("VERDICT: MINOR_OBSERVATIONS").status === "MINOR_OBSERVATIONS",
    "canary: MINOR_OBSERVATIONS parses — the prompt's own non-blocking verdict, absent from the enum before this",
  );
  assert(
    parseVerdict("**VERDICT: MINOR_OBSERVATIONS**").status === "MINOR_OBSERVATIONS",
    "...including the markdown-bold form reviewers routinely write",
  );

  // The substring hazard: CRITICAL_ISSUES_FOUND contains ISSUES_FOUND.
  assert(
    parseVerdict("VERDICT: CRITICAL_ISSUES_FOUND").status === "CRITICAL_ISSUES_FOUND",
    "canary: CRITICAL_ISSUES_FOUND never degrades to ISSUES_FOUND",
  );

  const unparsed = parseVerdict("I could not decide.");
  assert(unparsed.status === "ISSUES_FOUND", "an unreadable reply still defaults to ISSUES_FOUND");
  assert(
    unparsed.verdictParsed === false,
    "...and is marked unparsed, so its text is not passed off as findings",
  );
}

// ---------------- an unreadable verdict is not a verdict, and must not pass

{
  // The regression this file failed to prevent when it was written. Relaxing
  // the terminal rule to "only CRITICAL blocks" silently relaxed it for the
  // NO-VERDICT case too, because a marker miss defaults to ISSUES_FOUND — so a
  // reviewer that crashed, was truncated, or wrote its marker in a shape the
  // parser does not know went from REJECT to PASS. That is the mirror of the
  // bug this file exists to fix, and worse: it passes on no signal at all.
  const shapes: Array<[string, string]> = [
    ["no marker at all", "The reviewer crashed before writing a verdict."],
    // reply-markers.ts builds the separator as `\s*:?\s*\**\s*:?\s*`, which
    // an em-dash does not match.
    ["an em-dash separator", "VERDICT — CRITICAL_ISSUES_FOUND"],
    // spawn-collapse-events.ts sets this exact string, with ok=true, when a
    // child produced only thinking content.
    ["thinking-only output", "(thinking content only - no text output)"],
  ];

  for (const [name, text] of shapes) {
    const v = parseVerdict(text);
    assert(v.verdictParsed === false, `${name}: marked unparsed`);
    assert(
      decideLoopAction(v.status, MAX, MAX, v.verdictParsed) !== "pass",
      `canary: ${name} does NOT pass the terminal gate — no verdict is not an approval`,
    );
  }

  // ...and it is not silently downgraded to a rejection either: nothing was
  // reviewed, so this is an infrastructure failure, which is what the loop
  // already knows how to report and retry.
  const v = parseVerdict("garbage");
  assert(
    decideLoopAction(v.status, MAX, MAX, v.verdictParsed) === "incomplete",
    "an unreadable reply is INCOMPLETE — distinct from a reviewer that read the diff and objected",
  );
  assert(
    decideLoopAction("ISSUES_FOUND", MAX, MAX, true) === "pass",
    "...while a genuine ISSUES_FOUND still passes, so the #664 fix is intact",
  );
}

// ------------------- the LAST marker wins, not the first (reply-markers.ts:44)

{
  // `readMarker` used a non-global `text.match`, which returns the FIRST hit.
  // A reviewer that mentions the token while thinking — and they do, the fix
  // prompts are full of mid-task narration — had its narration read as its
  // verdict.
  const twoMarkers = [
    "I will return VERDICT: ISSUES_FOUND if the parser is wrong.",
    "It turned out to be fine.",
    "VERDICT: APPROVED",
  ].join("\n\n");
  assert(
    parseVerdict(twoMarkers).status === "APPROVED",
    "canary: with two VERDICT markers the LAST one wins — the first-match read a reviewer's musing as its verdict",
  );
}

// -------------------------------------------- what each verdict does to the loop

{
  // Mid-loop: anything unresolved earns a fix round. That is what the rounds
  // are for, and in #664 rounds 1 and 2 produced real fixes.
  assert(decideLoopAction("APPROVED", 1, MAX, true) === "pass", "APPROVED passes immediately");
  assert(
    decideLoopAction("MINOR_OBSERVATIONS", 1, MAX, true) === "pass",
    "MINOR_OBSERVATIONS passes immediately — 'author's discretion'",
  );
  assert(
    decideLoopAction("ISSUES_FOUND", 1, MAX, true) === "fix",
    "ISSUES_FOUND earns a fix round",
  );
  assert(
    decideLoopAction("CRITICAL_ISSUES_FOUND", 1, MAX, true) === "fix",
    "CRITICAL_ISSUES_FOUND earns a fix round",
  );
  assert(decideLoopAction("ISSUES_FOUND", 2, MAX, true) === "fix", "...still, on round 2");
}

{
  // Terminal: only the verdict the doctrine calls blocking actually blocks.
  assert(
    decideLoopAction("ISSUES_FOUND", MAX, MAX, true) === "pass",
    "canary: ISSUES_FOUND on the LAST round passes — 83.7% of all rejections ended here",
  );
  assert(
    decideLoopAction("MINOR_OBSERVATIONS", MAX, MAX, true) === "pass",
    "MINOR_OBSERVATIONS on the last round passes",
  );
  assert(
    decideLoopAction("CRITICAL_ISSUES_FOUND", MAX, MAX, true) === "reject",
    "CRITICAL_ISSUES_FOUND on the last round still REJECTS — the gate keeps its teeth",
  );
  assert(
    decideLoopAction("APPROVED", MAX, MAX, true) === "pass",
    "APPROVED on the last round passes",
  );
}

// ---------------------------------------------- lantern #664, replayed exactly

{
  // The real sequence from loop mspwtzfk-dkzy3v.
  const sequence = ["CRITICAL_ISSUES_FOUND", "ISSUES_FOUND", "ISSUES_FOUND"] as const;
  const actions = sequence.map((v, i) => decideLoopAction(v, i + 1, MAX, true));
  assert(
    actions[0] === "fix" && actions[1] === "fix",
    "#664: rounds 1 and 2 still earn fix rounds — they produced real fixes and must not be skipped",
  );
  assert(
    actions[2] === "pass",
    "canary: #664 now PASSES on round 3 — it died here, with green tests and a design the reviewer called sound",
  );

  // And the counter-case must still fail, or this is not a gate.
  const bad = ["ISSUES_FOUND", "ISSUES_FOUND", "CRITICAL_ISSUES_FOUND"] as const;
  assert(
    bad.map((v, i) => decideLoopAction(v, i + 1, MAX, true))[2] === "reject",
    "a loop ending CRITICAL still rejects — the fix is not 'always pass'",
  );
}

// -------------------------------------------- prompt and code agree on the words

{
  // The defect underneath all of the above: three sources disagreed about the
  // vocabulary, and two of them were markdown files composed into one prompt.
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const ROOT = path.resolve(import.meta.dirname, "..", "..");

  const doctrine = readFileSync(path.join(ROOT, "agents-base", "adversarial-developer.md"), "utf8");
  const src = readFileSync(path.join(ROOT, "extension", "src", "adversarial-verdict.ts"), "utf8");

  const menu = doctrine.match(/VERDICT:\s*\[([A-Z_|\s]+)\]/);
  const tokens = (menu?.[1] ?? "")
    .split("|")
    .map((t) => t.trim())
    .filter(Boolean);
  assert(
    tokens.length === 4,
    `the doctrine offers ${tokens.length} verdicts: ${tokens.join(", ")}`,
  );
  const missing = tokens.filter((t) => !src.includes(t));
  assert(
    missing.length === 0,
    `every verdict the prompt offers is known to the code${missing.length ? ` — missing: ${missing.join(", ")}` : ""}`,
  );

  // Exactly one verdict menu in the composed prompt. Two copies is how they
  // drifted: modules/domains/adversarial-patterns.md carried a stale
  // three-verdict menu that also told the reviewer to use APPROVED only when
  // "genuinely unable to find problems".
  const built = path.join(ROOT, "dist", "prompts", "standard", "adversarial-developer.md");
  try {
    const composed = readFileSync(built, "utf8");
    const menus = composed.match(/VERDICT:\s*\[[A-Z_|\s]+\]/g) ?? [];
    assert(
      menus.length === 1,
      `canary: the built prompt states its verdict menu exactly once (found ${menus.length})`,
    );
    for (const m of menus) {
      assert(
        m.includes("MINOR_OBSERVATIONS"),
        "...and that menu is the four-verdict one, not the stale three-verdict copy",
      );
    }
  } catch {
    console.log("  … dist/ not built; skipping composed-prompt check (run `bun run build`)");
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
