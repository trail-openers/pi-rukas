#!/usr/bin/env bun
/**
 * Platform guard for install.sh — issue #491.
 *
 * install.sh refuses to run when `uname -s` is neither `Linux` nor `Darwin`,
 * before any side effects (prompt build, symlinks, docker pull). The
 * classification is a small named bash function in the script,
 * `classify_os()`, so this test drives it with FAKED uname values instead of
 * spawning the installer on a real foreign OS: the function body is extracted
 * from install.sh by regex and inlined into a fresh `bash -c` snippet that
 * fakes `UNAME_S` and maps the "unsupported" result to `exit 1`; install.sh
 * itself is never sourced or executed, so no install side effects run.
 *
 * The guard is deliberately NEGATIVE (refuse when not Linux and not Darwin)
 * rather than a positive match on MSYS/MINGW/CYGWIN: a bash script can
 * only run on Windows under Git Bash, MSYS2, Cygwin or WSL, so a positive
 * matchlist catches the closest-to-working environments and misses every
 * genuinely broken one. See install.sh at the guard.
 *
 * Native PowerShell and cmd never reach the script at all — the shebang
 * excludes them — and are covered by the README statement alone; this test
 * asserts the guard's own comment records that.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const INSTALL_SH = path.join(import.meta.dirname, "..", "..", "install.sh");

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/**
 * Run a snippet in a fresh bash session with install.sh's classifier
 * extracted from the source, and a faked `exit` so the refusal path can be
 * exercised without killing the shell.
 */
function classify(unameValue: string): {
  code: "supported" | "unsupported";
  exitCode: number | null;
} {
  // Extract the function body from the script verbatim, then drive it.
  const script = readFileSync(INSTALL_SH, "utf8");
  const fnMatch = script.match(/^classify_os\(\) \{[\s\S]*?^\}\n/m);
  if (!fnMatch) {
    throw new Error("install.sh: classify_os() function not found — guard was removed or renamed");
  }
  const fn = fnMatch[0];
  const code = `
    ${fn}
    UNAME_S="${unameValue}"
    result="$(classify_os "$UNAME_S")"
    if [ "$result" = "unsupported" ]; then
      exit 1
    fi
    echo "$result"
  `;
  try {
    const trimmed = execFileSync("bash", ["-c", code], { encoding: "utf8" }).trim();
    // execFileSync throws on any non-zero exit, so a 0-exit can only be the
    // classifier's echo of a supported value — narrow instead of casting so a
    // future classifier typo fails loudly here rather than in the assert.
    if (trimmed !== "supported") {
      throw new Error(`unexpected classifier output: ${JSON.stringify(trimmed)}`);
    }
    return { code: "supported", exitCode: null };
  } catch (e: unknown) {
    const err = e as { status?: number };
    // Only the snippet's deliberate `exit 1` (the refusal path) reads as
    // "unsupported"; any other non-zero exit is a test-infrastructure failure.
    if (err.status === 1) return { code: "unsupported", exitCode: 1 };
    throw e;
  }
}

// ---------------------------------------------- the classifier itself

{
  const cases: Array<[unameValue: string, expected: "supported" | "unsupported"]> = [
    ["Darwin", "supported"],
    // Linux (also reported by WSL2) — supported. WSL2 must pass — expected to
    // work, untested, but the guard must not be the thing that blocks it.
    ["Linux", "supported"],
    ["MINGW64_NT-10.0-19045", "unsupported"],
    ["CYGWIN_NT-10.0-19045", "unsupported"],
    ["MSYS_NT-10.0-19045", "unsupported"],
    // BSDs and exotic Unixes are refused: the README names only macOS and
    // Linux, so refusing them converts a partial install into a clean refusal.
    ["FreeBSD", "unsupported"],
    ["SunOS", "unsupported"],
  ];
  for (const [unameValue, expected] of cases) {
    const { code, exitCode } = classify(unameValue);
    if (expected === "unsupported") {
      assert(exitCode === 1, `classify_os(${unameValue}) exits with status 1`);
    } else {
      assert(exitCode === null, `classify_os(${unameValue}) does not exit`);
    }
    assert(
      code === expected,
      `classify_os(${unameValue}) → ${code} (faked uname; expected ${expected})`,
    );
  }
}

// ---------------------------------------------- the guard refuses early

// The guard must run BEFORE any side effects: no build, no symlink, no
// docker interaction. Positional check — the guard's exit comes before the
// first side-effecting command in the script (`mkdir -p` of the skills dir,
// pinned by the "first side effect" marker comment), not before a later
// section's echo.
{
  const script = readFileSync(INSTALL_SH, "utf8");
  const guardIdx = script.indexOf("This system's uname");
  const buildIdx = script.indexOf('echo "==> Building role prompts"');
  const sideEffectIdx = script.indexOf("first side effect");
  const symlinkRmIdx = script.indexOf('rm -f "$target"');
  assert(guardIdx !== -1, "guard refusal message is present in install.sh");
  assert(
    guardIdx !== -1 && sideEffectIdx !== -1 && guardIdx < sideEffectIdx,
    "guard fires before the first side effect (skills symlink mkdir) — a partial install must not be attempted",
  );
  assert(
    guardIdx !== -1 && buildIdx !== -1 && guardIdx < buildIdx,
    "guard fires before the role-prompt build",
  );
  assert(
    guardIdx !== -1 && symlinkRmIdx !== -1 && guardIdx < symlinkRmIdx,
    "guard fires before the stale-symlink cleanup loop",
  );
  const exitIdx = script.indexOf("exit 1", guardIdx);
  assert(
    guardIdx !== -1 && exitIdx !== -1 && exitIdx < sideEffectIdx,
    "guard exits with status 1 on refusal",
  );
}

// ---------------------------------------------- the guard's own comments

{
  const script = readFileSync(INSTALL_SH, "utf8");
  assert(
    /never reach this script at all/.test(script) && /shebang/.test(script),
    "comment at the guard records that native PowerShell and cmd never reach the script — the shebang excludes them",
  );
  assert(
    /README/.test(script.slice(0, script.indexOf("This system's uname"))),
    "comment at the guard points to the README platform statement as the surface those shells are addressed by",
  );
}

console.log(exit === 0 ? "\nAll OS guard checks passed." : "\nFAILED");
process.exit(exit);
