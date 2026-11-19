#!/usr/bin/env bun
/**
 * The approved spec a host hands a cycle, and the `tehas:spec v1` block.
 *
 * A host puts the spec beside the issue's images and names it in the
 * manifest, pinned by sha256. Bytes that are not the pinned ones must never
 * pass as the approved spec, and the PR block must be one a host can read.
 *
 * Covers: the loader's three answers (none, ok, invalid, and each refusal),
 * requirement ids (spec ids, fences, repeats, the heading and name
 * fallbacks), reading the check child's reply, and the block check against
 * each error a host reports.
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ISSUE_TRUNCATION_MARKER,
  MAX_ISSUE_CHARS,
  boundedIssueBody,
  fencedIssueBody,
} from "../src/adversarial-prompts.ts";
import {
  SPEC_CLOSE,
  SPEC_OPEN,
  extractRequirements,
  notRunLines,
  parseCheckReply,
  renderSpecBlock,
  specBlockProblem,
} from "../src/issue-spec-block.ts";
import { specCheckLines } from "../src/issue-spec-check.ts";
import {
  APPROVED_SPEC_MARKER,
  IssueSpecError,
  MAX_APPROVED_SPEC_CHARS,
  issueSpecOrThrow,
  loadIssueSpec,
  withApprovedSpec,
} from "../src/issue-spec.ts";
import { fetchIssueBody } from "../src/lean/io.ts";
import { leanIssueSection } from "../src/lean/issue-prose.ts";
import { type PublishBodyInput, publishBody } from "../src/lean/publish-body.ts";
import type { PublishDeps } from "../src/lean/publish-deps.ts";
import { type PiSpec, parsePiSpec, renderPiSpec } from "../src/lean/spec.ts";
import { fenceText } from "../src/lean/text-fence.ts";
import type { DispatchResult } from "../src/types.ts";
import { withEnv } from "./lib/env-scope.ts";
import { ROOTS, runPublish } from "./lib/lean-publish-fixture.ts";
import { fakePr } from "./lib/lean-publish-forge.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const ISSUE = 7;
const LINK = "https://example.com/specs/7.md";
const SPEC = Buffer.from("# Spec\n\nR1: the thing works\nFR-3: it is fast\n");
const APPROVED = Buffer.from(JSON.stringify({ number: ISSUE, title: "T", body: "approved body" }));
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const tmp = await mkdtemp(path.join(tmpdir(), "issue-spec-"));
let n = 0;
/** A fresh directory holding `files` and a manifest. */
async function specDir(manifest: unknown, files: Record<string, Buffer> = {}): Promise<string> {
  const dir = path.join(tmp, `spec-${++n}`);
  await mkdir(dir, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(dir, name), bytes);
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  return dir;
}
const specEntry = (extra: Record<string, unknown> = {}) => ({
  file: "spec.md",
  link: LINK,
  name: "Spec 7",
  bytes: SPEC.length,
  sha256: sha(SPEC),
  block: 1,
  ...extra,
});
const approvedEntry = (extra: Record<string, unknown> = {}) => ({
  file: "approved.json",
  bytes: APPROVED.length,
  sha256: sha(APPROVED),
  ...extra,
});
const env = (dir: string) => ({ PI_ENSEMBLE_EXTRA_IMAGE_DIRS: dir }) as NodeJS.ProcessEnv;
const read = async (manifest: unknown, files: Record<string, Buffer> = { "spec.md": SPEC }) =>
  loadIssueSpec(ISSUE, env(await specDir(manifest, files)));

