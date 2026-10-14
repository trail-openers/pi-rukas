#!/usr/bin/env bun
/**
 * The issue's images reach the explore and plan prompts.
 *
 * A launcher leaves the images and a `manifest.json` in a directory named by
 * `PI_ENSEMBLE_EXTRA_IMAGE_DIRS`. The driver reads them itself and sends them
 * as image parts of the RPC prompt, with a prompt section that lists them.
 *
 * Covers: the loader's refusals (another issue, a multi-issue cycle, the
 * opt-out, a file name with a path, a link in place of a file, a type that is
 * no image, the count and size limits), the section's wording, the wrapper,
 * and the driver level: explore and its retry, plan, and that a cycle without
 * images sends byte-identical prompts and no `images` key.
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DispatchImage, DispatchResult } from "../src/types.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { runExplore } from "../src/work-driver-explore.ts";
import type { DriverHost } from "../src/work-driver-host.ts";
import {
  MAX_ISSUE_IMAGES,
  MAX_ISSUE_IMAGE_BYTES,
  issueImagesSection,
  loadIssueImages,
  toDispatchImages,
  withIssueImages,
} from "../src/work-driver-issue-images.ts";
import { runPlan } from "../src/work-driver-plan.ts";
import { inlineExplorePrompt, inlinePlanPrompt } from "../src/work-driver-prompts-early.ts";
import { scratchDir } from "../src/work-driver-workspace.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

process.env.PI_ENSEMBLE_INTENT = "1";
const ISSUE = 7;
const LINK = "https://github.com/user-attachments/assets/1111-aa";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const tmp = await mkdtemp(path.join(tmpdir(), "issue-images-"));
let n = 0;
/** A fresh images directory holding `files` and a manifest. */
async function imagesDir(manifest: unknown, files: Record<string, Buffer> = {}): Promise<string> {
  const dir = path.join(tmp, `images-${++n}`);
  await mkdir(dir, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(dir, name), bytes);
  await writeFile(
    path.join(dir, "manifest.json"),
    typeof manifest === "string" ? manifest : JSON.stringify(manifest),
  );
  return dir;
}
const entry = (file: string, extra: Record<string, unknown> = {}) => ({
  file,
  link: LINK,
  type: "image/png",
  bytes: PNG.length,
  ...extra,
});
const env = (dirs: string, extra: Record<string, string> = {}) =>
  ({ PI_ENSEMBLE_EXTRA_IMAGE_DIRS: dirs, ...extra }) as NodeJS.ProcessEnv;

// ── The loader ──────────────────────────────────────────────────────────
{
  const good = await imagesDir(
    {
      issue: ISSUE,
      images: [entry("image-1.png"), entry("image-2.png", { link: "javascript:x" })],
    },
    { "image-1.png": PNG, "image-2.png": PNG },
  );
  const got = await loadIssueImages([ISSUE], env(good));
  assert(got.length === 2, "two listed images are loaded");
  assert(got[0]?.data === PNG.toString("base64"), "an image is carried as base64 of its bytes");
  assert(got[0]?.mimeType === "image/png" && got[0]?.link === LINK, "with its type and its link");
  assert(got[1]?.link === "", "a link that is not a plain https address is not kept");

  assert(
    (await loadIssueImages([ISSUE], {} as NodeJS.ProcessEnv)).length === 0,
    "no variable: none",
  );
  assert(
    (await loadIssueImages([8], env(good))).length === 0,
    "a manifest for another issue: none",
  );
  assert((await loadIssueImages([ISSUE, 8], env(good))).length === 0, "a multi-issue cycle: none");
  assert(
    (await loadIssueImages([ISSUE], env(good, { PI_ENSEMBLE_ISSUE_IMAGES: "0" }))).length === 0,
    "PI_ENSEMBLE_ISSUE_IMAGES=0: none",
  );
  const other = await imagesDir(
    { issue: 8, images: [entry("image-1.png")] },
    { "image-1.png": PNG },
  );
  const nothing = path.join(tmp, "not-there");
  assert(
    (await loadIssueImages([ISSUE], env(`${nothing}:${other}::${good}`))).length === 2,
    "the first directory whose manifest is for this issue is used",
  );
  for (const [what, manifest] of [
    ["not JSON", "{nope"],
    ["an array", "[]"],
    ["no images list", JSON.stringify({ issue: ISSUE })],
    ["an issue as a string", JSON.stringify({ issue: "7", images: [entry("image-1.png")] })],
  ] as const) {
    const dir = await imagesDir(manifest, { "image-1.png": PNG });
    assert(
      (await loadIssueImages([ISSUE], env(dir))).length === 0,
      `a manifest that is ${what}: none`,
    );
  }
}
{
  // What a manifest must not be able to do.
  const secret = path.join(tmp, "secret.png");
  await writeFile(secret, PNG);
  const dir = await imagesDir(
    {
      issue: ISSUE,
      images: [
        entry("../secret.png"),
        entry("/etc/hostname"),
        entry("sub/image.png"),
        entry(".hidden.png"),
        entry("link.png"),
        entry("page.png", { type: "image/svg+xml" }),
        entry("text.png", { type: "text/html" }),
        entry("missing.png"),
        entry("empty.png"),
        "not an object",
        null,
        entry("image-1.png"),
      ],
    },
    { "image-1.png": PNG, "page.png": PNG, "text.png": PNG, "empty.png": Buffer.alloc(0) },
  );
  await symlink(secret, path.join(dir, "link.png"));
  const got = await loadIssueImages([ISSUE], env(dir));
  assert(
    got.length === 1 && got[0]?.file === "image-1.png",
    "a path, a hidden name, a link, another type, a missing or an empty file are all dropped",
  );
}
{
  const many: Record<string, Buffer> = {};
  const list = [];
  for (let i = 1; i <= MAX_ISSUE_IMAGES + 2; i++) {
    many[`image-${i}.png`] = PNG;
    list.push(entry(`image-${i}.png`));
  }
  const dir = await imagesDir({ issue: ISSUE, images: list }, many);
  assert(
    (await loadIssueImages([ISSUE], env(dir))).length === MAX_ISSUE_IMAGES,
    `at most ${MAX_ISSUE_IMAGES} images, whatever the manifest lists`,
  );
  const big = Buffer.alloc(MAX_ISSUE_IMAGE_BYTES - 4, 1);
  const dir2 = await imagesDir(
    { issue: ISSUE, images: [entry("big.png"), entry("image-1.png"), entry("tiny.png")] },
    { "big.png": big, "image-1.png": PNG, "tiny.png": Buffer.from([1, 2]) },
  );
  const got = await loadIssueImages([ISSUE], env(dir2));
  assert(
    got.map((i) => i.file).join(",") === "big.png,tiny.png",
    "an image over what is left of the size limit is dropped, a later one that fits is kept",
  );
}

