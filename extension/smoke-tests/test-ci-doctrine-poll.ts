#!/usr/bin/env bun
/**
 * #2333 — the CI wait doctrine is the bounded sleep-poll, on every surface that
 * prescribes one.
 *
 * The reported bug: an ops child handed "watch CI then merge" ended its turn while
 * a blocking `gh pr checks --watch` / `gh run watch` was still in flight, and the
 * merge never happened. The same brief rewritten as a bounded poll completed. The
 * doctrine itself was the defect — `agents-base/ops.md` and
 * `modules/workflows/ci-monitoring.md` headed GitHub with "ALWAYS use `gh run
 * watch`, NO polling" while their FORBIDDEN list banned "Manual `sleep` + status
 * check patterns", so a child was told twice not to run the one recipe that works.
 *
 * **What this gate holds:** the ops role's assembled sources (its role doc plus
 * every module its own manifest lists — the same composition rule
 * `test-helper-forge-read-doctrine.ts` follows) must state the poll interval, the
 * cap, the terminal set, and the "a pending check is never a reason to end the
 * turn" rule, and must NOT prescribe a blocking watch as the GitHub default. The
 * driver's own CI brief (`inlineCiPrompt`) is pinned to the same numbers: it is
 * the only sleep-based recipe a dispatched child is handed, and nothing asserted
 * over its wording before this file.
 *
 * **The numbers are the driver's, not prose invented here.** Interval 60 s
 * (`CI_POLL_MS`, extension/src/lean/ci-poll.ts) and cap 30 min
 * (`DEFAULT_TIMEOUT_MS`, extension/src/forge-ci.ts, which is also what
 * `ciWatchTimeoutMs()` gives the ops:ci dispatch). Both are read OUT of those
 * sources rather than restated, so a bump moves the gate too — a prompt interval
 * the driver does not share is a second source of truth that drifts silently.
 *
 * **Reads only.** `isCiWatchCommand` / `CI_WATCH_SHAPES`
 * (extension/src/slow-notice-ci-wait.ts) keep their four watch shapes unchanged:
 * an ops child runs under trust mode, where neither the permission layer nor the
 * slow watch gates it, and the watch shapes still serve their own callers. The
 * poll's calls are deliberately NOT registered as CI-wait spans — the section
 * below pins that as a decision rather than an oversight.
 *
 * **Observed red.** The classifiers live in `lib/ci-doctrine.ts` so the base
 * commit's doctrine text can be run through the SAME functions that pass here, and
 * the canary block below mutates a fixture five ways and demands each be reported.
 * A gate never seen failing is worthless — test-file-size-limit.ts precedent.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  blockingWatchPrescribed,
  CI_DOCTRINE_OBLIGATIONS,
  missingCiDoctrine,
} from "./lib/ci-doctrine.ts";
import { isCiWatchCommand } from "../src/slow-notice-ci-wait.ts";
import { CI_WAIT_STEPS } from "../src/work-driver-ci-wait-brief.ts";
import { inlineCiPrompt } from "../src/work-driver-prompts-late.ts";

const SELF = "test-ci-doctrine-poll.ts";
const ROOT = path.resolve(import.meta.dirname, "..", "..");

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

/** The driver's own numbers, read out of the implementation the doctrine imitates.
 * `CI_POLL_MS` is written with digit separators (`60_000`), so the digits are
 * joined before the unit conversion. */
const POLL_MS_MATCH = readFileSync(path.join(ROOT, "extension/src/lean/ci-poll.ts"), "utf8").match(
  /CI_POLL_MS\s*=\s*([\d_]+)/,
);
const POLL_SECONDS = POLL_MS_MATCH ? Number(POLL_MS_MATCH[1].replace(/_/g, "")) / 1000 : NaN;
const CI_WATCH_SRC = readFileSync(path.join(ROOT, "extension/src/forge-ci.ts"), "utf8");
const CAP_MINUTES = Number(
  CI_WATCH_SRC.match(/DEFAULT_TIMEOUT_MS\s*=\s*(\d+)\s*\*\s*60\s*\*\s*1000/)?.[1] ?? NaN,
);
assert(
  Number.isFinite(POLL_SECONDS) && POLL_SECONDS > 0,
  `the poll interval resolves from CI_POLL_MS in lean/ci-poll.ts (got ${POLL_SECONDS}s)`,
);
assert(
  Number.isFinite(CAP_MINUTES) && CAP_MINUTES > 0,
  `the wait cap resolves from DEFAULT_TIMEOUT_MS in forge-ci.ts (got ${CAP_MINUTES}min)`,
);

/** The sources one role's prompt is assembled from: its role doc plus every module
 * its manifest lists, read from the manifest so the gate follows the composition
 * instead of a copy of it that goes stale. */
