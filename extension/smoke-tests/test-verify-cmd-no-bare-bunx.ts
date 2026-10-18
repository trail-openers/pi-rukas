#!/usr/bin/env bun
/**
 * #1118: `bun x` dispatches through the one bun binary always on PATH; `bunx`
 * is a second entry provisioning may not create, and two cycles parked on it.
 * Two scanned lists, because the same alias appears in two different roles:
 *
 *   1. `COMMAND_FILES` — the driver's command-tier files (`kind: "command"`
 *      in HEADLESS_FILES, derived rather than hand-listed). Every line the
 *      driver may execute.
 *   2. `PROSE_FILES` (#1414) — driver code and operator docs that PRESCRIBE
 *      a command. A `bunx` here is what a later reader copies, and for the
 *      cap-checkpoint it was also the operator-facing lie: the checkpoint
 *      ran one literal and the handoff named another.
 *
 * `EXEMPT_FILES` names where `bunx` stays legal and is deliberately NOT
 * scanned: `bash-command-parser.ts` / `review-accept-arms.ts` match
 * user-typed commands (where the alias is legitimate), `review-accept-guard.ts`
 * documents those arms, `ci.yml` runs on GitHub runners that always have it,
 * and smoke-test fixtures carry it as test DATA.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { HEADLESS_FILES, type HostFile } from "../src/headless/inputs.ts";
import { CHECKPOINT_TYPECHECK_CMD } from "../src/work-driver-cap-checkpoint.ts";
import { readFirstConfigLine } from "../src/work-driver-verify-cmd.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const BARE_BUNX = /\bbunx\b/;

/**
 * #1414/#1118 — a tsc invocation routed through a LAUNCHER rather than the
 * project's own compiler. A launcher resolves over a chain that can answer
 * with something other than the pinned dependency: on the host this ticket
 * was filed from, `bun x tsc` answered with a GLOBAL TypeScript 7, printed
 * its usage, and exited 0 — so the driver's typecheck gate was a NO-OP that
 * reported every tree as typechecking.
 *
 * Matched on the LAUNCHER form, not on the word `tsc`: a comment may explain
 * the bug by naming `bun x tsc`, and prose is what tells the next reader why
 * the pinned path exists (AGENTS.md §11: write the why). The rule fires on
 * lines that actually PRESCRIBE running it, and `MENTIONS_TSC` keeps the
 * shape honest — a line has to name tsc for the launcher pattern to matter.
 */
const TSC_LAUNCHER_RE = /\b(bunx|bun\s+x|npx|yarn|pnpm)\s+[^\n]*\btsc\b/;
const MENTIONS_TSC = /\btsc\b/;

/** A line that states the prescription rather than discussing it. Comments are
 *  exempt so the bug's explanation survives the gate that guards it: `//` line
 *  comments, JSDoc openers, and block-comment continuations (whose trimmed
 *  form is only `*` once the opener is gone). Without the continuation case
 *  the jsdoc on `CHECKPOINT_TYPECHECK_CMD` — which names `tsc` while explaining
 *  why the pinned path replaced `bun x tsc` — reads as a prescription, and the
 *  gate would demand the deletion of the most useful text in the file. */
function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

/**
 * Whether a non-comment line COMMANDS a tsc run, as opposed to reporting on
 * one. The distinction keeps the rule from firing on the gate's own canaries
 * or on a string that merely contains the shape: only a prescriptive frame
 * counts — a shell assignment, a backticked command in operator prose, or an
 * argument-position call.
 */
function prescribesRunning(line: string): boolean {
  if (isComment(line)) return false;
  if (!MENTIONS_TSC.test(line)) return false;
  return TSC_LAUNCHER_RE.test(line);
}

