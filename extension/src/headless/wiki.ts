/**
 * headless/wiki — `pi-rukas-headless wiki` (#2456): one developer child brings
 * a product wiki up to date with the code in the working directory and the
 * sources a host collected.
 *
 *   wiki --raw <dir> --out <dir> [--full] [--json]
 *
 * The working directory is the product's code, read-only. `--raw` holds the
 * host's sources (`head.json`, `tags.json`, `log.jsonl`, `changed.json`,
 * `changelog.md`), read-only. `--out` is the wiki as the last build left it;
 * its `SCHEMA.md` is the contract the child writes to. The write fence roots
 * the child at `--out`, so every other path is refused at write time.
 * Without `--full` the child changes only what the raw sources say changed.
 *
 * The verdict is read from `--out` itself, before and after the run, never
 * from the child's reply: `pages` lists every file that was added, modified
 * or removed. The host validates the wiki against its schema; this verb
 * checks only what makes a build unusable outright.
 *
 * Exit codes:
 *   0   written: the child finished, `log.md` changed and `SCHEMA.md` did not
 *  10   handed off (`reason`): the child failed, left `log.md` untouched, or
 *       changed `SCHEMA.md`
 *  40   bad arguments, or a missing `--raw` / `--out` / `SCHEMA.md`
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSpecialist } from "../spawn.ts";
import { cycleChildOpts } from "../work-cycle-trust.ts";
import { EXIT } from "./exit-code.ts";
import { type VerbContext, type VerbOutcome, badArguments, parseFlags } from "./verb.ts";

export const WIKI_FLAGS = ["--raw", "--out", "--full", "--json"] as const;

export interface WikiPage {
  path: string;
  change: "added" | "modified" | "removed";
}

/** Test seam: the child. */
export interface WikiSeams {
  spawn?: typeof spawnSpecialist;
}

/** Every regular file under `dir`, relative path → content hash. Links are not followed. */
export async function snapshot(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const e of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const abs = path.join(e.parentPath, e.name);
    out.set(
      path.relative(dir, abs),
      createHash("sha256")
        .update(await fs.readFile(abs))
        .digest("hex"),
    );
  }
  return out;
}

export function diffPages(before: Map<string, string>, after: Map<string, string>): WikiPage[] {
  const pages: WikiPage[] = [];
  for (const [p, h] of after) {
    const was = before.get(p);
    if (was === undefined) pages.push({ path: p, change: "added" });
    else if (was !== h) pages.push({ path: p, change: "modified" });
  }
  for (const p of before.keys()) if (!after.has(p)) pages.push({ path: p, change: "removed" });
  return pages.sort((a, b) => a.path.localeCompare(b.path));
}

export function wikiPrompt(code: string, raw: string, out: string, full: boolean): string {
  return [
    "Bring this product's wiki up to date with its code and history.",
    "",
    `- The product's code at one commit: ${code} (your working directory). Read-only.`,
    `- Sources collected for this build: ${raw}. Read-only. head.json (commit, date, describe), tags.json, log.jsonl (one commit per line since the last build), changed.json (paths changed, and the pages whose \`sources\` name them), changelog.md.`,
    `- The wiki: ${out}. Change it in place; it is the only place you may write.`,
    "",
    `${out}/SCHEMA.md is the contract. Read it first and follow it exactly: every page's front matter (\`title\`, \`sources\`, \`verified_at\`), index.md lists every page, append exactly one new entry to log.md, relative links only, no HTML. Do not change SCHEMA.md.`,
    "",
    full
      ? "This is a full build: any page may change, and pages may be added or removed."
      : "Change only what the sources say changed: the pages changed.json names, pages for what the new commits add, and the entries in index.md and log.md that follow from them.",
    "",
    "Every statement on a page must be true of the code you read; set `verified_at` to the commit in head.json on each page you verified. Do not commit, push, or use the network. Reply with one line naming the pages you changed.",
  ].join("\n");
}

async function isDir(p: string): Promise<boolean> {
  return (await fs.stat(p).catch(() => undefined))?.isDirectory() === true;
}

export async function runWikiVerb(
  argv: readonly string[],
  ctx: VerbContext,
  seams: WikiSeams = {},
): Promise<VerbOutcome> {
  const p = parseFlags(argv, { bool: ["--full", "--json"], value: ["--raw", "--out"] });
  if ("error" in p) return badArguments(p.error);
  if (p.positional.length > 0) return badArguments(`unexpected argument "${p.positional[0]}"`);
  const rawArg = p.value.get("--raw");
  const outArg = p.value.get("--out");
  if (rawArg === undefined || outArg === undefined)
    return badArguments("wiki needs --raw and --out");
  const raw = path.resolve(rawArg);
  const out = path.resolve(outArg);
  if (!(await isDir(raw))) return badArguments(`--raw is not a directory: ${raw}`);
  if (!(await isDir(out))) return badArguments(`--out is not a directory: ${out}`);
  const before = await snapshot(out);
  if (!before.has("SCHEMA.md")) return badArguments(`--out has no SCHEMA.md: ${out}`);

  const full = p.bool.has("--full");
  ctx.host.sendUserMessage(`wiki: ${full ? "full" : "incremental"} build of ${out}`, {
    deliverAs: "steer",
  });
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "pi-wiki-"));
  let result: Awaited<ReturnType<typeof spawnSpecialist>>;
  try {
    result = await (seams.spawn ?? spawnSpecialist)(
      { role: "developer", prompt: wikiPrompt(ctx.repoRoot, raw, out, full), cwd: ctx.repoRoot },
      {
        writeFence: { root: out, repo: ctx.repoRoot, scratch },
        processGroup: true,
        ...cycleChildOpts({ headless: true }),
      },
    );
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
  const pages = diffPages(before, await snapshot(out));
  const changed = new Set(pages.map((pg) => pg.path));
  const reason = !result.ok
    ? `the child failed: ${result.text.trim().slice(0, 500) || "no reply"}`
    : changed.has("SCHEMA.md")
      ? "the child changed SCHEMA.md"
      : !changed.has("log.md")
        ? "log.md has no new entry"
        : undefined;
  const exitCode = reason ? EXIT.handoff : EXIT.merged;
  const status = reason ? "handed-off" : "written";
  ctx.host.sendUserMessage(`wiki: ${status}, ${pages.length} page(s) (exit ${exitCode})`, {
    deliverAs: "steer",
  });
  return {
    exitCode,
    doc: { subcommand: "wiki", status, exitCode, pages, ...(reason ? { reason } : {}) },
  };
}