function promptSources(role: string): { file: string; text: string }[] {
  const manifest = readFileSync(path.join(ROOT, "manifests", `${role}.manifest`), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  assert(
    manifest.length > 0 && manifest[0] === `agents-base/${role}.md`,
    `${role}: its manifest names its own role doc first`,
  );
  return manifest.map((rel) => ({ file: rel, text: readFileSync(path.join(ROOT, rel), "utf8") }));
}

// ------------------------------------------------ the ops role's assembled sources

{
  const sources = promptSources("ops");
  const composed = sources.map((s) => s.text).join("\n");
  assert(
    sources.some((s) => s.file === "modules/workflows/ci-monitoring.md"),
    "ops: its manifest assembles the ci-monitoring module (so the gate reads what the child reads)",
  );

  const missing = missingCiDoctrine(composed);
  assert(
    missing.length === 0,
    `ops: the assembled doctrine states every CI-wait obligation${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`,
  );

  // The interval and the cap are the driver's numbers, not invented prose.
  assert(
    CI_DOCTRINE_OBLIGATIONS.interval.test(composed) && composed.includes(`${POLL_SECONDS}`),
    `ops: the poll names the driver's ${POLL_SECONDS}s interval (CI_POLL_MS)`,
  );
  assert(
    CI_DOCTRINE_OBLIGATIONS.cap.test(composed) && composed.includes(`${CAP_MINUTES}`),
    `ops: the wait names the driver's ${CAP_MINUTES}-minute cap (forge-ci DEFAULT_TIMEOUT_MS)`,
  );

  const prescriptions = sources.flatMap((s) =>
    blockingWatchPrescribed(s.text).map((h) => `${s.file}: ${h}`),
  );
  assert(
    prescriptions.length === 0,
    `ops: no source prescribes a blocking CI watch as the way to wait${prescriptions.length ? `:\n${prescriptions.join("\n")}` : ""}`,
  );

  // The FORBIDDEN block was re-scoped, not left standing: it must no longer ban
  // the sleep+status poll, but it must still ban an unbounded loop.
  assert(
    !/Manual `sleep` \+ status check/i.test(composed),
    "ops: the FORBIDDEN list no longer bans the sleep + status poll",
  );
  assert(
    /unbounded/i.test(composed),
    "ops: the FORBIDDEN list still bans an unbounded CI loop",
  );

  // The GitLab section's own rule survives: `glab ci status` is not
  // non-interactive-safe, and the fix must not have "restored" it.
  assert(
    !/^\s*glab ci status/m.test(composed),
    "ops: the doctrine runs no `glab ci status` command line",
  );
}

// ------------------------------------------------- the driver's own CI brief

{
  const brief = inlineCiPrompt(2333, "feature/issue-2333-poll", "/tmp/pi-ensemble-2333");
  const missing = missingCiDoctrine(brief);
  assert(
    missing.length === 0,
    `inlineCiPrompt: the driver's CI brief states every CI-wait obligation${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`,
  );
  const briefPrescriptions = blockingWatchPrescribed(brief);
  assert(
    briefPrescriptions.length === 0,
    `inlineCiPrompt: the driver's brief prescribes no blocking watch${briefPrescriptions.length ? `:\n${briefPrescriptions.join("\n")}` : ""}`,
  );
  assert(
    brief.includes("ci-status: success") && brief.includes("ci-status: failure"),
    "inlineCiPrompt: the ci-status marker contract is intact",
  );
  // R1 — the marker discipline the driver grades on: exactly one marker, only
  // after a terminal state, never the `pending` value the driver has no arm for.
  assert(
    /never\s+`?ci-status:?\s*pending/i.test(brief),
    "inlineCiPrompt: the brief forbids emitting `ci-status: pending`",
  );
  assert(
    /unchained|two separate/i.test(brief) && !/while true|\$\(/.test(brief),
    "inlineCiPrompt: the poll is prescribed as separate unchained calls, not a shell loop",
  );
}

// --------------------------------------- the PM-facing prose surfaces

for (const rel of ["agents-base/project-manager.md", "pi-prompts/do.md"]) {
  const text = readFileSync(path.join(ROOT, rel), "utf8");
  const prescriptions = blockingWatchPrescribed(text);
  assert(
    prescriptions.length === 0,
    `${rel}: prescribes no blocking CI watch${prescriptions.length ? `:\n${prescriptions.join("\n")}` : ""}`,
  );
  assert(/sleep 60|sleep-poll|bounded poll/i.test(text), `${rel}: names the poll as the CI wait`);
}

// ------------------------------------------ the poll is NOT a slow-watch span

{
  // The sanctioned poll's two calls are deliberately NOT CI-watch shapes. An
  // ops child runs under trust mode, where the slow watch's elapsed exclusion is
  // not what protects it, and registering a bare `sleep` as a CI-wait span would
  // stop EVERY role's 10-minute `sleep` from counting toward the notice. This
  // assertion is that trade-off written down: register the poll as a span and
  // this fails, so the argument happens in the PR rather than by assumption.
  for (const cmd of ["sleep 60", "gh pr checks 12 --repo o/r", "gh run view 1 --json status"]) {
    assert(
      isCiWatchCommand(cmd) === false,
      `the poll's calls stay OUT of the CI-watch span set: ${JSON.stringify(cmd)}`,
    );
  }
  // And the four real watch shapes still classify — the exclusion was not
  // quietly narrowed when the doctrine stopped recommending them.
  for (const cmd of ["gh pr checks 12 --watch", "gh run watch 12", "glab ci view"]) {
    assert(
      isCiWatchCommand(cmd) === true,
      `the watch shapes still classify: ${JSON.stringify(cmd)}`,
    );
  }
}

