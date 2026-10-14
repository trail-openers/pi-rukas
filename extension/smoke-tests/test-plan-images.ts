#!/usr/bin/env bun
/**
 * /plan gets the issue's images the way /work does (#1214).
 *
 * Pi drops images a launcher attaches to an extension command, so the
 * extension reads the `PI_ENSEMBLE_EXTRA_IMAGE_DIRS` manifests itself. Covers:
 * which manifest /plan takes (`PI_ENSEMBLE_PLAN_ISSUE`, a single manifest,
 * none when manifests name two issues), the `/plan` alias message carrying
 * image parts and the untrusted section, every `start_plan_driver` child
 * (investigation and gap gate) carrying them, and the drafted body keeping the
 * links. Without images every prompt, message and body is unchanged.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerCommands } from "../src/commands.ts";
import { runPlanPipeline, setPlanDispatch } from "../src/plan-driver.ts";
import { loadPlanImages } from "../src/plan-images.ts";
import {
  installForgeStub,
  installNoPlanCacheStub,
  installOfflineVipuneStub,
  makeDispatchStub,
} from "./plan-test-stubs.ts";

installNoPlanCacheStub();
installOfflineVipuneStub();
installForgeStub();

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const LINK = "https://github.com/user-attachments/assets/2222-bb";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 4, 5, 6]);
const tmp = await mkdtemp(path.join(tmpdir(), "plan-images-"));
let n = 0;
async function imagesDir(issue: number): Promise<string> {
  const dir = path.join(tmp, `images-${++n}`);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `shot-${issue}.png`), PNG);
  await writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      issue,
      images: [{ file: `shot-${issue}.png`, link: LINK, type: "image/png", bytes: PNG.length }],
    }),
  );
  return dir;
}
const d109 = await imagesDir(109);
const d110 = await imagesDir(110);
const env = (dirs: string[], extra: Record<string, string> = {}) =>
  ({ PI_ENSEMBLE_EXTRA_IMAGE_DIRS: dirs.join(":"), ...extra }) as NodeJS.ProcessEnv;

// ── Which manifest ─────────────────────────────────────────────────────
{
  const one = await loadPlanImages(env([d109]));
  assert(one.length === 1 && one[0]?.file === "shot-109.png", "a single manifest is taken");
  const named = await loadPlanImages(env([d109, d110], { PI_ENSEMBLE_PLAN_ISSUE: "110" }));
  assert(
    named.length === 1 && named[0]?.file === "shot-110.png",
    "PI_ENSEMBLE_PLAN_ISSUE picks its manifest among several",
  );
  assert(
    (await loadPlanImages(env([d109, d110]))).length === 0,
    "manifests for two issues and no PI_ENSEMBLE_PLAN_ISSUE: no images, not a guess",
  );
  assert(
    (await loadPlanImages(env([d109], { PI_ENSEMBLE_PLAN_ISSUE: "111" }))).length === 0,
    "a named issue with no manifest: no images",
  );
  assert(
    (await loadPlanImages(env([d109], { PI_ENSEMBLE_PLAN_ISSUE: "../109" }))).length === 0,
    "a PI_ENSEMBLE_PLAN_ISSUE that is not a number: no images",
  );
  assert(
    (await loadPlanImages(env([d109], { PI_ENSEMBLE_ISSUE_IMAGES: "0" }))).length === 0,
    "PI_ENSEMBLE_ISSUE_IMAGES=0 turns it off",
  );
  assert((await loadPlanImages(env([]))).length === 0, "no directories: no images");
}

// ── The /plan alias message ─────────────────────────────────────────────
type Sent = { content: unknown; opts: unknown };
async function firePlan(): Promise<Sent[]> {
  const sent: Sent[] = [];
  const handlers: Record<string, (args: string, ctx: unknown) => Promise<void>> = {};
  const pi = {
    registerCommand: (name: string, def: { handler: (a: string, c: unknown) => Promise<void> }) => {
      handlers[name] = def.handler;
    },
    registerTool: () => undefined,
    on: () => undefined,
    sendUserMessage: (content: unknown, opts: unknown) => sent.push({ content, opts }),
    sendMessage: () => undefined,
    getCommands: () => [],
    getAllTools: () => [{ name: "read" }, { name: "edit" }],
    setActiveTools: () => undefined,
  };
  registerCommands(pi as never);
  await handlers.plan?.("feature add a panel", { cwd: tmp, isIdle: () => true, ui: {} });
  return sent;
}
{
  process.env.PI_ENSEMBLE_EXTRA_IMAGE_DIRS = d109;
  const sent = await firePlan();
  const parts = sent[0]?.content as Array<{ type: string; text?: string; data?: string }>;
  assert(
    Array.isArray(parts) &&
      parts.some((p) => p.type === "image" && p.data === PNG.toString("base64")),
    "/plan: the alias message carries the image as an image part",
  );
  const text = Array.isArray(parts) ? (parts.find((p) => p.type === "text")?.text ?? "") : "";
  assert(
    text.includes("start_plan_driver") && text.includes("## Images attached to the issue"),
    "/plan: the alias text keeps its instruction and adds the images section",
  );
  assert(text.includes("untrusted input"), "/plan: the section says an image is untrusted");
  assert(
    (sent[0]?.opts as { deliverAs?: string })?.deliverAs === "steer",
    "/plan: still delivered as steer",
  );

  process.env.PI_ENSEMBLE_EXTRA_IMAGE_DIRS = "";
  const plain = await firePlan();
  assert(
    typeof plain[0]?.content === "string" && !String(plain[0]?.content).includes("Images"),
    "/plan without images: a plain string message, unchanged",
  );
}

// ── start_plan_driver's children and the drafted body ───────────────────
type Spec = { role: string; prompt: string; images?: unknown[] };
async function runPipeline(): Promise<{ specs: Spec[]; spec: string }> {
  const specs: Spec[] = [];
  const stub = makeDispatchStub("VERDICT: READY") as unknown as (
    host: unknown,
    s: Spec,
    o: unknown,
  ) => Promise<unknown>;
  setPlanDispatch(((host: unknown, s: Spec, o: unknown) => {
    specs.push(s);
    return stub(host, s, o);
  }) as never);
  const r = await runPlanPipeline(
    {} as never,
    {
      descriptor: "add a details panel beside the results table in the plan-driver extension",
      type: "feature",
      dryRun: true,
    },
    process.cwd(),
  );
  setPlanDispatch(null);
  return { specs, spec: r.spec };
}
{
  process.env.PI_ENSEMBLE_EXTRA_IMAGE_DIRS = d109;
  const { specs, spec } = await runPipeline();
  const gate = specs.filter((s) => s.role === "adversarial-developer");
  const explore = specs.filter((s) => s.role === "explore");
  assert(
    gate.length > 0 && explore.length > 1,
    "the pipeline dispatched explore and gate children",
  );
  assert(
    specs.every((s) => s.images?.length === 1 && s.prompt.includes("untrusted input")),
    "every plan child (investigation and gap gate) carries the image and the section",
  );
  assert(
    spec.includes("## Images from the source issue") && spec.includes(`![shot-109.png](${LINK})`),
    "the drafted body keeps the image's link in its own section",
  );

  process.env.PI_ENSEMBLE_EXTRA_IMAGE_DIRS = "";
  const none = await runPipeline();
  assert(
    none.specs.every((s) => s.images === undefined && !s.prompt.includes("Images attached")),
    "without images no child gets an images key or section",
  );
  assert(
    !none.spec.includes("Images from the source issue"),
    "without images the body is unchanged",
  );
}

await rm(tmp, { recursive: true, force: true });
process.exit(exit);
