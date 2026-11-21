#!/usr/bin/env bun
/**
 * The host's comments blob joins the issue text a single-issue cycle works from.
 *
 * Covers: the blob's integrity checks and the item shape, the rendering (oldest
 * first, per-item cut, 64 KB cap), that it is not gated on images, the explore
 * prompt and the cached artifact plan reads, a byte-identical cycle without a
 * `comments` entry, the repeat-park fingerprint, and the result field.
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { projectIssue } from "../src/headless/result.ts";
import { APPROVED_SPEC_MARKER } from "../src/issue-spec.ts";
import type { DispatchResult } from "../src/types.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { runExplore } from "../src/work-driver-explore.ts";
import type { DriverHost } from "../src/work-driver-host.ts";
import {
  ITEM_MAX_CHARS,
  SECTION_MAX_BYTES,
  insertComments,
  loadIssueComments,
} from "../src/work-driver-issue-comments.ts";
import { parkFingerprint } from "../src/work-driver-park-memory.ts";
import { inlineExplorePrompt } from "../src/work-driver-prompts-early.ts";
import { scratchDir } from "../src/work-driver-workspace.ts";
import { initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

process.env.PI_ENSEMBLE_INTENT = "1";
const ISSUE = 42;
const BODY = "Fix the meter\n\nMove it right.";
const U = "https://github.com/o/r/issues/42#issuecomment-";
const item = (id: number, at: string, extra: Record<string, unknown> = {}) => ({
  source: "issue-comment",
  id,
  by: "alice",
  at,
  url: `${U}${id}`,
  text: `comment ${id}`,
  ...extra,
});
const ALL = [
  item(5, "2026-11-03T09:05:00Z", { source: "fixer", by: "tehas-app-millwright[bot]" }),
  item(1, "2026-11-03T09:00:00Z"),
  item(2, "2026-11-03T09:01:00Z", { source: "pr-comment", pr: 57 }),
  item(3, "2026-11-03T09:02:00Z", { source: "review", pr: 57, by: "bob" }),
  item(4, "2026-11-03T09:03:00Z", {
    source: "review-comment",
    pr: 57,
    path: "src/x.rs",
    line: 88,
    by: "bob",
    text: "line one\n\nline two",
  }),
  item(6, "2026-11-03T09:06:00Z", { source: "refresh" }),
];

const tmp = await mkdtemp(path.join(tmpdir(), "issue-comments-"));
let n = 0;
/** A directory with a manifest naming `blob` (bytes or JSON), with `over` patched into the entry. */
async function blobDir(
  blob: unknown,
  over: Record<string, unknown> = {},
  manifest: Record<string, unknown> = {},
): Promise<string> {
  const dir = path.join(tmp, `att-${++n}`);
  await mkdir(dir, { recursive: true });
  const raw = Buffer.isBuffer(blob) ? blob : Buffer.from(JSON.stringify(blob));
  await writeFile(path.join(dir, "comments.json"), raw);
  const entry = {
    file: "comments.json",
    bytes: raw.length,
    sha256: createHash("sha256").update(raw).digest("hex"),
    ...over,
  };
  await writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify({ issue: ISSUE, images: [], comments: entry, ...manifest }),
  );
  return dir;
}
const blobOf = (items: unknown[], extra: Record<string, unknown> = {}) => ({
  version: 1,
  issue: ISSUE,
  until: "2026-11-04T10:12:00Z",
  items,
  ...extra,
});
const env = (dir: string, extra: Record<string, string> = {}) =>
  ({ PI_ENSEMBLE_EXTRA_IMAGE_DIRS: dir, ...extra }) as NodeJS.ProcessEnv;