// --------------------------------------------------------------- the canary

{
  // The gate must be able to fail. Each mutant below is the fixed doctrine with
  // one obligation removed (or the watch restored), and the SAME functions that
  // passed above must report it.
  const good = [
    "Wait with a bounded poll: `sleep 60`, then `gh pr checks 12 --repo o/r`.",
    "A pending check is never a reason to end the turn.",
    "Stop at a terminal status or the 30-minute cap.",
    "A non-zero exit is data; gh pr checks exits 8 while pending.",
  ].join("\n");

  assert(missingCiDoctrine(good).length === 0, "canary: the fixture form passes the classifier");

  assert(
    blockingWatchPrescribed("### GitHub (`gh`) — ALWAYS use `gh run watch`, NO polling").length ===
      1,
    "canary: the pre-fix 'ALWAYS use gh run watch' heading IS reported as a prescription",
  );

  const noPending = good
    .split("\n")
    .filter((l) => !l.includes("never a reason to end"))
    .join("\n");
  assert(
    missingCiDoctrine(noPending).includes("pendingContinues"),
    "canary: dropping the pending-check sentence IS reported",
  );

  assert(
    missingCiDoctrine(good.replace("sleep 60", "sleep a while")).includes("interval"),
    "canary: dropping the poll interval IS reported",
  );
  assert(
    missingCiDoctrine(good.replace("30-minute cap", "a while")).includes("cap"),
    "canary: dropping the wait cap IS reported",
  );
  assert(
    missingCiDoctrine(good.split("\n").filter((l) => !l.includes("non-zero")).join("\n")).includes(
      "exitCodeIsData",
    ),
    "canary: dropping the exit-code-is-data sentence IS reported",
  );

  // …and the classifier must NOT flag prose that merely names the watch inside a
  // prohibition — the fix keeps those sentences on purpose — while an unnegated
  // watch beside an unrelated rule is still a prescription.
  const prohibitions = [
    "- ❌ Ending your turn while a check is pending — never run `gh run watch`.",
    "Never use a `--watch` flag; poll instead.",
    "Wait with the bounded sleep-poll — NOT `gh run watch`.",
  ].join("\n");
  assert(
    blockingWatchPrescribed(prohibitions).length === 0,
    `canary: a watch named only inside a prohibition is NOT flagged${blockingWatchPrescribed(prohibitions).length ? `:\n${blockingWatchPrescribed(prohibitions).join("\n")}` : ""}`,
  );
  assert(
    blockingWatchPrescribed("- Skip the local gate; run `gh run watch` and report.").length === 1,
    "canary: an unnegated watch in the same breath as an unrelated rule IS flagged",
  );

  // The load-bearing pair: the brief's OWN step-2 line is both the sanctioned
  // poll recipe and the sentence that names the forbidden watch. Its opening
  // status clause carries an unrelated `not` ("If the run is not terminal
  // yet") and its prohibition is set off by an em-dash, so a negation window
  // that reaches past a clause break reports zero prescriptions for this line
  // whatever the watch looks like — a reword back to `gh run watch` passes
  // every gate. Both directions of THIS line are pinned, on the shipped text.
  const step2 = CI_WAIT_STEPS[0];
  assert(
    step2.includes("NOT `gh run watch`") && blockingWatchPrescribed(step2).length === 0,
    "canary: the shipped step-2 recipe line is not itself flagged as a prescription",
  );
  const step2WatchBack = step2.replace(
    /wait with the bounded sleep-poll — NOT `gh run watch`[^.]*/, 
    "wait with `gh run watch`",
  );
  assert(
    step2WatchBack !== step2 && blockingWatchPrescribed(step2WatchBack).length === 1,
    `canary: the step-2 line reworded back to a bare \`gh run watch\` prescription IS flagged (${blockingWatchPrescribed(step2WatchBack).length} hit(s))`,
  );
  const step2NotDropped = step2.replace("— NOT `gh run watch`", "— `gh run watch`");
  assert(
    step2NotDropped !== step2 && blockingWatchPrescribed(step2NotDropped).length === 1,
    `canary: the step-2 line with only its \`NOT\` dropped IS flagged (${blockingWatchPrescribed(step2NotDropped).length} hit(s))`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