/** Where the checkpoint command is spelled, and what each site must say. */
const PROSE_FILES: readonly string[] = [
  "extension/src/work-driver-cap-checkpoint.ts",
  "extension/src/work-driver-cap-checkpoint-typecheck.ts",
  "extension/src/work-driver-caped-state.ts",
  "extension/src/workflow-state-cap.ts",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "docs/configuration.md",
  ".pi/worktree-setup",
];

/**
 * Named exemptions — files carrying `bunx` deliberately, never scanned.
 * Asserted below: if one of these ever loses its token the exemption is
 * dead config hiding a typo, and the list has drifted from reality.
 */
const EXEMPT_FILES: readonly string[] = [
  "extension/src/bash-command-parser.ts",
  "extension/src/review-accept-guard.ts",
  "extension/src/review-accept-arms.ts",
  ".github/workflows/ci.yml",
  "extension/smoke-tests/fixtures/agents-md/rich-manifest-no-codestyle-agents-md.md",
  "extension/smoke-tests/fixtures/issues/341.json",
  "extension/smoke-tests/fixtures/explore-replies/984.txt",
];

/** Each scanned prose file, with the substring (beyond the constant) that
 * states the checkpoint's command for a human reader. */
type ProseEntry = readonly [path: string, commandMention: string];

/** Escape a literal for embedding in a RegExp (the command contains no regex
 * metacharacters today, but a future `.` or `+` in it must not silently turn
 * the drift gate into a pattern that matches something else). */
function escapeRe(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Each entry: [file, [substring that must appear]]. Substrings are checked
 * RAW (no token substitution) so a site cannot satisfy the gate by naming a
 * constant instead of the command the operator reads.
 *
 * The src sites spell the command only inside
 * `CHECKPOINT_TYPECHECK_CMD`, so their mention is that constant's name (the
 * executed literal and the exported value are pinned separately, below).
 * The doc sites carry the command itself, so their mention is
 * `CHECKPOINT_TYPECHECK_CMD` — imported from src, so this file cannot drift
 * from what the driver runs (it used to spell the command a second time in a
 * local `CHECKPOINT_CMD`, which is the same two-sources-of-truth shape the
 * gate exists to catch).
 */
const CHECKPOINT_PROSE: readonly ProseEntry[] = [
  // The jsdoc above the checkpoint's command constant.
  ["extension/src/work-driver-cap-checkpoint.ts", "CHECKPOINT_TYPECHECK_CMD"],
  // The executed call, in the typecheck sibling the command was split into.
  ["extension/src/work-driver-cap-checkpoint-typecheck.ts", "CHECKPOINT_TYPECHECK_CMD"],
  // The handoff bullet both renderers print.
  ["extension/src/work-driver-caped-state.ts", "CHECKPOINT_TYPECHECK_CMD"],
  // The record type's own doc comment (type-only module — it names the
  // constant by reference rather than spelling the command, so it cannot
  // drift from what the driver runs).
  ["extension/src/workflow-state-cap.ts", "CHECKPOINT_TYPECHECK_CMD"],
  // Operator-facing docs: no constant is in scope, so they spell it out.
  ["AGENTS.md", CHECKPOINT_TYPECHECK_CMD],
  ["CONTRIBUTING.md", CHECKPOINT_TYPECHECK_CMD],
  ["docs/configuration.md", CHECKPOINT_TYPECHECK_CMD],
  [".pi/worktree-setup", CHECKPOINT_TYPECHECK_CMD],
];

const COMMAND_FILES: readonly HostFile[] = HEADLESS_FILES.filter((f) => f.kind === "command");

/**
 * The pinned launcher, read from the leaf that defines it rather than spelled
 * a second time here — a test that hard-codes the command is the same
 * two-sources-of-truth shape this gate exists to catch. Falls back to the
 * known-good spelling only if the definition is unreadable, so a broken
 * definition fails loudly below instead of silently disabling the rule.
 */
const LOCAL_TSC_TEXT = "node node_modules/typescript/bin/tsc";

