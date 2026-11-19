/**
 * issue-spec — the approved spec a host hands a cycle, read from the same
 * directory and `manifest.json` that carry the issue's images:
 *
 *   "spec": {"file", "link", "name", "bytes", "sha256", "block": 1}
 *   "approvedText": {"file": "approved.json", "bytes", "sha256"}
 *
 * The sha256 is the hash the approval pinned, so the bytes read here must hash
 * to it exactly; anything else is not the spec that was approved.
 *
 * Three answers, kept apart because the caller decides what each means:
 * `none` (no manifest for this issue, or no `spec` in it: the normal case),
 * `ok`, and `invalid`. Unlike an image, a bad spec entry is never dropped:
 * building against bytes that are not the approved spec, or silently against
 * the bare issue, is the larger blast radius, so `issueSpecOrThrow` fails
 * closed. `PI_ENSEMBLE_ISSUE_IMAGES=0` does not apply; that knob is images-only.
 *
 * `specBlockAt` is the production wiring of the PR-body block (`issue-spec-block.ts`)
 * and its one check child (`issue-spec-check.ts`).
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { APPROVED_SPEC_MARKER, MAX_APPROVED_SPEC_CHARS } from "./adversarial-prompts.ts";
import { execp } from "./exec.ts";
import { renderSpecBlock } from "./issue-spec-block.ts";
import { specCheckLines } from "./issue-spec-check.ts";
import { leanChildOpts } from "./lean/child-opts.ts";
import type { DispatchUsageRow } from "./lean/step-budget.ts";
import { fenceText, oneLine } from "./lean/text-fence.ts";
import { spawnSpecialist } from "./spawn.ts";
import { FILE_NAME, LINK, imageDirs, readManifest } from "./work-driver-issue-images.ts";

export class IssueSpecError extends Error {}

export interface IssueSpec {
  text: string;
  link: string;
  name: string;
  sha256: string;
  /** The PR-body block version the host asks for; `undefined` asks for none. */
  block: 1 | undefined;
  /** The issue title and body the approval saw, when the host handed them. */
  approved?: { title: string; body: string };
}

export type IssueSpecRead =
  | { kind: "none" }
  | { kind: "ok"; spec: IssueSpec }
  | { kind: "invalid"; why: string };

export { APPROVED_SPEC_MARKER, MAX_APPROVED_SPEC_CHARS };
export const MAX_SPEC_BYTES = 256 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The pinned bytes of one manifest entry, or the reason they are not. */
async function pinnedBytes(root: string, entry: unknown, what: string): Promise<Buffer | string> {
  if (!isRecord(entry)) return `${what} is not an object`;
  const { file, bytes, sha256 } = entry;
  if (typeof file !== "string" || !FILE_NAME.test(file)) return `${what}.file is not a plain name`;
  if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes <= 0 || bytes > MAX_SPEC_BYTES)
    return `${what}.bytes is not a size from 1 to ${MAX_SPEC_BYTES}`;
  if (typeof sha256 !== "string" || !SHA256.test(sha256)) return `${what}.sha256 is not a sha256`;
  const full = path.join(root, file);
  // A link in place of a file would read whatever it points at.
  const stat = await fs.lstat(full);
  if (!stat.isFile()) return `${what} file ${file} is not a regular file`;
  if (stat.size !== bytes) return `${what} file ${file} has ${stat.size} bytes, not ${bytes}`;
  const data = await fs.readFile(full);
  if (createHash("sha256").update(data).digest("hex") !== sha256)
    return `${what} file ${file} does not hash to the pinned sha256`;
  return data;
}

