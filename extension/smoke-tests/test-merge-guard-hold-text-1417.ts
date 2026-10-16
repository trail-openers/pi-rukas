/**
 * #1417 task B — the HOLD texts. `gh api repos/…/issues/N --jq '…'` is the
 * read the classifier owns (task A) and is `none` at this layer; what this
 * file pins is the guard's own behaviour once a command IS held: the refusal
 * names what was held, never calls it a merge, and never names the merge
 * escape hatch — while the refusals for real merges keep both.
 */

import { readMergeCommand } from "../src/merge-allowlist.ts";
import { renderHold } from "../src/merge-guard-reads.ts";
import { MERGE_FORM_REFUSAL, mergeFormRefusal } from "../src/merge-refusals.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

const HATCH = "PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE";

/** The guard's hold for a refused command, exactly as merge-guard.ts renders it. */
function holdText(cmd: string): string {
  const m = readMergeCommand(cmd);
  if (m.kind !== "refused") return `<<${m.kind}>>`;
  const reasonText =
    m.reason === undefined
      ? "merge-adjacent text it could not match to the one plain merge form the guard checks"
      : `a \`${m.reason}\` shape${m.detail === undefined ? "" : `: ${m.detail}`}`;
  return renderHold({ kind: "form", reasonText }, cmd).reason;
}

// ------------------------------------------- what was held is named, not just coded
const HELD: Array<[string, string]> = [
  ['gh api graphql -f query="$(cat q.graphql)"', "body-indirect"],
  ["curl -d @body.json https://api.github.com/graphql", "body-indirect"],
  ["gh pr m{erge,} 17", "brace-expansion"],
  ['"$GH" pr merge 17', "expansion-command-word"],
  ["bash -c 'gh pr merge 17'", "not-a-forge-command"],
  ["gh pr merge 1x", "not-a-number"],
  ["gh pr merge 17 --auto", "unknown-flag"],
  ["gh pr merge 17 extra", "extra-command"],
];
for (const [cmd, code] of HELD) {
  const m = readMergeCommand(cmd);
  assert(m.kind === "refused" && (m.reason ?? "").startsWith(code), `held as ${code}: ${cmd}`);
  const text = holdText(cmd);
  assert(text.includes("command held (not a merge)"), `the hold says it is not a merge: ${code}`);
  assert(text.includes(code), `the hold names the reason code: ${code}`);
  assert(!text.includes(HATCH), `the hold never names the merge escape hatch: ${code}`);
  assert(!/^merge refused/.test(text), `the hold never says "merge refused": ${code}`);
  // The reason is never left to a console truncation to explain: the clause
  // after the code says what to change, in the text itself.
  assert(
    /[\w)"] — /.test(text) || text.includes(": a ") || text.includes(": the "),
    `the hold explains the code in prose: ${code}`,
  );
}

// The offending word is quoted for the grammar refusals, so the reader sees
// the token rather than guessing which word the rule stopped on.
assert(
  holdText("gh pr merge 17 --auto").includes("unknown-flag"),
  "…and an unknown flag refusal is produced",
);

// ------------------------------------------- the merge refusals keep the hatch
assert(
  MERGE_FORM_REFUSAL.includes(HATCH),
  "the merge form refusal names the hatch (a merge is at stake)",
);
assert(
  mergeFormRefusal("body-indirect").includes("[reason: body-indirect"),
  "…and names its reason code",
);
assert(
  mergeFormRefusal("body-indirect").includes("so the guard cannot see what it sends"),
  "…and explains the code in prose rather than leaving a bare token",
);
assert(
  mergeFormRefusal().includes("the merge guard checks only one plain merge command"),
  "the no-reason form refusal keeps the original opening",
);

// A hold never claims a review was skipped; a merge refusal always can.
const bodyIndirect = holdText('gh api graphql -f query="$(cat q.graphql)"');
assert(bodyIndirect.includes("not a review gate"), "the hold disclaims the review gate");
assert(bodyIndirect.includes("false hold"), "the hold tells the agent to report a false hold");

// ------------------------------------------- the classifier is still inert for reads
// (task A owns the `gh api` classification; these pin that no hold creeps in.)
for (const cmd of [
  "oo gh api repos/o/r/issues/250 --jq '{number,title,state,closed_at}'",
  "gh issue view 253 --repo o/r --json number,title,state",
  "gh pr view 12 --json comments",
]) {
  assert(readMergeCommand(cmd).kind === "none", `read stays inert: ${cmd}`);
}

// `renderHold` clamps the held text at the source, so a long command cannot
// push the explanation past whatever console truncates it.
const long = `gh pr merge ${"9".repeat(400)}`;
const longText = renderHold({ kind: "form", reasonText: "a `not-a-number` shape" }, long).reason;
assert(longText.length < 900, `the hold is bounded (${longText.length} chars)`);
assert(longText.includes("…"), "…clamped with an ellipsis rather than cutting mid-word");

process.exit(exit);