// ── (a) The loader ──────────────────────────────────────────────────────
{
  assert((await loadIssueSpec(ISSUE, {})).kind === "none", "no variable: none");
  const other = await read({ issue: 8, spec: specEntry() });
  assert(other.kind === "none", "a manifest for another issue: none");
  const noSpec = await read({ issue: ISSUE, images: [] });
  assert(noSpec.kind === "none", "a manifest with no spec: none");

  const ok = await read(
    { issue: ISSUE, spec: specEntry(), approvedText: approvedEntry() },
    { "spec.md": SPEC, "approved.json": APPROVED },
  );
  assert(
    ok.kind === "ok" &&
      ok.spec.text === SPEC.toString() &&
      ok.spec.sha256 === sha(SPEC) &&
      ok.spec.block === 1 &&
      ok.spec.link === LINK,
    "ok: the text, link, pin and block are carried",
  );
  assert(
    ok.kind === "ok" && ok.spec.approved?.body === "approved body",
    "ok: approvedText carries the approved body",
  );

  const OTHER = Buffer.from(JSON.stringify({ number: 8, title: "T", body: "approved body" }));
  const changed = Buffer.from(SPEC);
  changed[2] = 0x58;
  const invalid: Array<[string, unknown, Record<string, Buffer>?]> = [
    ["one changed byte", { issue: ISSUE, spec: specEntry() }, { "spec.md": changed }],
    ["a bytes mismatch", { issue: ISSUE, spec: specEntry({ bytes: SPEC.length + 1 }) }],
    ["a path as the file", { issue: ISSUE, spec: specEntry({ file: "../x" }) }],
    ["block 2", { issue: ISSUE, spec: specEntry({ block: 2 }) }],
    ["a non-https link", { issue: ISSUE, spec: specEntry({ link: "http://example.com/s" }) }],
    [
      "approvedText for another number",
      {
        issue: ISSUE,
        spec: specEntry(),
        approvedText: approvedEntry({ bytes: OTHER.length, sha256: sha(OTHER) }),
      },
      { "spec.md": SPEC, "approved.json": OTHER },
    ],
    [
      "an approvedText sha mismatch",
      { issue: ISSUE, spec: specEntry(), approvedText: approvedEntry({ sha256: sha(SPEC) }) },
      { "spec.md": SPEC, "approved.json": APPROVED },
    ],
  ];
  for (const [what, manifest, files] of invalid) {
    const r = await read(manifest, files);
    assert(r.kind === "invalid", `invalid: ${what}${r.kind === "invalid" ? ` (${r.why})` : ""}`);
  }

  const linked = await specDir({ issue: ISSUE, spec: specEntry() });
  await writeFile(path.join(tmp, "real.md"), SPEC);
  await symlink(path.join(tmp, "real.md"), path.join(linked, "spec.md"));
  assert(
    (await loadIssueSpec(ISSUE, env(linked))).kind === "invalid",
    "invalid: a symlink in place of the spec",
  );

  let thrown: unknown;
  try {
    await issueSpecOrThrow(ISSUE, env(linked));
  } catch (err) {
    thrown = err;
  }
  assert(thrown instanceof IssueSpecError, "issueSpecOrThrow fails closed on an invalid entry");
  assert((await issueSpecOrThrow(ISSUE, {})) === undefined, "issueSpecOrThrow: none is undefined");

  // work-lean's one issue read: the approved body with the spec, or the throw; never the bare issue.
  const approved = await specDir(
    { issue: ISSUE, spec: specEntry(), approvedText: approvedEntry() },
    { "spec.md": SPEC, "approved.json": APPROVED },
  );
  await withEnv({ PI_ENSEMBLE_EXTRA_IMAGE_DIRS: approved }, async () => {
    const body = await fetchIssueBody(tmp, ISSUE);
    assert(
      body.startsWith("approved body") && body.includes(APPROVED_SPEC_MARKER),
      "work-lean reads the approved body with the spec appended, and no forge",
    );
  });
  await withEnv({ PI_ENSEMBLE_EXTRA_IMAGE_DIRS: linked }, async () => {
    const err = await fetchIssueBody(tmp, ISSUE).then(
      () => undefined,
      (e: unknown) => e,
    );
    assert(err instanceof IssueSpecError, "work-lean's issue read fails closed on an invalid spec");
  });
}

