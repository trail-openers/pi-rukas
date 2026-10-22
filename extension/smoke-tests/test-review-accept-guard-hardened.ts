#!/usr/bin/env bun
/**
 * #1125 — the deny-by-default accept guard: the exact read-only allowlist, and the
 * over-refusals clause (b) accepts as the cost of failing closed.
 *
 * There are no route-specific reasons any more: every refusal carries the SAME base
 * text (the accept CLI is the sanctioned path), plus one of two remedy sentences —
 * the vcs sentence when a write-capable flag is present, the data sentence when the
 * refusal is a path-operand one. Those two sentences are asserted here, once.
 *
 * The base refusals (the operator script, the edit tools) are covered in
 * test-review-accept.ts and test-review-accept-layers.ts. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// `import.meta.url` rather than `import.meta.dir`: this suite is run under both bun and
// node, and only bun defines `dir`.
const HERE = dirname(fileURLToPath(import.meta.url));
import { armForgeRead, armGitRead } from "../src/review-accept-arms.ts";
import {
  editsFindingsFile,
  registerReviewAcceptGuard,
  runsReviewAccept,
} from "../src/review-accept-guard.ts";
import {
  ALLOWANCES,
  DENY_BY_DEFAULT_REFUSALS,
  MANDATED_REFUSALS,
  ORDINARY_AGENT_COMMANDS,
  OUT_OF_SCOPE_ALLOWED,
  OVER_REFUSALS,
  SIBLING_REFUSALS,
  SPELLING_REFUSALS,
} from "./review-accept-guard-cases.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The store's data file and the store module, spelled out once for every table. */
const DATA = "review-findings.json";
const STORE = "review-findings-store";
const NL = String.fromCharCode(10);
const Q = String.fromCharCode(39);

/** Verdict, computed once per case and asserted against a literal expectation. */
function refused(c: string): boolean {
  return runsReviewAccept(c) !== undefined;
}

/** The repo's own develop gate, arm by arm, so the guard is proven not to block it. */
function verifyCmdArms(): string[] {
  const file = join(HERE, "..", "..", ".pi", "verify-cmd");
  const body = readFileSync(file, "utf8");
  const lines = body
    .split(NL)
    .filter((l) => l.trim() && !l.trim().startsWith("#"))
    .join(NL);
  return lines
    .split("&&")
    .map((arm) => arm.replace(/^cd \S+$/, "").trim())
    .filter((arm) => arm && !arm.startsWith("cd ") && !arm.startsWith("bun run check"));
}

// ── 3. every case list asserted through the guard ───────────────────────────────
//
// The per-ARM predicates are asked one segment at a time in
// test-review-accept-arms-direct.ts; here each whole command goes through the guard.

for (const t of ALLOWANCES) assert(!refused(t.c), `allowed — ${t.why}`);
for (const t of ORDINARY_AGENT_COMMANDS)
  assert(!refused(t.c), `ordinary agent command stays allowed — ${t.why}`);
for (const t of OUT_OF_SCOPE_ALLOWED) assert(!refused(t.c), `out of the rule's scope — ${t.why}`);
for (const t of MANDATED_REFUSALS) assert(refused(t.c), `mandated refusal — ${t.why}`);
for (const t of DENY_BY_DEFAULT_REFUSALS) assert(refused(t.c), `refused — ${t.why}`);
for (const t of OVER_REFUSALS) assert(refused(t.c), `known over-refusal — ${t.why}`);
for (const t of SIBLING_REFUSALS) assert(refused(t.c), `known over-refusal — ${t.why}`);
for (const t of SPELLING_REFUSALS) assert(refused(t.c), `spelling refusal — ${t.why}`);

// The repo's own develop gate is allowed verbatim.
for (const arm of verifyCmdArms())
  assert(!refused(arm), `.pi/verify-cmd arm allowed — ${arm.slice(0, 60)}`);

// ── the edit tools ────────────────────────────────────────────────────────────
const storeFile = `/repo/.git/${DATA}`;
/** A sibling of a protected name: any dotted suffix reaches the store's bytes. */
const siblingEdits: Array<[string, string]> = [
  [`${storeFile}.corrupt-123`, "write of a corrupt-copy sibling"],
  [`${storeFile}.tmp`, "multiedit of a .tmp sibling"],
  [`${storeFile}.bak`, "a .bak sibling (#1125: any dotted suffix is a sibling)"],
  [`${storeFile}.corrupt`, "a .corrupt sibling with no numeric suffix"],
  ["/repo/.git/review-findings-store.tmp", "a .tmp sibling of the store module"],
];
assert(editsFindingsFile("edit", { path: storeFile }) === storeFile, "edit of the findings file");
for (const [path, why] of siblingEdits)
  assert(editsFindingsFile("write", { path }) !== undefined, `sibling refused — ${why}`);
