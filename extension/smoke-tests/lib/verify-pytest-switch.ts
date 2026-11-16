#!/usr/bin/env bun
/**
 * #2282 — the `PI_ENSEMBLE_VERIFY_PYTEST` switch's contract, stated once and
 * shared by both of this arm's smoke tests.
 *
 * The arm has two files: this lib holds the vocabulary (the one string the arm
 * discovers, the fixture builder, the two switch helpers) so the two suites
 * cannot drift apart on the thing they most need to agree about — the exact
 * command bytes. A test that asserted on a re-typed copy of the command would
 * keep passing if the resolver changed its interpreter form, which is precisely
 * the defect #2282 is about.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The command the arm discovers for a pyproject repo that names pytest, with no
 * `uv.lock` and no ruff config. Every gate-level case pins the recorded run
 * against this string, and `docs/configuration.md` names it too — so the three
 * sites agree by importing/matching one value rather than by three transcriptions.
 */
export const PY_CMD = "python3 -m pytest -q";

/** A throwaway Python repo: a pyproject that names pytest, and one passing test.
 * `ruff` adds a `[tool.ruff]` table (the lint half of the command); `uvLock`
 * drops in the lockfile that selects the `uv run` interpreter form. */
export function pythonRepo(
  opts: { ruff?: boolean; uvLock?: boolean; prefix?: string } = {},
): string {
  const dir = mkdtempSync(path.join(tmpdir(), opts.prefix ?? "verify-pytest-"));
  const manifest = '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n';
  writeFileSync(
    path.join(dir, "pyproject.toml"),
    opts.ruff ? `${manifest}\n[tool.ruff]\nline-length = 100\n` : manifest,
  );
  if (opts.uvLock) writeFileSync(path.join(dir, "uv.lock"), "");
  mkdirSync(path.join(dir, "tests"));
  writeFileSync(path.join(dir, "tests", "test_ok.py"), "def test_ok():\n    assert True\n");
  return dir;
}

/**
 * Run `body` with a private directory as the ENTIRE `PATH`, holding one
 * executable named `python3` — or none at all, when `source` is the empty string.
 *
 * Why these cases may not name a host directory. The shape they first took ran
 * under `PATH=/usr/bin:/bin`, which reads the runner's own interpreter. CI's
 * runner HAS a `/usr/bin/python`, so the bare-`python` case came back exit 1 with
 * `No module named pytest` instead of 127 with "not found"; it has no importable
 * `pytest`, so the collected-nothing case saw that exit 1 where a host with pytest
 * saw the exit 5 the case was written for; and the green control could not run at
 * all. Three assertions whose verdict was a property of the machine. What each
 * case claims is what `execp` does with an exit code, and that is answerable only
 * against an interpreter the test itself pins: the PATH the case chooses, and
 * nothing else.
 *
 * The stub is written `0o755` because the shell resolves the tool by name off
 * PATH and execs it; and `execp`'s shell is `/bin/sh` by absolute path, so a
 * stub-only PATH still starts a shell — the command, not the interpreter, is what
 * these cases take away.
 *
 * `process.env.PATH` is reassigned rather than passed as an `env` option because
 * the driver's shell executor scrubs the caller's env on its way to the spawn
 * (`shellExecp` → `verifyChildEnv`): a hand-pinned PATH would be judged by a scrub
 * built to drop the DRIVER's knobs, which is not what a case is deciding. The
 * ambient write is read at spawn time. Restoring it in `finally` is load-bearing,
 * not tidiness: the real-git cases further down resolve `git` off this same PATH.
 */
export async function withPath<T>(source: string, body: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), "verify-pytest-bin-"));
  if (source !== "") writeFileSync(path.join(dir, "python3"), source, { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = dir;
  try {
    return await body();
  } finally {
    process.env.PATH = saved;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The fields `execp`'s rejection carries: the reason the gate forwards. */
export type Rejection = { code?: unknown; stdout?: string; stderr?: string; message?: string };

/** Everything a rejection said, in the one order the cases match against. */
export function rejectedText(e: Rejection): string {
  return `${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message ?? ""}`;
}

/** Run `body` with the named env var set to `value` (or absent, for
 * `undefined`), restoring the prior state afterwards. A function rather than a
 * `try/finally` block at each call site because the drives below await a value
 * out of it, and a bare block would hand them `undefined`. */
export async function withEnv<T>(
  name: string,
  value: string | undefined,
  body: () => Promise<T> | T,
): Promise<T> {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const prev = process.env[name];
  // An `undefined` value must REMOVE the key: assigning one stringifies to
  // `"undefined"`, which is neither the absent arm nor an off arm — and an
  // ambient value leaking in from the harness would decide a case by itself.
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await body();
  } finally {
    if (had && prev !== undefined) process.env[name] = prev;
    else delete process.env[name];
  }
}

export function withEnvRun<T>(name: string, value: string, read: () => T): T {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const prev = process.env[name];
  process.env[name] = value;
  try {
    return read();
  } finally {
    if (had && prev !== undefined) process.env[name] = prev;
    else delete process.env[name];
  }
}