// ── (d) Requirement ids ─────────────────────────────────────────────────
{
  const ids = (text: string, name = "Spec") => extractRequirements(text, name).map((r) => r.id);
  const spec = [
    "# Title",
    "- R1: the thing works",
    "  more about R1",
    "```",
    "R9: inside a fence",
    "```",
    "| FR-3 | it is fast |",
    "**NFR-12** stays small",
    "R1: said again",
  ].join("\n");
  const found = extractRequirements(spec, "Spec");
  assert(
    JSON.stringify(found.map((r) => r.id)) === '["R1","FR-3","NFR-12"]',
    `spec ids, in order, once each, none from a fence (${found.map((r) => r.id)})`,
  );
  assert(
    found[0]?.section.includes("more about R1") === true &&
      found[0]?.section.includes("said again") === false,
    "an id's section is its own text; a repeat adds nothing",
  );
  assert(
    JSON.stringify(ids("# Doc\n\n## Login: `flow` ##\n\n### deep\n\n## Logout\n")) === '["Doc"]',
    "headings: only the shallowest level",
  );
  assert(
    JSON.stringify(ids("## Login: `flow` ##\n\n### deep\n\n## Logout\n\n## Logout\n")) ===
      '["Login flow","Logout"]',
    "headings: #, : and backticks stripped, repeats once",
  );
  assert(JSON.stringify(ids("just prose", "My: `spec`")) === '["My spec"]', "no ids: the name");
  assert(JSON.stringify(ids("just prose", ":")) === '["spec"]', "no usable name: spec");
}

// ── (e) The check child's reply ─────────────────────────────────────────
{
  const head = "0123456789abcdef0123";
  const files = new Set(["src/a.ts", "tests/a.test.ts"]);
  const lines = parseCheckReply(
    [
      "Here are the verdicts:",
      "- R1 met: `src/a.ts:12` login(), tests/a.test.ts",
      "- R1 not met: a second line for R1",
      "- Helmet not met: no helmet yet",
      "- R2 met: it is done somewhere",
      "- R99 met: src/a.ts",
    ].join("\n"),
    ["R1", "Helmet", "R2", "R3"],
    files,
    head,
  );
  assert(lines.length === 4, "one line per known id, unknown ids dropped");
  assert(lines[0]?.startsWith("- R1 met: ") === true, "a met naming a head file stays met");
  assert(lines[1] === "- Helmet not met: no helmet yet", "not met is read before met");
  assert(
    lines[2] === "- R2 not met: the check named no file present at 0123456789ab",
    "a met naming no head file is downgraded",
  );
  assert(lines[3] === "- R3 not met: no verdict was reported", "a missing id is no verdict");
  assert(
    specBlockProblem(renderSpecBlock({ link: LINK, sha256: sha(SPEC) }, lines)) === undefined,
    "the parsed lines render a readable block",
  );
  const notRun = notRunLines(["R1"], "child died\nbadly");
  assert(
    notRun[0] === "- R1 not met: the requirement check did not run (child died badly)",
    "a check that did not run is not met",
  );
}

