#!/usr/bin/env bun
/**
 * #1347 — install.sh's provider-retry defaults land where the pinned Pi reads
 * them.
 *
 * Until #1347 install.sh wrote `httpIdleTimeoutMs` under `retry.provider`.
 * Pi reads it only at the top level (`getHttpIdleTimeoutMs()` reads
 * `settings.httpIdleTimeoutMs`; `getProviderRetrySettings()` returns only
 * timeoutMs / maxRetries / maxRetryDelayMs), so the value never applied.
 *
 * This drives `apply_provider_retry_defaults` (install-retry-defaults.sh,
 * sourced the way install.sh sources it) against temp settings files and
 * reads each result back through the pinned Pi's OWN SettingsManager — so a
 * Pi bump that moves a key again fails here, not silently on hosts.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";

const HELPER = path.join(import.meta.dirname, "..", "..", "install-retry-defaults.sh");

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const root = mkdtempSync(path.join(tmpdir(), "pi-rukas-1347-"));
let n = 0;

type Json = Record<string, unknown>;

/** A fresh agent dir; `initial` undefined means no settings.json at all. */
function agentDir(initial?: Json | string): { dir: string; file: string } {
  n += 1;
  const dir = path.join(root, `agent-${n}`);
  execFileSync("mkdir", ["-p", dir]);
  const file = path.join(dir, "settings.json");
  if (initial !== undefined) {
    writeFileSync(file, typeof initial === "string" ? initial : JSON.stringify(initial));
  }
  return { dir, file };
}

/** Runs the helper under install.sh's own `set -euo pipefail` (a throw here
 * means it would have aborted install.sh); returns its stdout. */
function apply(file: string, env?: NodeJS.ProcessEnv): string {
  return execFileSync(
    "/bin/bash",
    ["-c", 'set -euo pipefail; source "$1"; apply_provider_retry_defaults "$2"', "_", HELPER, file],
    { stdio: "pipe", encoding: "utf8", ...(env ? { env } : {}) },
  );
}

const read = (file: string): Json => JSON.parse(readFileSync(file, "utf8")) as Json;
const provider = (s: Json): Json => ((s.retry as Json | undefined)?.provider ?? {}) as Json;
/** Pi's own view of the file (cwd = the agent dir: no project settings). */
const pi = (dir: string) => SettingsManager.create(dir, dir);

// ── the pin itself: where Pi 1.0 reads each key ─────────────────────────
{
  const { dir } = agentDir({
    httpIdleTimeoutMs: 123456,
    retry: { provider: { timeoutMs: 1, maxRetries: 7, maxRetryDelayMs: 2 } },
  });
  const sm = pi(dir);
  assert(sm.getHttpIdleTimeoutMs() === 123456, "pin: Pi reads httpIdleTimeoutMs at the top level");
  const r = sm.getProviderRetrySettings();
  assert(
    r.timeoutMs === 1 && r.maxRetries === 7 && r.maxRetryDelayMs === 2,
    "pin: Pi reads timeoutMs / maxRetries / maxRetryDelayMs under retry.provider",
  );
  const nested = pi(agentDir({ retry: { provider: { httpIdleTimeoutMs: 120000 } } }).dir);
  assert(
    nested.getHttpIdleTimeoutMs() === 300000,
    "pin: Pi ignores retry.provider.httpIdleTimeoutMs (the pre-#1347 placement) and falls back to 300000",
  );
}

// ── a settings.json with no retry block: the full default set ───────────
{
  const { dir, file } = agentDir({ theme: "dark" });
  apply(file);
  const s = read(file);
  assert(
    s.httpIdleTimeoutMs === 300000 && !("httpIdleTimeoutMs" in provider(s)),
    `fresh: httpIdleTimeoutMs is written at the top level only (got ${JSON.stringify(s)})`,
  );
  const r = pi(dir).getProviderRetrySettings();
  assert(
    r.timeoutMs === 600000 && r.maxRetries === 3 && r.maxRetryDelayMs === 60000,
    `fresh: Pi sees timeoutMs 600000, maxRetries 3, maxRetryDelayMs 60000 (got ${JSON.stringify(r)})`,
  );
  assert(s.theme === "dark", "fresh: unrelated keys are kept");
  const before = readFileSync(file, "utf8");
  apply(file);
  assert(readFileSync(file, "utf8") === before, "fresh: a second run changes nothing");
}

// ── the shape the old install.sh wrote: our 120000 footprint is dropped ─
{
  const { dir, file } = agentDir({
    retry: {
      provider: {
        timeoutMs: 600000,
        maxRetries: 3,
        maxRetryDelayMs: 60000,
        httpIdleTimeoutMs: 120000,
      },
    },
  });
  apply(file);
  const s = read(file);
  assert(
    !("httpIdleTimeoutMs" in provider(s)) && s.httpIdleTimeoutMs === 300000,
    `old install: the ignored nested 120000 is removed; the top level gets 300000 (got ${JSON.stringify(s)})`,
  );
  assert(
    pi(dir).getHttpIdleTimeoutMs() === 300000,
    "old install: Pi's effective value is unchanged",
  );
  const before = readFileSync(file, "utf8");
  apply(file);
  assert(readFileSync(file, "utf8") === before, "old install: a second run changes nothing");
}

