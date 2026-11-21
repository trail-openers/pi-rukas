#!/usr/bin/env bun
/**
 * `pi-rukas-headless wiki` (#2456) judges the run from `--out` itself, with the
 * child stubbed:
 *
 *   log.md changed, SCHEMA.md not → 0 `written`, `pages` from the file diff
 *   log.md untouched, SCHEMA.md changed, or the child failed → 10 `handed-off`
 *   missing --raw/--out, a missing directory or SCHEMA.md, an unknown flag → 40
 *
 * Also pinned: the child runs in the code tree with the write fence rooted at
 * `--out`, and `--full` reaches its prompt.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type WikiSeams, runWikiVerb } from "../src/headless/wiki.ts";
import { makeAssert, runVerb } from "./headless-verb-harness.ts";

const { assert, state } = makeAssert();
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "test-headless-wiki-"));
const code = path.join(tmp, "code");
const raw = path.join(tmp, "raw");
const out = path.join(tmp, "out");

async function fresh(): Promise<void> {
  await fs.rm(tmp, { recursive: true, force: true });
  for (const d of [code, raw, path.join(out, "pages")]) await fs.mkdir(d, { recursive: true });
  await fs.writeFile(path.join(out, "SCHEMA.md"), "# schema\n");
  await fs.writeFile(path.join(out, "log.md"), "# log\n");
  await fs.writeFile(path.join(out, "index.md"), "# index\n");
  await fs.writeFile(path.join(out, "pages", "old.md"), "old\n");
}

type Spawn = NonNullable<WikiSeams["spawn"]>;
let calls: { spec: Parameters<Spawn>[0]; opts: Parameters<Spawn>[1] }[] = [];
function child(edit: () => Promise<void>, ok = true): WikiSeams {
  return {
    spawn: (async (spec, opts) => {
      calls.push({ spec, opts });
      await edit();
      return { role: spec.role, ok, text: ok ? "done" : "killed", toolUses: [] };
    }) as Spawn,
  };
}
const wiki = (argv: string[], seams: WikiSeams) =>
  runVerb("wiki", argv, code, (a, ctx) => runWikiVerb(a, ctx, seams));
const ARGS = ["--raw", raw, "--out", out, "--json"];

const good = child(async () => {
  await fs.appendFile(path.join(out, "log.md"), "- built\n");
  await fs.writeFile(path.join(out, "pages", "new.md"), "new\n");
  await fs.rm(path.join(out, "pages", "old.md"));
});

{
  await fresh();
  calls = [];
  const r = await wiki(ARGS, good);
  assert(r.violations.length === 0, `output contract (${r.violations.join("; ")})`);
  assert(r.code === 0 && r.doc.status === "written", `a good build exits 0 (got ${r.code})`);
  assert(
    JSON.stringify(r.doc.pages) ===
      JSON.stringify([
        { path: "log.md", change: "modified" },
        { path: path.join("pages", "new.md"), change: "added" },
        { path: path.join("pages", "old.md"), change: "removed" },
      ]),
    `pages come from the file diff (${JSON.stringify(r.doc.pages)})`,
  );
  const c = calls[0];
  assert(
    c?.spec.cwd === code && c.opts?.writeFence?.root === out && c.opts.writeFence.repo === code,
    "the child runs in the code tree, fenced to --out",
  );
  assert(
    c?.spec.prompt.includes("Change only what the sources say changed") === true,
    "incremental prompt",
  );
}

{
  await fresh();
  calls = [];
  await wiki([...ARGS, "--full"], good);
  assert(calls[0]?.spec.prompt.includes("full build") === true, "--full reaches the prompt");
}

for (const [name, seams, reason] of [
  ["log.md untouched", child(async () => {}), "log.md"],
  [
    "SCHEMA.md changed",
    child(async () => {
      await fs.appendFile(path.join(out, "log.md"), "- built\n");
      await fs.appendFile(path.join(out, "SCHEMA.md"), "loosened\n");
    }),
    "SCHEMA.md",
  ],
  [
    "the child failed",
    child(async () => fs.appendFile(path.join(out, "log.md"), "- built\n"), false),
    "failed",
  ],
] as const) {
  await fresh();
  const r = await wiki(ARGS, seams);
  assert(
    r.code === 10 && r.doc.status === "handed-off" && String(r.doc.reason).includes(reason),
    `${name} → 10 handed-off (got ${r.code}, ${String(r.doc.reason)})`,
  );
}

await fresh();
for (const argv of [
  ["--raw", raw],
  ["--raw", path.join(tmp, "nope"), "--out", out],
  ["--raw", raw, "--out", raw],
  [...ARGS, "--push"],
  [...ARGS, "extra"],
]) {
  calls = [];
  const r = await wiki(argv, good);
  assert(
    r.code === 40 &&
      (r.doc.error as { code?: string })?.code === "bad-arguments" &&
      calls.length === 0,
    `refused [${argv.map((a) => path.basename(a)).join(" ")}] → 40, no child`,
  );
}

await fs.rm(tmp, { recursive: true, force: true });
process.exit(state.exit);
