#!/usr/bin/env bun
/** vipune image smoke gate — #2330. Under a cgroup cpuset, onnxruntime pins its default thread pool to host CPUs the container may not use and
 * logs an error per thread on every vipune call. The image sets an explicit thread count and its smoke step fails the build on any vipune stderr.
 * The step is RUN, not read: its body runs under bash with a stub `vipune` first on PATH, so a step that ignores stderr or the search hit fails here. */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const dockerfile = readFileSync(path.resolve(import.meta.dirname, "..", "..", ".devcontainer", "Dockerfile"), "utf8");
const fails: string[] = [];
const say = (ok: boolean, what: string) => {
  console.log(`${ok ? "✓" : "✗"} ${what}`);
  if (!ok) fails.push(what);
};

say(/^ENV ORT_INTRA_OP_NUM_THREADS=[1-9]\d*$/m.test(dockerfile), "Dockerfile sets ORT_INTRA_OP_NUM_THREADS to a positive integer");

const lines = dockerfile.split("\n");
const start = lines.findIndex((l) => l.startsWith("RUN ") && l.includes("VIPUNE_DATABASE_PATH"));
const body: string[] = [];
for (let i = start; start >= 0 && i < lines.length; i++) {
  body.push(lines[i]!.replace(/\\$/, ""));
  if (!lines[i]!.endsWith("\\")) break;
}
say(start >= 0, "Dockerfile has a vipune smoke RUN with a scratch VIPUNE_DATABASE_PATH");

const scratch = mkdtempSync(path.join(tmpdir(), "vipune-smoke-gate-"));
const run = (stub: string): number => {
  writeFileSync(path.join(scratch, "vipune"), `#!/usr/bin/env bash\n${stub}\n`);
  chmodSync(path.join(scratch, "vipune"), 0o755);
  const script = body.join("\n").replace(/^RUN /, "");
  const r = spawnSync("bash", ["-c", script], { env: { ...process.env, PATH: `${scratch}:${process.env.PATH}` }, timeout: 5000 });
  return r.status ?? -1;
};
const hit = `case "$1" in add) echo "Added memory: x" ;; search) echo '{"results":[{"content":"image smoke"}]}' ;; esac`;
say(run(hit) === 0, "smoke step passes on a quiet vipune that finds the memory");
say(run(`${hit}; echo "[E:onnxruntime:default] pthread_setaffinity_np failed" >&2`) !== 0, "smoke step fails when vipune writes to stderr");
say(run(`case "$1" in search) echo '{"results":[]}' ;; esac`) !== 0, "smoke step fails when search does not find the memory");
rmSync(scratch, { recursive: true, force: true });

if (fails.length) process.exit(1);
console.log("dockerfile-vipune-smoke gate: PASS");