// ── an operator's own nested value moves to where Pi reads it ───────────
{
  const { dir, file } = agentDir({
    httpIdleTimeoutMs: null,
    retry: { provider: { timeoutMs: 900000, maxRetries: 8, httpIdleTimeoutMs: 240000 } },
  });
  apply(file);
  const s = read(file);
  assert(
    s.httpIdleTimeoutMs === 240000 && !("httpIdleTimeoutMs" in provider(s)),
    `operator nested value: moved to the top level (got ${JSON.stringify(s)})`,
  );
  const sm = pi(dir);
  const r = sm.getProviderRetrySettings();
  assert(
    sm.getHttpIdleTimeoutMs() === 240000 && r.timeoutMs === 900000 && r.maxRetries === 8,
    `operator nested value: Pi now applies it; the operator's timeoutMs and maxRetries are kept (got ${JSON.stringify(r)})`,
  );
}

// ── an operator's own top-level value wins over any nested leftover ─────
{
  const { file } = agentDir({
    httpIdleTimeoutMs: 200000,
    retry: { provider: { timeoutMs: 600000, httpIdleTimeoutMs: 120000 } },
  });
  apply(file);
  const s = read(file);
  assert(
    s.httpIdleTimeoutMs === 200000 && !("httpIdleTimeoutMs" in provider(s)),
    `operator top-level value: kept; the nested leftover is removed (got ${JSON.stringify(s)})`,
  );
}

// ── review of #1354: the nested move runs before the top-level default ─
{
  const { dir, file } = agentDir({ retry: { provider: { httpIdleTimeoutMs: 240000 } } });
  apply(file);
  const s = read(file);
  assert(
    s.httpIdleTimeoutMs === 240000 && !("httpIdleTimeoutMs" in provider(s)),
    `nested 240000, no timeoutMs: the operator's value moves up, not replaced by 300000 (got ${JSON.stringify(s)})`,
  );
  assert(
    pi(dir).getProviderRetrySettings().timeoutMs === 600000,
    "...and the defaults block is still written",
  );
}
{
  const { file } = agentDir({
    retry: { provider: { timeoutMs: 180000, httpIdleTimeoutMs: 250000 } },
  });
  apply(file);
  const s = read(file);
  assert(
    s.httpIdleTimeoutMs === 250000 && provider(s).timeoutMs === 600000,
    `timeoutMs 180000 + nested 250000: timeout repaired, nested value kept at the top level (got ${JSON.stringify(s)})`,
  );
}
{
  const { file } = agentDir({ httpIdleTimeoutMs: 120000, theme: "dark" });
  apply(file);
  const s = read(file);
  assert(
    s.httpIdleTimeoutMs === 120000 && provider(s).timeoutMs === 600000,
    `an operator's own top-level 120000 is kept (got ${JSON.stringify(s)})`,
  );
}

{
  const { file } = agentDir({ retry: { provider: { timeoutMs: 900000, maxRetryDelayMs: 10000 } } });
  apply(file);
  const r = provider(read(file));
  assert(
    r.timeoutMs === 900000 && r.maxRetryDelayMs === 60000,
    `our old 10000 ceiling is repaired even when timeoutMs is the operator's (got ${JSON.stringify(r)})`,
  );
}

// ── the write: symlink, mode, one atomic rename, no leftovers ───────────
{
  const real = path.join(root, "dotfiles");
  mkdirSync(real, { recursive: true });
  const realFile = path.join(real, "settings.json");
  writeFileSync(realFile, JSON.stringify({ theme: "dark" }));
  const { file } = agentDir();
  symlinkSync(path.relative(path.dirname(file), realFile), file);
  apply(file);
  assert(
    lstatSync(file).isSymbolicLink(),
    "symlink: the link itself is kept, not replaced by a file",
  );
  assert(
    read(realFile).httpIdleTimeoutMs === 300000 && read(realFile).theme === "dark",
    "symlink: the link's target is the file that was updated",
  );
  assert(
    readdirSync(real).length === 1,
    `symlink: no temp file is left next to the target (got ${readdirSync(real).join(", ")})`,
  );
}
{
  const { file } = agentDir({ theme: "dark" });
  execFileSync("chmod", ["644", file]);
  apply(file);
  assert(
    (statSync(file).mode & 0o777) === 0o644 && read(file).httpIdleTimeoutMs === 300000,
    `mode: an existing 644 is kept (got ${(statSync(file).mode & 0o777).toString(8)})`,
  );
}
{
  const { file } = agentDir({ theme: "dark" });
  const out = apply(file, { PATH: "/nonexistent" });
  assert(
    /jq not found/.test(out) && !/not valid JSON/.test(out),
    `jq missing: says so, not "not valid JSON" (got ${out.trim()})`,
  );
  assert(read(file).httpIdleTimeoutMs === undefined, "jq missing: the file is untouched");
}

// ── shapes we do not understand are skipped, never an abort ─────────────
for (const [label, body] of [
  ["empty file", ""],
  ["top-level array", "[1,2]"],
  ["top-level string", '"x"'],
  ["non-object retry", '{"retry":"fast"}'],
  ["non-object retry.provider", '{"retry":{"provider":3}}'],
] as const) {
  const { file } = agentDir(body);
  let threw = false;
  try {
    apply(file);
  } catch {
    threw = true;
  }
  assert(
    !threw && readFileSync(file, "utf8") === body,
    `${label}: skipped under set -e and left untouched`,
  );
}

// ── no file, and an invalid file: nothing is written ────────────────────
{
  const missing = agentDir();
  apply(missing.file);
  assert(!existsSync(missing.file), "no settings.json: none is created");
  const bad = agentDir("{ not json");
  apply(bad.file);
  assert(readFileSync(bad.file, "utf8") === "{ not json", "invalid JSON: left untouched");
}

rmSync(root, { recursive: true, force: true });
console.log(`\nexit ${exit}`);
process.exit(exit);