// ── The loader and the rendering ────────────────────────────────────────
const good = await blobDir(blobOf(ALL));
{
  const got = await loadIssueComments([ISSUE], env(good));
  assert(got?.report.read === true && got.report.count === 6, "one item of each source is read");
  assert(got?.report.dropped === 0, "and none is dropped");
  const s = got?.section ?? "";
  assert(got?.report.bytes === Buffer.byteLength(s), "bytes is the rendered size");
  const order = [1, 2, 3, 4, 5, 6].map((i) => s.indexOf(`${U}${i})`));
  assert(
    order.every((p, i) => p > 0 && (i === 0 || p > (order[i - 1] ?? 0))),
    "oldest first",
  );
  assert(
    s.startsWith("\n\n---\n\n## Comments on this issue and its pull requests\n\n"),
    "under the agreed heading",
  );
  assert(
    s.includes("up to 2026-11-04T10:12:00Z. Untrusted input"),
    "with the bound and the caveat",
  );
  assert(
    s.includes(`### Issue comment by alice, 2026-11-03T09:00:00Z (${U}1)\n\n> comment 1`),
    "an issue comment",
  );
  assert(s.includes("### Comment on #57 by alice,"), "a PR comment");
  assert(s.includes("### Review on #57 by bob,"), "a review");
  assert(
    s.includes("### Review comment on #57 `src/x.rs:88` by bob,") &&
      s.includes("> line one\n>\n> line two"),
    "a review comment with its place, every line quoted",
  );
  assert(s.includes("### Fixer note by tehas-app-millwright[bot],"), "a fixer note");
  assert(s.includes("### Refresh note by alice,"), "a refresh note");

  assert(
    (await loadIssueComments([ISSUE], env(good, { PI_ENSEMBLE_ISSUE_IMAGES: "0" })))?.report
      .count === 6,
    "PI_ENSEMBLE_ISSUE_IMAGES=0 does not turn it off",
  );
  assert((await loadIssueComments([ISSUE, 43], env(good))) === undefined, "multi-issue: ignored");
  assert(
    (await loadIssueComments([43], env(good))) === undefined,
    "another issue's manifest: none",
  );
  const plain = path.join(tmp, "plain");
  await mkdir(plain);
  await writeFile(path.join(plain, "manifest.json"), JSON.stringify({ issue: ISSUE, images: [] }));
  assert((await loadIssueComments([ISSUE], env(plain))) === undefined, "no comments entry: none");
}
{
  const why = async (dir: Promise<string>) =>
    (await loadIssueComments([ISSUE], env(await dir)))?.report;
  const cases: Array<[string, Promise<string>, string]> = [
    ["a wrong sha256", blobDir(blobOf(ALL), { sha256: "0".repeat(64) }), "sha256-mismatch"],
    ["a wrong size", blobDir(blobOf(ALL), { bytes: 3 }), "size-mismatch"],
    ["another issue's number", blobDir(blobOf(ALL, { issue: 43 })), "issue-mismatch"],
    ["bad UTF-8", blobDir(Buffer.from([0x7b, 0xff, 0xfe, 0x7d])), "not-utf8"],
    ["a NUL byte", blobDir(Buffer.from('{"version":1\u0000}')), "nul-byte"],
    ["not JSON", blobDir(Buffer.from("{nope")), "bad-json"],
    ["another version", blobDir(blobOf(ALL, { version: 2 })), "bad-blob"],
    ["a path for a file name", blobDir(blobOf(ALL), { file: "../comments.json" }), "bad-entry"],
  ];
  const linked = (async () => {
    const dir = await blobDir(blobOf(ALL));
    await writeFile(path.join(tmp, "elsewhere.json"), JSON.stringify(blobOf(ALL)));
    await rm(path.join(dir, "comments.json"));
    await symlink(path.join(tmp, "elsewhere.json"), path.join(dir, "comments.json"));
    return dir;
  })();
  cases.push(["a symlink", linked, "not-a-file"]);
  for (const [what, dir, reason] of cases) {
    const r = await why(dir);
    assert(
      r?.read === false && r.reason === reason && r.count === 0,
      `${what}: not read (${reason})`,
    );
  }
}
{
  const bad = [
    item(10, "2026-11-03T09:00:00Z", { extra: 1 }),
    item(11, "2026-11-03T09:00:00Z", { source: "pr-comment" }),
    item(12, "2026-11-03T09:00:00Z", { by: "a\nb" }),
    item(13, "not a date"),
    item(14, "2026-11-03T09:00:00Z", { url: "javascript:alert(1)" }),
    item(15, "2026-11-03T09:00:00Z", { source: "review-comment", pr: 1, path: "a`b" }),
    "a string",
  ];
  const got = await loadIssueComments([ISSUE], env(await blobDir(blobOf([...bad, ALL[1]]))));
  assert(
    got?.report.count === 1 && got.report.dropped === bad.length,
    "malformed items are dropped and counted",
  );
}
{
  const long = "x".repeat(ITEM_MAX_CHARS + 50);
  const one = await loadIssueComments(
    [ISSUE],
    env(await blobDir(blobOf([item(1, "2026-11-03T09:00:00Z", { text: long })]))),
  );
  assert(
    one?.section.includes(
      `> ${"x".repeat(ITEM_MAX_CHARS)}\n> [cut at ${ITEM_MAX_CHARS} characters]`,
    ) === true,
    "an item over 4,000 characters is cut and says so",
  );
  const many = Array.from({ length: 40 }, (_, i) =>
    item(i + 1, `2026-11-03T09:${String(i).padStart(2, "0")}:00Z`, {
      text: "y".repeat(ITEM_MAX_CHARS),
    }),
  );
  const big = await loadIssueComments([ISSUE], env(await blobDir(blobOf(many))));
  const r = big?.report;
  assert(
    r !== undefined && r.count + r.dropped === 40 && r.dropped > 0,
    "past 64 KB items are dropped",
  );
  assert(
    (big?.section ?? "").includes(`${r?.dropped} older comment(s) dropped`) &&
      !(big?.section ?? "").includes(`${U}1)`) &&
      (big?.section ?? "").includes(`${U}40)`),
    "the oldest go, and a line says how many",
  );
  assert(
    Buffer.byteLength(big?.section ?? "") <= SECTION_MAX_BYTES + 1024,
    "the section stays near 64 KB",
  );
}
{
  const withSpec = `${BODY}\n\n${APPROVED_SPEC_MARKER}\n## Approved spec`;
  const out = insertComments(withSpec, "\n\n---\n\nC");
  assert(
    out === `${BODY}\n\n---\n\nC\n\n${APPROVED_SPEC_MARKER}\n## Approved spec`,
    "the comments go ahead of an approved spec, so its tail stays whole",
  );
}