async function readSpec(
  dir: string,
  m: Record<string, unknown>,
  issue: number,
): Promise<IssueSpecRead> {
  const root = await fs.realpath(dir);
  const entry = m.spec;
  if (!isRecord(entry)) return { kind: "invalid", why: "spec is not an object" };
  const { link, name, block } = entry;
  if (typeof link !== "string" || !LINK.test(link))
    return { kind: "invalid", why: "spec.link is not an https link" };
  if (typeof name !== "string") return { kind: "invalid", why: "spec.name is not a string" };
  if (block !== undefined && block !== 1) return { kind: "invalid", why: "spec.block is not 1" };
  const data = await pinnedBytes(root, entry, "spec");
  if (typeof data === "string") return { kind: "invalid", why: data };
  const decode = new TextDecoder("utf-8", { fatal: true });
  const spec: IssueSpec = {
    text: decode.decode(data),
    link,
    name,
    sha256: entry.sha256 as string,
    block,
  };
  if (m.approvedText !== undefined) {
    const raw = await pinnedBytes(root, m.approvedText, "approvedText");
    if (typeof raw === "string") return { kind: "invalid", why: raw };
    const a: unknown = JSON.parse(decode.decode(raw));
    if (
      !isRecord(a) ||
      a.number !== issue ||
      typeof a.title !== "string" ||
      typeof a.body !== "string"
    )
      return {
        kind: "invalid",
        why: `approvedText is not the number, title and body of #${issue}`,
      };
    spec.approved = { title: a.title, body: a.body };
  }
  return { kind: "ok", spec };
}

/** The approved spec of `issue`, from the first manifest for that issue. Never throws. */
export async function loadIssueSpec(
  issue: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<IssueSpecRead> {
  for (const dir of imageDirs(env)) {
    const m = await readManifest(dir);
    if (m?.issue !== issue) continue;
    if (m.spec === undefined) return { kind: "none" };
    try {
      return await readSpec(dir, m, issue);
    } catch (err) {
      return { kind: "invalid", why: (err as Error).message };
    }
  }
  return { kind: "none" };
}

/** The one call an engine makes: the spec, `undefined` for none, IssueSpecError when invalid. */
export async function issueSpecOrThrow(
  issue: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<IssueSpec | undefined> {
  const r = await loadIssueSpec(issue, env);
  if (r.kind === "invalid") throw new IssueSpecError(`approved spec ${r.why}`);
  return r.kind === "ok" ? r.spec : undefined;
}

/**
 * The issue body with the approved spec appended, fenced so nothing inside it
 * (a ``` run, a `pi-spec v1` block, a heading) becomes structure of the body.
 * Appended, never prepended: the issue's own contract stays where readers look.
 */
export function withApprovedSpec(body: string, spec: IssueSpec): string {
  return [
    body,
    "",
    APPROVED_SPEC_MARKER,
    `## Approved spec: ${oneLine(spec.name, 120)}`,
    "",
    "The issue was approved against this spec. Where the issue text and the spec differ, the spec is the approved requirement; check, test and review against it.",
    "",
    // A marker inside the spec would move the prose/spec split to it.
    fenceText(spec.text.replaceAll(APPROVED_SPEC_MARKER, ""), MAX_APPROVED_SPEC_CHARS),
  ].join("\n");
}

/** A PR body's `tehas:spec v1` block for `spec` at `head`, and what its check child cost. */
export type SpecBlockAt = (
  spec: IssueSpec,
  worktree: string,
  head: string,
) => Promise<{ text: string; dispatches: DispatchUsageRow[] }>;

/**
 * Production wiring: the paths tracked at `head`, then one bounded child with
 * the run's trust stamp. A listing that fails leaves no path to cite, so every
 * `met` is reported not met rather than the block going missing.
 */
export function specBlockAt(headless: boolean): SpecBlockAt {
  return async (spec, worktree, head) => {
    const ls = await execp("git", {
      argv: ["ls-tree", "-r", "-z", "--name-only", head],
      cwd: worktree,
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    }).catch(() => ({ stdout: "" }));
    const headFiles = new Set(ls.stdout.split("\0").filter((p) => p !== ""));
    const checked = await specCheckLines({ spec, worktree, head, headFiles }, (s, arms) =>
      spawnSpecialist(s, {
        ...arms.opts,
        ...leanChildOpts(headless),
        // The budget's kill reaches the child's tool tree only via its own group.
        processGroup: true,
      }),
    );
    return { text: renderSpecBlock(spec, checked.lines), dispatches: checked.dispatches };
  };
}