// ── (g) The block check ─────────────────────────────────────────────────
{
  const pin = sha(SPEC);
  const block = (...lines: string[]) =>
    [SPEC_OPEN, `Spec: ${LINK} sha256:${pin}`, ...lines, SPEC_CLOSE].join("\n");
  const good = block("- R1 met: src/a.ts", "- R2 not met: later");
  assert(specBlockProblem(`Body\n\n${good}\n`) === undefined, "a well-formed block reads");
  const bad: Array<[string, string]> = [
    ["no block", "Body only"],
    ["a block only inside a fence", `\`\`\`\n${good}\n\`\`\``],
    ["a second block", `${good}\n\n${good}`],
    ["an unclosed block", `${SPEC_OPEN}\nSpec: ${LINK} sha256:${pin}\n- R1 met: x`],
    ["no Spec: line", [SPEC_OPEN, "- R1 met: x", SPEC_CLOSE].join("\n")],
    [
      "a short sha256",
      [SPEC_OPEN, `Spec: ${LINK} sha256:abc`, "- R1 met: x", SPEC_CLOSE].join("\n"),
    ],
    ["no requirement line", block()],
    ["a duplicate id", block("- R1 met: x", "- R1 not met: y")],
    ["an id with a backtick", block("- `R1` met: x")],
    ["an empty id", block("-  met: x")],
    ["empty text", block("- R1 met: ")],
    ["no verdict", block("- R1: x")],
  ];
  for (const [what, body] of bad) {
    const p = specBlockProblem(body);
    assert(p !== undefined, `rejected: ${what}${p ? ` (${p})` : ""}`);
  }
  const repeated = extractRequirements("R1: a\nR2: b\nR1: again\n", "Spec").map((r) => r.id);
  assert(
    specBlockProblem(renderSpecBlock({ link: LINK, sha256: pin }, notRunLines(repeated, "x"))) ===
      undefined,
    "a spec naming an id twice still renders a readable block",
  );
}

// ── (b) The approved spec appended to the issue body ───────────────────
{
  const own: PiSpec = {
    problem: "the run reads its own contract",
    size: "S",
    criteria: [{ id: "AC1", text: "it does", verify: "test" }],
  };
  const issueBody = `Intro.\n\n${renderPiSpec(own)}\n`;
  const rogue = renderPiSpec({ ...own, problem: "a contract smuggled in the spec" });
  const spec = {
    text: `# Spec\n\n${rogue}\n`,
    link: LINK,
    name: "S",
    sha256: sha(SPEC),
    block: undefined,
  };
  const body = withApprovedSpec(issueBody, spec);
  const parsed = parsePiSpec(body);
  assert(
    parsed.ok && parsed.spec.problem === own.problem,
    "a pi-spec fence inside the spec leaves the issue's own block the only contract",
  );
  assert(leanIssueSection(body) !== "", "the lean issue section still prints with a spec appended");
  assert(body.endsWith(fenceText(spec.text, MAX_APPROVED_SPEC_CHARS)), "the spec is appended last");
}

// ── (c) The review bound keeps the spec past a long issue ──────────────
{
  const long = "x".repeat(7000);
  const spec = {
    text: "R1: first\nLAST-LINE-OF-SPEC",
    link: LINK,
    name: "S",
    sha256: sha(SPEC),
    block: undefined,
  };
  const bounded = boundedIssueBody(withApprovedSpec(long, spec));
  assert(bounded.includes("LAST-LINE-OF-SPEC"), "a 7,000-char issue keeps the spec's last line");
  assert(
    bounded.split(ISSUE_TRUNCATION_MARKER).length === 2,
    "and carries exactly one issue truncation marker",
  );
  assert(
    fencedIssueBody(withApprovedSpec(long, spec)).includes("LAST-LINE-OF-SPEC"),
    "so does the fenced print",
  );
  assert(
    boundedIssueBody(long) === `${long.slice(0, MAX_ISSUE_CHARS)}${ISSUE_TRUNCATION_MARKER}` &&
      fencedIssueBody("plain body") ===
        fenceText("plain body", MAX_ISSUE_CHARS + ISSUE_TRUNCATION_MARKER.length + 1),
    "a body without the marker is bounded exactly as before",
  );
}