/** A tier whose absence the driver treats as "no gate" rather than a missing file. */
function optionalTier(f: HostFile): boolean {
  return f.kind === "command" && !f.whenAbsent.includes("derive");
}

/**
 * Failures for one tier's text.
 *
 * `optional` is NOT a parameter here: whatever the driver does when a tier is
 * absent, a tier file that EXISTS must still carry a command. An empty
 * optional tier is a broken gate, not "no gate" — the ENOENT skip below is
 * the only place optionality applies.
 *
 * The bunx scan reads every line including comments on purpose: a tier that
 * mentions `bunx` in prose is the one a later editor copies from.
 */
function checkTier(rel: string, text: string): string[] {
  const fails: string[] = [];
  for (const line of text.split("\n")) {
    if (BARE_BUNX.test(line))
      fails.push(
        `${rel} uses bare \`bunx\` — \`bun x\` uses the binary that is always there: ${line.trim().slice(0, 120)}`,
      );
  }
  if (readFirstConfigLine(text) === undefined)
    fails.push(`${rel} has no command line — the driver would fall back to derivation`);
  return fails;
}

let exit = 0;
function report(fails: string[]) {
  for (const f of fails) {
    console.error(`✗ ${f}`);
    exit = 1;
  }
}

// The gate's own scope: a filter bug or a dropped entry would report a clean
// repo over tiers it never read.
if (COMMAND_FILES.length === 0 || !COMMAND_FILES.some((f) => f.path === ".pi/verify-cmd"))
  report([
    `derived scope [${COMMAND_FILES.map((f) => f.path).join(", ")}] must be non-empty and hold .pi/verify-cmd`,
  ]);

// The `optionalTier` split is derived from `whenAbsent`, so a rewording of
// that prose silently reclassifies the develop gate. Pinned explicitly.
const REQUIRED = COMMAND_FILES.filter((f) => !optionalTier(f)).map((f) => f.path);
if (!REQUIRED.includes(".pi/verify-cmd"))
  report([
    `.pi/verify-cmd must classify as required — got required tier(s) [${REQUIRED.join(", ")}]`,
  ]);

for (const f of COMMAND_FILES) {
  let text: string;
  try {
    text = readFileSync(path.join(REPO_ROOT, f.path), "utf8");
  } catch (err) {
    const code = typeof err === "object" && err && "code" in err ? String(err.code) : String(err);
    // Data, not a hard-coded name: `whenAbsent` is what the driver does.
    if (code === "ENOENT" && optionalTier(f)) {
      console.log(`· ${f.path} absent — ${f.whenAbsent}`);
      continue;
    }
    report([`${f.path} is NOT readable (${code})`]);
    continue;
  }
  report(checkTier(f.path, text));
}

// Fixture canaries: a gate never observed to fail is worthless (AGENTS.md §1).
// Counts are exact, not ">=1" — a canary that over-reports hides a rule that
// fires where it should not.
const CANARIES: Array<[string, string, number]> = [
  ["bare bunx", "# c\nbunx tsc --noEmit", 1],
  ["clean bun x", "cd extension && bun x tsc --noEmit", 0],
  ["comment-only tier", "# comment only\n\n   \n", 1],
  ["empty optional tier", "", 1],
  ["bunx in a comment is flagged", "# was: bunx tsc\nbun x tsc --noEmit", 1],
];
for (const [label, text, expected] of CANARIES) {
  const n = checkTier(".pi/verify-cmd", text).length;
  if (n === expected) console.log(`✓ canary ${label}: ${n} failure(s)`);
  else report([`GATE-BROKEN: canary ${label} expected ${expected} failures, got ${n}`]);
}

// --------------------------- #1414: the prose list (driver code + operator docs)

/**
 * Failures for one prose file: the bare alias on any line (comments
 * included, same rule as the tiers — a doc that mentions `bunx` in prose is
 * the one a later reader copies), plus the checkpoint-command substrings.
 */