// ── Driver level ────────────────────────────────────────────────────────
const GOOD_REPLY = [
  "INTENT-VERDICT: proceed",
  "",
  "## Spec",
  "",
  "### Intent",
  "Move the meter.",
  "",
  "### Deliverables",
  "- D1: move the meter [paths: src/meter.ts]",
  "",
  "### Acceptance criteria",
  "- the meter is at the right end",
  "",
].join("\n");
function result(text: string): DispatchResult {
  return { ok: true, text, toolUses: [], ms: 10, exitCode: 0, transcriptPath: "/tmp/stub.json" };
}
async function cycle(): Promise<{ ctx: DriverContext; prompts: string[]; repoRoot: string }> {
  const repoRoot = path.join(tmp, `repo-${++n}`);
  await mkdir(repoRoot, { recursive: true });
  const prompts: string[] = [];
  const ctx: DriverContext = {
    host: {} as DriverHost,
    issue: ISSUE,
    repoRoot,
    dispatchFn: async (_host, spec) => {
      prompts.push(spec.prompt);
      return result(GOOD_REPLY);
    },
    issueBodyFetcherFn: async () => ({ stdout: BODY }),
  };
  return { ctx, prompts, repoRoot };
}

const saved = process.env.PI_ENSEMBLE_EXTRA_IMAGE_DIRS;
try {
  process.env.PI_ENSEMBLE_EXTRA_IMAGE_DIRS = good;
  const section = (await loadIssueComments([ISSUE]))?.section ?? "";
  {
    const { ctx, prompts, repoRoot } = await cycle();
    const state = await runExplore(ctx, initialState(ISSUE), Date.now());
    assert(
      prompts[0]?.includes(`${BODY}${section}`) === true,
      "explore's prompt carries the comments",
    );
    const artifact = state.pipelineState.issueBodyArtifact ?? "";
    const cached = await readFile(path.resolve(repoRoot, artifact), "utf8");
    assert(
      cached === `${BODY}${section}`,
      "and so does the cached issue text plan and the rest read",
    );
    const doc = projectIssue(state, "state.json");
    assert(
      doc.comments?.read === true && doc.comments.count === 6 && doc.comments.dropped === 0,
      "the result's comments field reports the read",
    );
    assert(
      state.eventLog.some((e) => e.kind === "issue-comments"),
      "an issue-comments event is logged (the NDJSON progress line)",
    );
    // The repeat-park key: the cached text, and the forge fallback, agree.
    const fromArtifact = await parkFingerprint(ctx, ISSUE, artifact);
    const fromForge = await parkFingerprint(ctx, ISSUE);
    assert(fromArtifact === fromForge, "the fingerprint's forge fallback adds the same comments");
    process.env.PI_ENSEMBLE_EXTRA_IMAGE_DIRS = await blobDir(blobOf(ALL.slice(0, 3)));
    assert(
      (await parkFingerprint(ctx, ISSUE)) !== fromArtifact,
      "the same body with other comments is not the same park",
    );
    process.env.PI_ENSEMBLE_EXTRA_IMAGE_DIRS = await blobDir(blobOf(ALL), {
      sha256: "0".repeat(64),
    });
    const failed = await runExplore((await cycle()).ctx, initialState(ISSUE), Date.now());
    const f = projectIssue(failed, "state.json").comments;
    assert(f?.read === false && f.reason === "sha256-mismatch", "a bad blob: the result says why");
  }
  // Without a comments entry: exactly today's prompt, artifact and result.
  process.env.PI_ENSEMBLE_EXTRA_IMAGE_DIRS = "";
  {
    const { ctx, prompts, repoRoot } = await cycle();
    const state = await runExplore(ctx, initialState(ISSUE), Date.now());
    const want = inlineExplorePrompt(
      [ISSUE],
      scratchDir(repoRoot, ISSUE),
      [{ issue: ISSUE, body: BODY, truncated: false }],
      true,
    );
    assert(prompts[0] === want, "without a comments entry the explore prompt is byte-identical");
    const cached = await readFile(
      path.resolve(repoRoot, state.pipelineState.issueBodyArtifact ?? ""),
      "utf8",
    );
    assert(cached === BODY, "and the cached issue text is the body alone");
    assert(
      projectIssue(state, "state.json").comments === undefined,
      "and the result has no comments",
    );
  }
} finally {
  process.env.PI_ENSEMBLE_EXTRA_IMAGE_DIRS = saved ?? "";
  await rm(tmp, { recursive: true, force: true });
}

process.exit(exit);