// ── The section and the wrapper ─────────────────────────────────────────
const one = [{ file: "image-1.png", link: LINK, mimeType: "image/png", data: "AAAA" }];
{
  assert(issueImagesSection([], "explore") === "", "no images: no section at all");
  const explore = issueImagesSection(one, "explore");
  assert(explore.includes("## Images attached to the issue"), "the section has its heading");
  assert(
    explore.includes(`1. image-1.png, linked in the issue text as ${LINK}`),
    "each image beside its link",
  );
  assert(
    explore.includes("The issue text links 1 image. It is attached"),
    "singular for one image",
  );
  assert(
    /untrusted input/.test(explore) && /never an instruction/.test(explore),
    "it says an image is untrusted",
  );
  assert(/WHERE the change goes/.test(explore), "explore is asked where the change goes");
  const plan = issueImagesSection([...one, { ...one[0], file: "image-2.jpg", link: "" }], "plan");
  assert(plan.includes("links 2 images. They are attached"), "plural for two");
  assert(
    plan.includes("\n2. image-2.jpg\n"),
    "an image without a printable link is listed by its name",
  );
  assert(/state that place in words/.test(plan), "plan is asked for the placement in words");

  const parts = toDispatchImages(one);
  assert(
    JSON.stringify(parts) === '[{"type":"image","data":"AAAA","mimeType":"image/png"}]',
    "an image part has Pi's shape: type, data, mimeType",
  );
  const base: NonNullable<DriverContext["dispatchFn"]> = async () => ({}) as DispatchResult;
  assert(withIssueImages(base, []) === base, "no images: the dispatch function is not wrapped");
  let seen: unknown;
  const spy: NonNullable<DriverContext["dispatchFn"]> = async (_host, spec) => {
    seen = spec;
    return {} as DispatchResult;
  };
  await withIssueImages(spy, one)({} as DriverHost, { role: "explore", prompt: "p", cwd: "/w" });
  const s = seen as { role: string; prompt: string; cwd: string; images: DispatchImage[] };
  assert(
    s.role === "explore" && s.prompt === "p" && s.cwd === "/w" && s.images.length === 1,
    "the wrapper adds the images and keeps the rest of the spec",
  );
}