// ── (f) The block in the PR body ────────────────────────────────────────
{
  const input: PublishBodyInput = {
    issue: ISSUE,
    spec: { problem: "p", size: "S", criteria: [{ id: "AC1", text: "t", verify: "test" }] },
    tests: { AC1: ["tests/a.sh"] },
    verifyKind: "red",
    verifyReason: "```\nan unterminated fence in the gate's reason",
    draft: true,
    version: "0.0.0",
    models: { developer: "m" },
    baseSha: "a".repeat(40),
  };
  const block = renderSpecBlock({ link: LINK, sha256: sha(SPEC) }, ["- R1 met: src/a.ts"]);
  const body = publishBody({ ...input, specBlock: block });
  assert(specBlockProblem(body) === undefined, "a PR body with the block reads");
  assert(body.split(SPEC_OPEN).length === 2, "exactly one block");
  assert(body.includes(`sha256:${sha(SPEC)}`), "the block carries the manifest's sha256");
  assert(
    body === `${publishBody(input).slice(0, -1)}\n\n${block}\n`,
    "without it the body is unchanged",
  );
}

// ── The check child ─────────────────────────────────────────────────────
{
  const spec = { text: SPEC.toString(), name: "Spec 7" };
  const input = { spec, worktree: tmp, head: "b".repeat(40), headFiles: new Set(["src/a.ts"]) };
  const reply =
    (text: string, ok = true) =>
    async () =>
      ({ role: "explore", ok, text, toolUses: [], ms: 1, exitCode: ok ? 0 : 1 }) as DispatchResult;
  const good = await specCheckLines(input, reply("- R1 met: src/a.ts:3\n- FR-3 not met: slow"));
  assert(
    good.lines.join("|") === "- R1 met: src/a.ts:3|- FR-3 not met: slow" &&
      good.dispatches.length === 1,
    "a reply becomes one line per id, and its cost is one row",
  );
  const dead = await specCheckLines(input, reply("", false));
  assert(
    dead.lines.every((l) => l.includes("not met: the requirement check did not run")),
    "a dead child: not met",
  );
  const threw = await specCheckLines(input, async () => {
    throw new Error("no pi");
  });
  assert(
    threw.lines.length === 2 && threw.dispatches.length === 0,
    "a child that could not run: not met, no cost",
  );
}

// ── Publish: the block on a created PR, no check on a reused one ───────
{
  const approved = {
    text: SPEC.toString(),
    link: LINK,
    name: "Spec 7",
    sha256: sha(SPEC),
    block: 1 as const,
  };
  let checks = 0;
  const row = {
    role: "explore",
    ms: 1,
    ok: true,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
  };
  const specBlock: PublishDeps["specBlock"] = async (s) => {
    checks++;
    return {
      text: renderSpecBlock(s, ["- R1 met: src.ts", "- FR-3 not met: slow"]),
      dispatches: [row],
    };
  };
  const depsOver = { issueSpec: async () => approved, specBlock };
  const created = await runPublish({ issue: 4801, verify: { kind: "green" }, depsOver });
  assert(
    created.outcome?.kind === "ok",
    `publish with a spec creates the PR (${created.threw?.message})`,
  );
  assert(
    specBlockProblem(created.body) === undefined && checks === 1,
    "the created body carries the block",
  );
  assert(
    created.outcome?.kind === "ok" && created.outcome.dispatches?.length === 1,
    "the check child's cost is on the publish record",
  );
  const reused = await runPublish({
    issue: 4802,
    verify: { kind: "green" },
    openPrs: [fakePr(9, "https://github.com/o/r/pull/9", "lean/issue-4802")],
    depsOver,
  });
  assert(reused.outcome?.kind === "ok" && checks === 1, "a reused PR runs no check");
  const bad = await runPublish({
    issue: 4803,
    verify: { kind: "green" },
    depsOver: { ...depsOver, specBlock: async () => ({ text: "not a block", dispatches: [row] }) },
  });
  assert(
    /spec block is unreadable/.test(bad.threw?.message ?? ""),
    "an unreadable block opens no PR",
  );
  assert(
    (bad.threw as { dispatches?: unknown[] } | undefined)?.dispatches?.length === 1,
    "and the refusal still carries the check child's cost",
  );
  for (const r of ROOTS) await rm(r, { recursive: true, force: true });
}

await rm(tmp, { recursive: true, force: true });
process.exit(exit);
