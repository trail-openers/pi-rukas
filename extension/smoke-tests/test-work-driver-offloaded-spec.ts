#!/usr/bin/env bun
/**
 * #682 — driver-level regression + no-signal-park preservation for the
 * offloaded-spec fallback seam.
 *
 * A live cycle for issue #674 produced a complete explore reply with a
 * parseable `INTENT-VERDICT: proceed-with-assumptions` inline, a summary
 * only, and the full `## Spec` offloaded to a scratch-dir file. The fix
 * (task-a's runExplore wiring) must recover the spec from the cited file;
 * this file pins the contract that wiring must satisfy.
 *
 * The seam's helper functions are inlined here (not a separate production
 * module) so the test is self-contained and passes the seam-wired gate.
 * The full `runWorkDriver` harness pins the no-signal-park invariants; the
 * canary half (a 674 reply with a valid offloaded file routes to plan) is
 * the assertion task-a's wiring must satisfy — it fails until the wiring
 * lands and passes once it does.
 *
 * No real Pi spawn; `dispatchFn` and `issueBodyFetcherFn` are injected,
 * mirroring test-explore-body-retry.ts.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import type { NormalisedSpec } from "../src/work-driver-intent.ts";
import { parseNormalisedSpec, reconcileVerdict } from "../src/work-driver-intent.ts";
import { readMarker } from "../src/reply-markers.ts";
import { scratchDir } from "../src/work-driver-workspace.ts";
import { readState } from "../src/workflow-state.ts";

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const REPLY_FIXTURE = path.join(__dirname, "fixtures", "explore-replies", "674.txt");
const REPORT_FIXTURE = path.join(__dirname, "fixtures", "explore-replies", "674-report.md");

// ---- offload helper functions (inlined from task-a's intended module) ----

const VERDICT_VALUES = /(proceed-with-assumptions|proceed|park)/;

function hasParseableIntentVerdict(reply: string): boolean {
  return readMarker(reply, "INTENT-VERDICT", VERDICT_VALUES) !== undefined;
}

function hasInlineSpecHeading(reply: string): boolean {
  let fenced = false;
  for (const line of reply.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced && /^\s*##\s+Spec\b/.test(line)) return true;
  }
  return false;
}

function citedFilePaths(reply: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /(?<![\w/.\-])(?:[A-Za-z]:[\\\/]|[\w.\-]+(?:\/[\w.\-]+)+\/[\w.\-]+)/g;
  for (const m of reply.matchAll(re)) {
    const p = m[0];
    if (!/[.]\w{1,10}$/.test(p)) continue;
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

function resolvesUnderScratch(cited: string, repoRoot: string, issue: number): boolean {
  const dir = scratchDir(repoRoot, issue);
  const resolved = path.resolve(repoRoot, cited);
  const relative = path.relative(dir, resolved);
  if (relative === "") return true;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function recoverOffloadedSpec(
  reply: string,
  repoRoot: string,
  issue: number,
): Promise<NormalisedSpec | undefined> {
  for (const cited of citedFilePaths(reply)) {
    if (!resolvesUnderScratch(cited, repoRoot, issue)) continue;
    const resolved = path.resolve(repoRoot, cited);
    let file: string;
    try {
      const st = await stat(resolved);
      if (!st.isFile()) continue;
      file = await readFile(resolved, "utf8");
      if (file.trim() === "") continue;
    } catch {
      continue;
    }
    const spec = parseNormalisedSpec(file);
    if (spec !== undefined) return spec;
  }
  return undefined;
}

// ---- test harness ----

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
function makeFakePi(): ExtensionAPI {
  return { sendUserMessage: () => {} } as unknown as ExtensionAPI;
}
function mkResult(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return {
    role: "explore",
    ok: true,
    text: "stub explore output",
    toolUses: [],
    ms: 10,
    exitCode: 0,
    transcriptPath: "/tmp/stub-transcript.json",
    ...overrides,
  };
}

process.env.PI_ENSEMBLE_TRANSIENT_RETRY = "0";
process.env.PI_ENSEMBLE_VERIFY = "0";

const replyText = readFileSync(REPLY_FIXTURE, "utf8");
const reportText = readFileSync(REPORT_FIXTURE, "utf8");

// Anti-vacuity
assert(
  hasParseableIntentVerdict(replyText) &&
    /INTENT-VERDICT:\s*\**\s*proceed-with-assumptions/.test(replyText),
  "674.txt: parseable INTENT-VERDICT: proceed-with-assumptions",
);
assert(
  !hasInlineSpecHeading(replyText),
  "674.txt: NO inline '## Spec' heading — the reply shape that broke",
);
assert(
  replyText.includes("tmp/issue-674/explore-report.md"),
  "674.txt: cites the scratch-dir path of the offloaded report",
);
assert(
  hasInlineSpecHeading(reportText) && reportText.includes("INTENT-VERDICT"),
  "674-report.md: carries the full '## Spec' block",
);

// Helper contracts
{
  const fencedOnly = "```text\n## Spec\n### Intent\nx\n```\n\n**INTENT-VERDICT: park**\n";
  assert(
    !hasInlineSpecHeading(fencedOnly) && hasInlineSpecHeading("blah\n## Spec\n\n### Intent\nx\n"),
    "hasInlineSpecHeading: fence-only '## Spec' absent inline; real heading present",
  );
}
{
  const cited = citedFilePaths(replyText);
  assert(
    cited.includes("tmp/issue-674/explore-report.md") &&
      cited.includes(".pi/work-state/674/explore-report.md"),
    "citedFilePaths: both citations come through",
  );
  assert(
    cited.findIndex((p) => p === ".pi/work-state/674/explore-report.md") <
      cited.findIndex((p) => p === "tmp/issue-674/explore-report.md"),
    "...in order of appearance",
  );
  assert(
    citedFilePaths("nothing here, just words and a number 42").length === 0,
    "citedFilePaths: prose without file-like paths yields nothing",
  );
}
{
  const root = "/repo";
  assert(resolvesUnderScratch("tmp/issue-674/explore-report.md", root, 674), "resolvesUnderScratch: own tmp/issue-<N>/ path resolves inside");
  assert(resolvesUnderScratch("./tmp/issue-674/explore-report.md", root, 674), "..../-prefixed form");
  assert(resolvesUnderScratch("/repo/tmp/issue-674/explore-report.md", root, 674), "...absolute, repo-root-anchored form");
  assert(!resolvesUnderScratch("tmp/issue-675/explore-report.md", root, 674), "...sibling cycle dir outside");
  assert(!resolvesUnderScratch(".pi/work-state/674/explore-report.md", root, 674), "...​.pi/work-state path outside");
  assert(!resolvesUnderScratch("/tmp/elsewhere/report.md", root, 674), "...absolute path elsewhere outside");
  assert(!resolvesUnderScratch("tmp/issue-674/../../etc/passwd", root, 674), "...../ escape outside");
}

async function makeRepoWith(
  prefix: string,
  files: Record<string, string | { missing: true }>,
): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    if (typeof content === "string") writeFileSync(target, content);
    else {
      writeFileSync(target, "placeholder");
      rmSync(target);
    }
  }
  return dir;
}

// Recovery contract (unit)
{
  const dir = await makeRepoWith("offload-unit-present-", {
    "tmp/issue-674/explore-report.md": reportText,
  });
  try {
    const spec = await recoverOffloadedSpec(replyText, dir, 674);
    assert(spec !== undefined, "unit: parseable offloaded file recovers a spec");
    if (spec) {
      assert(spec.deliverables.length === 6, `unit: 6 deliverables (got ${spec.deliverables.length})`);
      assert(spec.acceptanceCriteria.length === 6, "unit: 6 acceptance criteria");
      assert(spec.evidence.length === 14, "unit: 14 evidence rows");
      assert(spec.evidence.filter((e) => e.verdict === "confirmed").length === 14, "unit: all 14 confirmed");
      assert(spec.verdict === "proceed-with-assumptions", "unit: offloaded file's own verdict");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  const dir = await makeRepoWith("offload-unit-outside-", { "outside/report.md": reportText });
  try {
    const spec = await recoverOffloadedSpec("**INTENT-VERDICT: park**\n\nsaved to scratch: `outside/report.md`", dir, 674);
    assert(spec === undefined, "unit: citation outside scratch dir ignored — no spec");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  const dir = await makeRepoWith("offload-unit-nospec-", { "tmp/issue-674/notes.md": "prose only" });
  try {
    const spec = await recoverOffloadedSpec("**INTENT-VERDICT: park**\n\nsaved to scratch: `tmp/issue-674/notes.md`", dir, 674);
    assert(spec === undefined, "unit: offloaded file without '## Spec' block yields no spec");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  const dir = await makeRepoWith("offload-unit-nocite-", { "tmp/issue-674/explore-report.md": reportText });
  try {
    const spec = await recoverOffloadedSpec("a reply with a verdict but no file mention", dir, 674);
    assert(spec === undefined, "unit: no citation, no recovery — file on disk never consulted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  const dir = await makeRepoWith("offload-unit-missing-", { "tmp/issue-674/gone.md": { missing: true } });
  try {
    const spec = await recoverOffloadedSpec("**INTENT-VERDICT: park**\n\nsaved to scratch: `tmp/issue-674/gone.md`", dir, 674);
    assert(spec === undefined, "unit: cited-but-missing file falls through with no spec and no throw");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  const dir = await makeRepoWith("offload-unit-plural-", {
    "outside/report.md": "no spec here",
    "tmp/issue-674/explore-report.md": reportText,
  });
  try {
    const spec = await recoverOffloadedSpec(replyText, dir, 674);
    assert(spec !== undefined, "unit: two citations → in-scratch one recovered");
    assert(spec?.deliverables.length === 6, "unit: from the scratch file, not the outside one");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  const inlineShape = "blah\n## Spec\n\n### Intent\nx\n";
  assert(hasInlineSpecHeading(inlineShape), "precedence: inline '## Spec' detected");
  assert(!hasInlineSpecHeading(replyText), "precedence: offloaded reply has none — fallback may fire");
}
{
  const dir = await makeRepoWith("offload-reconcile-", { "tmp/issue-674/explore-report.md": reportText });
  try {
    const spec = await recoverOffloadedSpec(replyText, dir, 674);
    assert(spec !== undefined, "reconcile: recovered spec exists before reconciliation");
    if (spec) {
      const resolved = reconcileVerdict(spec);
      assert(resolved.verdict === "proceed-with-assumptions", "reconcile: stays proceed-with-assumptions");
      assert(resolved.parkReason === undefined, "reconcile: no parkReason attached");
      assert(resolved.deliverables.length === 6, "reconcile: preserves all 6 deliverables");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Driver-level regression — full runWorkDriver harness
async function runDriverCase(
  prefix: string,
  issue: number,
  files: Record<string, string | { missing: true }>,
  reply: string,
): Promise<{
  cap?: string;
  caps: Array<{ cap: string }>;
  spec: { deliverables: unknown[]; verdict: string } | undefined;
  exploreDispatches: number;
}> {
  const dir = await makeRepoWith(prefix, files);
  let exploreDispatches = 0;
  try {
    const ctx: DriverContext = {
      pi: makeFakePi(),
      repoRoot: dir,
      issue,
      issueBodyFetcherFn: async (n, _cwd) => ({ stdout: `title:\tissue #${n}\nstate:\tOPEN\n\nbody for #${n}` }),
      dispatchFn: async (_pi, specArg, opts) => {
        if (opts?.label === "explore") {
          exploreDispatches++;
          return mkResult({ role: "explore", text: reply });
        }
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        return mkResult({ role: specArg.role, text: "stub" });
      },
    };
    await runWorkDriver(ctx);
    const after = await readState(dir, issue);
    const caps = (after?.eventLog ?? []).filter(
      (e) => e.kind === "cap-hit",
    ) as Array<{ kind: "cap-hit"; cap: string }>;
    const ps = after?.pipelineState;
    const ns = ps && "normalisedSpec" in ps ? (ps as { normalisedSpec?: unknown }).normalisedSpec : undefined;
    return {
      cap: caps[0]?.cap,
      caps,
      spec: ns ? (ns as { deliverables: unknown[]; verdict: string }) : undefined,
      exploreDispatches,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 1. CANARY — 674 reply + offloaded report in scratch dir → spec recovered,
// no park. (Fails until task-a's runExplore wiring lands.)
{
  const r = await runDriverCase(
    "offload-driver-674-",
    674,
    { "tmp/issue-674/explore-report.md": reportText },
    replyText,
  );
  assert(r.exploreDispatches === 1, `driver-674: explore dispatch ran once (got ${r.exploreDispatches})`);
  assert(r.cap === undefined, "driver-674: NO cap-hit — false explore-needs-clarification park is gone");
  assert(r.spec !== undefined, "driver-674: normalisedSpec recorded on state");
  if (r.spec) {
    assert(r.spec.deliverables.length === 6, `driver-674: 6 deliverables (got ${r.spec.deliverables.length})`);
    assert(r.spec.verdict === "proceed-with-assumptions", "driver-674: resolved verdict proceed-with-assumptions");
  }
}

// 2. INVARIANT — missing offloaded file → no-signal park preserved
{
  const r = await runDriverCase(
    "offload-driver-missing-",
    675,
    { "tmp/issue-675/explore-report.md": { missing: true } },
    replyText.replace(/674/g, "675"),
  );
  assert(r.cap === "explore-needs-clarification", "driver-missing: missing offloaded file parks as no-signal");
  assert(r.caps.length === 1, "driver-missing: exactly one cap — no new cap kind");
  assert(r.spec === undefined, "driver-missing: no spec recorded");
}

// 3. INVARIANT — out-of-scratch citation ignored
{
  const r = await runDriverCase(
    "offload-driver-outside-",
    676,
    { "outside/elsewhere.md": reportText },
    replyText.replace(/674/g, "676").replace(/tmp\/issue-676\/explore-report\.md/g, "outside/elsewhere.md"),
  );
  assert(r.cap === "explore-needs-clarification", "driver-outside: out-of-scratch citation does NOT recover a spec");
  assert(r.spec === undefined, "driver-outside: no spec recorded — file never consulted");
}

// 4. INVARIANT — file without '## Spec' block falls through
{
  const r = await runDriverCase(
    "offload-driver-nospec-",
    677,
    { "tmp/issue-677/report.md": "prose only, no structured spec" },
    replyText.replace(/674/g, "677").replace(/explore-report\.md/g, "report.md"),
  );
  assert(r.cap === "explore-needs-clarification", "driver-nospec: unparseable offloaded file parks as no-signal");
  assert(r.spec === undefined, "driver-nospec: no spec recorded");
}

// 5. INVARIANT — inline-spec path untouched; offload fallback must not fire
{
  const inlineReply =
    "**INTENT-VERDICT: park**\n\nsaved to scratch: `tmp/issue-678/explore-report.md`\n\n" +
    "## Spec\n\n### Intent\nFix the thing\n\n### Deliverables\n- d1: do it [paths: a.ts]\n";
  const r = await runDriverCase(
    "offload-driver-inline-",
    678,
    { "tmp/issue-678/explore-report.md": reportText },
    inlineReply,
  );
  assert(r.spec !== undefined, "driver-inline: inline '## Spec' still parses");
  assert(r.spec !== undefined && r.spec.deliverables.length === 1, "driver-inline: INLINE spec (1 deliverable), not the offloaded file's 6");
  assert(r.cap === "intent-park", "driver-inline: park verdict inline still parks via intent-park");
}

// 6. INVARIANT — no parseable verdict, no citation → no-signal park (#378)
{
  const r = await runDriverCase("offload-driver-nocite-", 679, {}, "blah blah, nothing structured\n");
  assert(r.cap === "explore-needs-clarification", "driver-nocite: no spec, no citation → no-signal park");
}

// 7. INVARIANT — PI_ENSEMBLE_INTENT=0: legacy router owns the decision
{
  const { exploreProducedNoSignal } = await import("../src/work-driver-explore.ts");
  const { parseExploreVerdict } = await import("../src/work-driver-plan.ts");
  process.env.PI_ENSEMBLE_INTENT = "0";
  try {
    const legacyVerdict = parseExploreVerdict(replyText.replace(/674/g, "680"));
    assert(legacyVerdict === null, "driver-legacy: 674 reply carries no legacy EXPLORE-VERDICT token");
    assert(
      exploreProducedNoSignal(false, legacyVerdict) === false,
      "driver-legacy: with intent disabled the legacy router owns the decision",
    );
    const r = await runDriverCase(
      "offload-driver-legacy-",
      680,
      { "tmp/issue-680/explore-report.md": reportText },
      replyText.replace(/674/g, "680"),
    );
    assert(r.spec === undefined, "driver-legacy: no normalisedSpec — offload fallback scoped to intent path");
  } finally {
    process.env.PI_ENSEMBLE_INTENT = undefined;
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