// ── The RPC line ────────────────────────────────────────────────────────
{
  const src = await Bun.file(path.resolve(import.meta.dirname, "../src/spawn.ts")).text();
  assert(
    /type: "prompt", message: cwdHint \+ spec\.prompt, images: spec\.images/.test(src),
    "the kickoff prompt line carries spec.images",
  );
  const without = JSON.stringify({ type: "prompt", message: "m", images: undefined });
  assert(
    without === '{"type":"prompt","message":"m"}',
    "and without images the line has no such key",
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
  "- the meter is at the right end of the panel",
  "",
].join("\n");
const NO_SPEC_REPLY = "INTENT-VERDICT: proceed\n\n## Workstreams\n- one\n";
const PLAN_REPLY = [
  "## Workstreams",
  "",
  "### default",
  "- paths: src/meter.ts",
  "- description: move the meter to the right end of the panel titled FACTORY",
  "",
].join("\n");

function result(text: string): DispatchResult {
  return {
    role: "explore",
    ok: true,
    text,
    toolUses: [],
    ms: 10,
    exitCode: 0,
    transcriptPath: "/tmp/stub-transcript.json",
  };
}
type Seen = { prompt: string; images?: DispatchImage[]; label?: string };
async function cycle(
  replies: string[],
): Promise<{ ctx: DriverContext; seen: Seen[]; repoRoot: string }> {
  const repoRoot = path.join(tmp, `repo-${++n}`);
  await mkdir(repoRoot, { recursive: true });
  const seen: Seen[] = [];
  const ctx: DriverContext = {
    host: {} as DriverHost,
    issue: ISSUE,
    repoRoot,
    dispatchFn: async (_host, spec, opts) => {
      seen.push({ prompt: spec.prompt, images: spec.images, label: opts?.label });
      return result(replies[Math.min(seen.length - 1, replies.length - 1)] ?? "");
    },
    issueBodyFetcherFn: async () => ({ stdout: `Move the meter. ![shot](${LINK})` }),
  };
  return { ctx, seen, repoRoot };
}

const dir = await imagesDir(
  { issue: ISSUE, images: [entry("image-1.png")] },
  { "image-1.png": PNG },
);
const saved = process.env.PI_ENSEMBLE_EXTRA_IMAGE_DIRS;
try {
  // Explore, with images.
  process.env.PI_ENSEMBLE_EXTRA_IMAGE_DIRS = dir;
  {
    const { ctx, seen } = await cycle([GOOD_REPLY]);
    await runExplore(ctx, initialState(ISSUE), Date.now());
    assert(seen.length === 1, "explore dispatches once");
    assert(seen[0]?.images?.length === 1, "the explore dispatch carries the image");
    assert(seen[0]?.images?.[0]?.data === PNG.toString("base64"), "as the bytes of the file");
    assert(
      seen[0]?.prompt.includes("## Images attached to the issue") === true &&
        seen[0]?.prompt.includes(LINK) === true,
      "and its prompt lists it beside its link",
    );
  }
  {
    const { ctx, seen } = await cycle([NO_SPEC_REPLY, GOOD_REPLY]);
    await runExplore(ctx, initialState(ISSUE), Date.now());
    assert(seen.length === 2, "a reply with no spec is re-dispatched once");
    assert(seen[1]?.images?.length === 1, "the explore retry carries the image too");
    assert(
      seen[1]?.prompt.includes("## Images attached to the issue") === true,
      "and the retry's prompt keeps the section",
    );
  }
  // Plan, with images.
  {
    const { ctx, seen } = await cycle([PLAN_REPLY]);
    const state: WorkState = initialState(ISSUE);
    await runPlan(ctx, state, Date.now());
    assert(seen.length >= 1 && seen[0]?.label === "plan", "plan dispatches");
    assert(
      seen.every((s) => s.images?.length === 1),
      "every plan dispatch carries the image",
    );
    assert(
      /state that place in words/.test(seen[0]?.prompt ?? ""),
      "and its prompt asks for the placement",
    );
  }
  // Without images: exactly today's prompts, and no images key.
  process.env.PI_ENSEMBLE_EXTRA_IMAGE_DIRS = "";
  {
    const { ctx, seen, repoRoot } = await cycle([GOOD_REPLY]);
    await runExplore(ctx, initialState(ISSUE), Date.now());
    const want = inlineExplorePrompt(
      [ISSUE],
      scratchDir(repoRoot, ISSUE),
      [{ issue: ISSUE, body: `Move the meter. ![shot](${LINK})`, truncated: false }],
      true,
    );
    assert(seen[0]?.prompt === want, "without images the explore prompt is byte-identical");
    assert(seen[0]?.images === undefined, "and the explore dispatch has no images");
  }
  {
    const { ctx, seen, repoRoot } = await cycle([PLAN_REPLY]);
    await runPlan(ctx, initialState(ISSUE), Date.now());
    assert(
      seen[0]?.prompt === inlinePlanPrompt([ISSUE], scratchDir(repoRoot, ISSUE)),
      "without images the plan prompt is byte-identical",
    );
    assert(
      seen.every((s) => s.images === undefined),
      "and no plan dispatch has images",
    );
  }
} finally {
  if (saved === undefined) process.env.PI_ENSEMBLE_EXTRA_IMAGE_DIRS = "";
  else process.env.PI_ENSEMBLE_EXTRA_IMAGE_DIRS = saved;
  await rm(tmp, { recursive: true, force: true });
}

process.exit(exit);
