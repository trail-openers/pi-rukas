#!/usr/bin/env bun
/**
 * Smoke test for sandbox-fs-guard's path-boundary enforcement, split out of
 * test-permission-guard.ts (#171, AGENTS.md §12 file-size limit).
 *
 * Tests (no Pi children spawned):
 *   - L8 (PR #197): out-of-workspace paths rejected; FS-agnostic tools and
 *     unknown argument keys skip the check
 *   - PR #207: PI_ENSEMBLE_WORKSPACE_ROOT overrides the default /workspace
 *     boundary, with separator-boundary correctness for prefix-sharing
 *     sibling dirs
 *   - PR #213: PI_ENSEMBLE_ALLOWED_ROOTS extends the boundary for image
 *     drag-and-drop dirs (Downloads/Pictures/etc)
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

let exitCode = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exitCode = 1;
  }
}

console.log("=== test-sandbox-fs-guard-boundary summary ===\n");

// === L8 (PR #197): sandbox-fs-guard rejects out-of-workspace paths ===
// CVE-2026-39861 class: symlink at /workspace/escape → /etc lets sandboxed
// agents read host config. sandbox-fs-guard canonicalises path arguments
// (`path` / `file_path` / `cwd` / `dir` / `target` / `filepath`) and rejects
// resolved paths outside /workspace.
{
  const { checkSandboxFsArgs } = await import("../src/sandbox-fs-guard.js");

  // FS-agnostic tools always pass.
  assert(
    checkSandboxFsArgs("websearch", { query: "/etc/passwd" }).ok === true,
    "L8: sandbox-fs-guard: FS-agnostic tools (websearch) skip the path check entirely",
  );
  assert(
    checkSandboxFsArgs("vipune", { query: "/etc/passwd" }).ok === true,
    "L8: sandbox-fs-guard: vipune tool skips the path check",
  );

  // Relative paths inside /workspace pass.
  assert(
    checkSandboxFsArgs("read", { path: "src/index.ts" }).ok === true,
    "L8: sandbox-fs-guard: relative paths permitted (resolve to /workspace via cwd)",
  );

  // Absolute paths outside /workspace are blocked.
  const blocked = checkSandboxFsArgs("read", { path: "/etc/passwd" });
  assert(blocked.ok === false, "L8: sandbox-fs-guard: absolute path /etc/passwd rejected");
  if (!blocked.ok) {
    assert(
      blocked.reason.includes("outside the sandbox workspace"),
      "L8: sandbox-fs-guard: rejection carries a clear reason",
    );
  }

  // file_path / cwd / dir / target are all checked, not just `path`.
  for (const key of ["file_path", "cwd", "dir", "target", "filepath"]) {
    const v = checkSandboxFsArgs("write", { [key]: "/etc/shadow" });
    assert(
      v.ok === false,
      `L8: sandbox-fs-guard: ${key} argument also gets canonicalised + checked`,
    );
  }

  // Unknown path-arg keys are NOT checked (avoid false positives on tool
  // calls that happen to have a `name: "/etc/foo"` string field).
  assert(
    checkSandboxFsArgs("read", { name: "/etc/passwd" }).ok === true,
    "L8: sandbox-fs-guard: unknown argument keys are not auto-checked (only well-known FS keys)",
  );
}

// === PR #207: sandbox-fs-guard reads PI_ENSEMBLE_WORKSPACE_ROOT env var ===
// The wrapper now mounts the project at its host absolute path (e.g.
// /Users/janni/projects/nessie) instead of /workspace. The guard's
// boundary check must follow — read the env var, fall back to /workspace
// for raw `docker run` users without the wrapper.
//
// Use mkdtempSync to get a real non-symlinked dir for the boundary
// (macOS /tmp is a symlink to /private/tmp, which trips realpath
// resolution and defeats the prefix-match test).
{
  const { checkSandboxFsArgs } = await import("../src/sandbox-fs-guard.js");

  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pi-ensemble-fs-guard-")));
  const inside = path.join(root, "some-file");
  // Sibling dir with overlapping prefix to test separator-boundary
  const sibling = `${root}-elsewhere`;
  mkdirSync(sibling, { recursive: true });

  const prev = process.env.PI_ENSEMBLE_WORKSPACE_ROOT;
  try {
    process.env.PI_ENSEMBLE_WORKSPACE_ROOT = root;

    // Inside the new boundary → permitted.
    const insideOk = checkSandboxFsArgs("read", { path: inside });
    assert(
      insideOk.ok === true,
      `PR #207: PI_ENSEMBLE_WORKSPACE_ROOT honored — inside-root path permitted (root=${root}, candidate=${inside})`,
    );

    // Outside the new boundary → rejected.
    const outside = checkSandboxFsArgs("read", { path: "/etc/passwd" });
    assert(
      outside.ok === false,
      "PR #207: PI_ENSEMBLE_WORKSPACE_ROOT honored — /etc/passwd rejected",
    );
    if (!outside.ok) {
      assert(
        outside.reason.includes(root),
        "PR #207: rejection reason names the active workspace root",
      );
    }

    // Separator-boundary check — a sibling dir sharing root's prefix
    // ("/.../pi-ensemble-fs-guard-XXX-elsewhere") should NOT be inside
    // the root.
    const tokenBoundary = checkSandboxFsArgs("read", { path: path.join(sibling, "foo") });
    assert(
      tokenBoundary.ok === false,
      "PR #207: separator boundary respected — sibling-with-prefix is NOT inside root",
    );
  } finally {
    if (prev === undefined) delete process.env.PI_ENSEMBLE_WORKSPACE_ROOT;
    else process.env.PI_ENSEMBLE_WORKSPACE_ROOT = prev;
    rmSync(root, { recursive: true, force: true });
    rmSync(sibling, { recursive: true, force: true });
  }
}

// === PR #213: PI_ENSEMBLE_ALLOWED_ROOTS extends the FS boundary ===
// For image drag-and-drop: the wrapper bind-mounts $HOME/Downloads,
// $HOME/Desktop, $HOME/Pictures and exports their paths in
// PI_ENSEMBLE_ALLOWED_ROOTS. The fs-guard treats those as in-bounds.
{
  const { checkSandboxFsArgs } = await import("../src/sandbox-fs-guard.js");

  const workspace = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pi-ensemble-fs-ws-")));
  const downloads = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pi-ensemble-fs-dl-")));
  const pictures = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pi-ensemble-fs-pics-")));
  const outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pi-ensemble-fs-outside-")));

  const prevWs = process.env.PI_ENSEMBLE_WORKSPACE_ROOT;
  const prevAllowed = process.env.PI_ENSEMBLE_ALLOWED_ROOTS;
  try {
    process.env.PI_ENSEMBLE_WORKSPACE_ROOT = workspace;
    process.env.PI_ENSEMBLE_ALLOWED_ROOTS = `${downloads}:${pictures}`;

    // Path inside workspace → permitted (existing behavior).
    const wsPath = checkSandboxFsArgs("read", { path: path.join(workspace, "code.ts") });
    assert(wsPath.ok === true, "PR #213: workspace path still permitted with allowed-roots set");

    // Path inside an ALLOWED root → permitted (the new behavior).
    const dlPath = checkSandboxFsArgs("read", { path: path.join(downloads, "screenshot.png") });
    assert(
      dlPath.ok === true,
      "PR #213: paths inside PI_ENSEMBLE_ALLOWED_ROOTS dirs are permitted",
    );

    const picPath = checkSandboxFsArgs("read", { path: path.join(pictures, "photo.jpg") });
    assert(picPath.ok === true, "PR #213: multiple allowed roots — all of them permit reads");

    // Path OUTSIDE both workspace and allowed roots → still rejected.
    const outsidePath = checkSandboxFsArgs("read", { path: path.join(outside, "secret.txt") });
    assert(
      outsidePath.ok === false,
      "PR #213: paths outside workspace AND outside allowed roots still rejected",
    );
    if (!outsidePath.ok) {
      assert(
        outsidePath.reason.includes(downloads) && outsidePath.reason.includes(pictures),
        "PR #213: rejection reason lists all permitted roots so the LLM can react",
      );
    }

    // Empty PI_ENSEMBLE_ALLOWED_ROOTS → only workspace permits (regression
    // guard for the workspace-only mode).
    process.env.PI_ENSEMBLE_ALLOWED_ROOTS = "";
    const dlAfterUnset = checkSandboxFsArgs("read", { path: path.join(downloads, "x.png") });
    assert(
      dlAfterUnset.ok === false,
      "PR #213: clearing PI_ENSEMBLE_ALLOWED_ROOTS reverts to workspace-only",
    );
  } finally {
    if (prevWs === undefined) delete process.env.PI_ENSEMBLE_WORKSPACE_ROOT;
    else process.env.PI_ENSEMBLE_WORKSPACE_ROOT = prevWs;
    if (prevAllowed === undefined) delete process.env.PI_ENSEMBLE_ALLOWED_ROOTS;
    else process.env.PI_ENSEMBLE_ALLOWED_ROOTS = prevAllowed;
    rmSync(workspace, { recursive: true, force: true });
    rmSync(downloads, { recursive: true, force: true });
    rmSync(pictures, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
}

console.log("\n=== test-sandbox-fs-guard-boundary summary ===");
console.log(`exit ${exitCode}`);
process.exit(exitCode);