assert(
  editsFindingsFile("edit", { path: "/repo/extension/src/review-findings-store.ts" }) !== undefined,
  "edit of the store module's own source is refused (#1125)",
);
assert(
  editsFindingsFile("multiedit", { path: "/repo/src/a.ts" }) === undefined,
  "edit of an unrelated file is allowed",
);
assert(editsFindingsFile("read", { path: storeFile }) === undefined, "reading is not an edit");
assert(
  editsFindingsFile("write", { path: "/repo/src/review-accept-guard.ts" }) === undefined,
  "editing the guard itself is allowed",
);
assert(
  // clause (b): the stem-prefix rule refuses a word that merely STARTS with either name.
  editsFindingsFile("write", { path: "/repo/src/review-findings.jsonx" }) !== undefined &&
    editsFindingsFile("write", { path: "/repo/src/review-acceptance-notes.md" }) !== undefined,
  "a word merely STARTING with a protected stem is refused as a sibling",
);
// The throwing `path` getter, the trailing/`..` spellings, the CASE spellings and the
// guard module's own editability are asked of the edit path DIRECTLY in the arms-direct
// suite (#1125), where no guard step sits above them.

// ── the hook: one base reason, plus at most the two remedy sentences ────────────
const handlers: Record<string, (e: unknown, c: unknown) => Promise<unknown>> = {};
registerReviewAcceptGuard({
  on: (ev: string, fn: (e: unknown, c: unknown) => Promise<unknown>) => {
    handlers[ev] = fn;
  },
} as never);

assert(typeof handlers.tool_call === "function", "hook: a tool_call handler is registered");

const call = async (command: string) =>
  (await handlers.tool_call?.({ toolName: "bash", input: { command } }, {})) as
    | { block?: boolean; reason?: string }
    | undefined;

const VCS_SENTENCE = "-o/--output/-c";
const DATA_SENTENCE = "path operand naming the store";

const writeBlocked = await call(`git show HEAD:blob --output=${DATA}`);
assert(
  writeBlocked?.block === true && (writeBlocked.reason ?? "").includes(VCS_SENTENCE),
  "hook: the vcs route names the write-capable argument to drop",
);
assert(
  (writeBlocked?.reason ?? "").includes("git --no-pager log"),
  "hook: the vcs remedy carries no -c in its example",
);
const dataBlocked = await call(`git add ${DATA}`);
assert(
  dataBlocked?.block === true &&
    (dataBlocked.reason ?? "").includes(DATA_SENTENCE) &&
    !(dataBlocked.reason ?? "").includes(VCS_SENTENCE),
  "hook: the data route speaks of path operands, not of write flags",
);
const runtimeBlocked = await call(`bun -e ${Q}import("./src/${STORE}.ts")${Q}`);
assert(
  runtimeBlocked?.block === true &&
    !(runtimeBlocked.reason ?? "").includes(VCS_SENTENCE) &&
    !(runtimeBlocked.reason ?? "").includes(DATA_SENTENCE),
  "hook: the runtime route adds neither remedy sentence",
);
for (const command of [
  "bun extension/scripts/review-accept.ts feat/x deadbeef --reason x",
  `bun <<EOF${NL}import { acceptFinding } from "./src/${STORE}.ts"${NL}EOF`,
]) {
  const v = await call(command);
  assert(
    v?.block === true && (v.reason ?? "").includes("extension/scripts/review-accept.ts"),
    `hook: every refusal names the sanctioned accept CLI — ${command.slice(0, 32)}`,
  );
}

for (const command of [
  `git commit -m "clean up the ${DATA} handling"`,
  "gh pr view 1105",
  `bun test smoke-tests/test-${STORE}*.ts`,
]) {
  const verdict = await call(command);
  assert(verdict === undefined, `hook: leaves the allowed form alone — ${command.slice(0, 44)}`);
}

const blockedRead = await call(`git show HEAD:blob --output=${DATA}`);
const cleanRead = await call("git show HEAD:README.md");
assert(
  blockedRead?.block === true && cleanRead === undefined,
  "hook: the same read is allowed once the write-capable argument is gone",
);

process.exit(exit);