function checkProse(rel: string, text: string): string[] {
  const fails: string[] = [];
  for (const line of text.split("\n")) {
    if (BARE_BUNX.test(line))
      fails.push(
        `${rel} uses bare \`bunx\` — \`bun x\` uses the binary that is always there: ${line.trim().slice(0, 120)}`,
      );
    // #1414/#1118 — a launcher-routed tsc is the bug that made the typecheck
    // gate a no-op. Comments are exempt (see `isComment`) so the text that
    // explains the bug is not itself the failure.
    if (prescribesRunning(line))
      fails.push(
        `${rel} runs tsc through a launcher instead of the project's own compiler — \`${LOCAL_TSC_TEXT}\`: ${line.trim().slice(0, 120)}`,
      );
  }
  for (const [file, mention] of CHECKPOINT_PROSE) {
    if (file !== rel) continue;
    if (!text.includes(mention))
      fails.push(
        `${rel} does not name the checkpoint command — expected \`${mention}\` (the checkpoint runs \`${CHECKPOINT_TYPECHECK_CMD}\`)`,
      );
  }
  return fails;
}

// The scope lists themselves: a dropped entry would report a clean repo over
// files it never read, and a dead exemption hides a typo in a live one.
if (PROSE_FILES.length < 8)
  report([`prose scope [${PROSE_FILES.join(", ")}] must cover the 4 src files + 4 doc sites`]);
for (const [file] of CHECKPOINT_PROSE) {
  if (!PROSE_FILES.includes(file))
    report([`${file} must be in PROSE_FILES — its prose is pinned but not bunx-scanned`]);
}
for (const rel of EXEMPT_FILES) {
  let text: string;
  try {
    text = readFileSync(path.join(REPO_ROOT, rel), "utf8");
  } catch {
    report([`exempt file ${rel} is NOT readable — the exemption names a path that is gone`]);
    continue;
  }
  if (!BARE_BUNX.test(text))
    report([
      `exempt file ${rel} no longer carries \`bunx\` — dead exemption; drop it or fix the file`,
    ]);
}

for (const rel of PROSE_FILES) {
  let text: string;
  try {
    text = readFileSync(path.join(REPO_ROOT, rel), "utf8");
  } catch (err) {
    const code = typeof err === "object" && err && "code" in err ? String(err.code) : String(err);
    report([`${rel} is NOT readable (${code})`]);
    continue;
  }
  report(checkProse(rel, text));
}

