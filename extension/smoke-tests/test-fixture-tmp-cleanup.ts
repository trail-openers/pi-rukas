#!/usr/bin/env bun
/**
 * #1606 — a process that uses lib/git-test-env.ts leaves nothing in TMPDIR.
 *
 * The isolation dir had no cleanup site and every fixture process leaked one
 * (plus a ~128MB model download into its HOME) until the /tmp tmpfs ran out of
 * inodes. Each case runs a child with TMPDIR pointed at an empty scratch dir,
 * has it create the isolation dir and a tracked fixture dir, ends it — normally
 * or by the watchdog's SIGTERM — and asserts the scratch dir is empty again.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const lib = join(import.meta.dirname, "lib", "git-test-env.ts");
const child = `
  const m = await import(${JSON.stringify(lib)});
  const env = m.gitTestEnv();
  const extra = m.trackedTempDir("pi-ens-1606-");
  const { existsSync } = await import("node:fs");
  console.log(JSON.stringify({ seen: [env.HOME, extra].filter((d) => existsSync(d)) }));
  if (process.argv[1] === "hang") setInterval(() => {}, 1000);
`;

async function run(mode: "exit" | "hang"): Promise<{ seen: string[]; left: string[]; code: number | null }> {
  const scratch = mkdtempSync(join(tmpdir(), "pi-ens-1606-scratch-"));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.PI_ENSEMBLE_SMOKE_HOST_GIT;
  env.TMPDIR = scratch;
  const p = spawn(process.execPath, ["-e", child, mode], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let seen: string[] = [];
  const code = await new Promise<number | null>((resolve) => {
    p.stdout.on("data", (b: Buffer) => {
      out += b.toString();
      const line = out.split("\n").find((l) => l.startsWith("{"));
      if (line && seen.length === 0) {
        seen = (JSON.parse(line) as { seen: string[] }).seen;
        if (mode === "hang") p.kill("SIGTERM");
      }
    });
    p.on("close", (c) => resolve(c));
  });
  const left = readdirSync(scratch);
  rmSync(scratch, { recursive: true, force: true });
  return { seen, left, code };
}

for (const mode of ["exit", "hang"] as const) {
  const r = await run(mode);
  const how = mode === "exit" ? "a normal exit" : "SIGTERM";
  assert(r.seen.length === 2, `${how}: the isolation HOME and the tracked dir existed while running`);
  assert(r.left.length === 0, `${how}: nothing left in TMPDIR (left: ${JSON.stringify(r.left)})`);
  if (mode === "hang") assert(r.code === 143, `SIGTERM: exits 143 (got ${r.code})`);
}

// The gate's backstop: a test that mkdtemps without cleanup (dozens do) leaves
// nothing behind either, because verify-loop.sh points TMPDIR into its run dir.
{
  const scratch = mkdtempSync(join(tmpdir(), "pi-ens-1606-loop-"));
  const fixtureDir = mkdtempSync(join(tmpdir(), "pi-ens-1606-fixture-"));
  const fixture = join(fixtureDir, "test-leaky.ts");
  writeFileSync(
    fixture,
    `import { mkdtempSync } from "node:fs";\nimport { tmpdir } from "node:os";\nimport { join } from "node:path";\nmkdtempSync(join(tmpdir(), "leaky-"));\nconsole.log("✓ leaked");\n`,
  );
  const r = spawnSync("bash", [join(import.meta.dirname, "lib", "verify-loop.sh"), fixture], {
    env: { ...process.env, TMPDIR: scratch },
    encoding: "utf8",
  });
  const left = readdirSync(scratch);
  rmSync(scratch, { recursive: true, force: true });
  rmSync(fixtureDir, { recursive: true, force: true });
  assert(r.status === 0, `verify-loop ran the leaky fixture green (status ${r.status})`);
  assert(left.length === 0, `verify-loop: nothing left in TMPDIR (left: ${JSON.stringify(left)})`);
}

// The shared model-cache link is removed without following it.
const hostCache = join(userInfo().homedir, ".cache", "huggingface");
if (existsSync(hostCache)) {
  assert(existsSync(hostCache), "the operator's model cache survives the fixture cleanup");
}

process.exit(exit);