// The exported literal, the executed call and the prose must be ONE string.
// Reading the SOURCE rather than trusting the constant is what makes this a
// drift gate: a rewrite of either site alone is caught. Both patterns are
// whitespace-tolerant — the two sites now live in different files and are
// formatted by Biome, so a line-wrap or an added argument used to fail the
// gate over formatting and, worse, a `\s*`-less match on the call would pass
// if someone wrote `run( CHECKPOINT_TYPECHECK_CMD,`.
{
  const typecheckSrc = readFileSync(
    path.join(REPO_ROOT, "extension/src/work-driver-cap-checkpoint-typecheck.ts"),
    "utf8",
  );
  const ckptSrc = readFileSync(
    path.join(REPO_ROOT, "extension/src/work-driver-cap-checkpoint.ts"),
    "utf8",
  );
  // The constant is a TEMPLATE literal (`${LOCAL_TSC} --noEmit -p ${TSC_PROJECT}`),
  // so a value-pinned regex can never match its declaration — the earlier
  // `CHECKPOINT_TYPECHECK_CMD\s*=\s*"<literal>"` pattern was written for the
  // pre-#1414 shape, when the command was one quoted string, and after the
  // #1414 fix it could only ever fail. Checking the VALUE instead means
  // pinning the pieces it is built from: the exported launcher constant must
  // be the pinned path, and the template must interpolate exactly the two
  // flags the bug was about (`--noEmit`, not the `--no-emit` that tsc accepts
  // as a prefix-matched abbreviation and silently treats differently).
  const localDefinitionRe = /\bCHECKPOINT_TYPECHECK_CMD\s*=\s*`\$\{LOCAL_TSC\}\s+--noEmit\s+-p\s+\$\{TSC_PROJECT\}`/;
  // The exact source text the pattern matches, shared with the duplicate-
  // definition canary below so the fixture and the rule cannot drift apart.
  const PINNED_TEMPLATE_LITERAL = "`" + "${LOCAL_TSC} --noEmit -p ${TSC_PROJECT}" + "`";
  if (!localDefinitionRe.test(typecheckSrc))
    report([
      `exported CHECKPOINT_TYPECHECK_CMD is not built from \`\${LOCAL_TSC} --noEmit -p \${TSC_PROJECT}\` — the launcher or the flags drifted (\`${LOCAL_TSC_TEXT}\`)`,
    ]);
  const localTscRe = /\bLOCAL_TSC_CMD\s*=\s*LOCAL_TSC\b/;
  if (!localTscRe.test(typecheckSrc))
    report([
      `the typecheck leaf no longer exports LOCAL_TSC_CMD from LOCAL_TSC — the .pi tiers and the checkpoint must share one spelling`,
    ]);
  const localValueRe = new RegExp(`const LOCAL_TSC\\s*=\\s*["']${escapeRe(LOCAL_TSC_TEXT)}["']`);
  if (!localValueRe.test(typecheckSrc))
    report([
      `LOCAL_TSC is not \`${LOCAL_TSC_TEXT}\` — the driver would resolve tsc through something other than the project's own compiler`,
    ]);
  // #1414 round 3 — the DEFINITION moved to the typecheck leaf (a leaf cannot
  // value-import from its own consumer; that was the runtime cycle), and the
  // checkpoint module keeps a RE-EXPORT so the file whose jsdoc explains the
  // spelling stays stable. Two more assertions follow from that shape: the
  // re-export is present, and the checkpoint has NOT grown its own copy.
  const reExportRe =
    /export\s*\{[^}]*\bCHECKPOINT_TYPECHECK_CMD\b[^}]*\}\s*from\s*["']\.\/work-driver-cap-checkpoint-typecheck\.ts["']/;
  if (!reExportRe.test(ckptSrc))
    report([
      `work-driver-cap-checkpoint.ts no longer re-exports CHECKPOINT_TYPECHECK_CMD from the typecheck leaf — the gate reads the literal's rationale from that file`,
    ]);
  if (localDefinitionRe.test(ckptSrc))
    report([
      `work-driver-cap-checkpoint.ts defines CHECKPOINT_TYPECHECK_CMD itself — the constant belongs in the typecheck leaf (a local copy is the drift this gate catches, and re-introduces the import cycle)`,
    ]);
  // The executed call lives in the typecheck leaf alongside the constant
  // (#1414 round 2 split it out; round 3 moved the constant in with it).
  const callRe = /\brun\s*\(\s*CHECKPOINT_TYPECHECK_CMD\s*,/;
  if (!callRe.test(typecheckSrc))
    report([
      `typecheckWorktree no longer executes CHECKPOINT_TYPECHECK_CMD — the literal may have drifted from the prose`,
    ]);
  // Canaries for THIS half of the gate, in both directions: a planted bad
  // literal is caught, the fixed form is not, and a REFORMATTED-but-correct
  // pair of sites still passes (a whitespace-intolerant pattern fails on
  // layout, which trains people to weaken the gate rather than fix the drift).
  const planted = typecheckSrc.replace(
    localDefinitionRe,
    "CHECKPOINT_TYPECHECK_CMD = `bunx tsc --no-emit`",
  );
  if (localDefinitionRe.test(planted))
    report(["GATE-BROKEN: a planted bad checkpoint literal was NOT caught"]);
  else console.log("✓ canary planted bad checkpoint literal: caught");
  const droppedReExport = ckptSrc.replace(
    reExportRe,
    `export { typecheckWorktree } from "./work-driver-cap-checkpoint-typecheck.ts";`,
  );
  if (reExportRe.test(droppedReExport))
    report(["GATE-BROKEN: a deleted checkpoint re-export was NOT caught"]);
  else console.log("✓ canary deleted checkpoint re-export: caught");
  // Mutation directions for the duplicate-definition rule, one per check:
  //
  //   - `exportRe` pins the VALUE. It fires when the checkpoint file carries a
  //     `CHECKPOINT_TYPECHECK_CMD = "<literal>"` assignment, so the fixture
  //     plants exactly that and the check MUST match it.
  //   - `constRe` pins the NAME. It fires on any assignment whatever its
  //     value — the case `exportRe` is blind to, a planted local copy that
  //     reuses the correct spelling (which is how the cycle would re-open with
  //     the right command and no gate noticing).
  //
  // The live checkpoint file must trip NEITHER: it re-exports, it does not
  // define. (Note the direction: the earlier `planted` canary above asserts
  // the opposite sense, because there the fixture carries a BAD literal and a
  // value-pinned pattern correctly refuses to match it.)
  // The planted copy is written in the SAME shape the leaf uses — a template
  // over the two pieces — because that is the duplicate a reader would
  // actually write, and it is the shape `localDefinitionRe` is looking for.
  // Planting the resolved string instead makes a working pattern look broken.
  const duplicateConst =
    ckptSrc + "\nconst CHECKPOINT_TYPECHECK_CMD = " + PINNED_TEMPLATE_LITERAL + ";";
  if (!localDefinitionRe.test(duplicateConst))
    report(["GATE-BROKEN: a second local definition of the checkpoint literal was NOT caught"]);
  else console.log("✓ canary duplicate local checkpoint literal: caught");
  const duplicateBadValue = `${ckptSrc}\nconst CHECKPOINT_TYPECHECK_CMD = "bun x tsc --noEmit --someOtherFlag";`;
  const constRe = /\bCHECKPOINT_TYPECHECK_CMD\s*=/;
  if (!constRe.test(duplicateBadValue))
    report(["GATE-BROKEN: a value-agnostic duplicate-definition check did not fire"]);
  else console.log("✓ canary duplicate local checkpoint literal (value-agnostic): caught");
  if (constRe.test(ckptSrc))
    report([
      `work-driver-cap-checkpoint.ts contains a \`CHECKPOINT_TYPECHECK_CMD =\` assignment — the constant must be re-exported from the leaf, never defined here (see the cycle note in the module header)`,
    ]);
  // The definition must stay in the LEAF. Deleting the leaf's `const` — the
  // shape of someone moving it back to the checkpoint module and leaving the
  // leaf to import it — has to fail, or the value-pinned check above would go
  // on reading a file that no longer defines anything.
  const leafDeleted = typecheckSrc.replace(localDefinitionRe, `/* moved */`);
  if (localDefinitionRe.test(leafDeleted))
    report(["GATE-BROKEN: a deleted definition in the typecheck leaf was NOT caught"]);
  else console.log("✓ canary deleted leaf definition: caught");
  const wrapped = typecheckSrc.replace(callRe, "run(\n        CHECKPOINT_TYPECHECK_CMD,");
  if (!callRe.test(wrapped))
    report(["GATE-BROKEN: a line-wrapped (but correct) executed call was flagged as drift"]);
  else console.log("✓ canary wrapped executed call: still accepted");
  if (
    checkProse("extension/src/sentinel.ts", `const c = "${CHECKPOINT_TYPECHECK_CMD}";`).length !== 0
  )
    report(["GATE-BROKEN: the fixed checkpoint form was flagged as bad"]);
  else console.log("✓ canary fixed checkpoint form: not flagged");
}

console.log(exit === 0 ? "\nAll verify-cmd bunx checks passed." : "\nFAILED");
process.exit(exit);
