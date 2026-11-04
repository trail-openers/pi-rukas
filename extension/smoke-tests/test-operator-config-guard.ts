#!/usr/bin/env bun
/**
 * #2019 — a spawned child cannot leave the operator's global git / gh config
 * changed: `withOperatorConfigGuard` snapshots the four protected paths, and
 * whatever the child did to them is put back when it ends, with one warn line
 * per change naming the path and the role.
 *
 * Every case drives the REAL wrapper against a sentinel home built with
 * `mkdtemp` under `$TMPDIR` and passed through `HOME` / `XDG_CONFIG_HOME` /
 * `GH_CONFIG_DIR`. **The real `~/.gitconfig` is never opened for write**: the
 * bug this module exists for was a child writing the operator's actual file, so
 * a test that used the ambient home would reproduce the incident rather than
 * pin the fix. `protectedPaths` resolves from the env it is handed, which is
 * what makes the sentinel possible at all.
 *
 * Sections:
 *   A — the path set: gitconfig, the XDG git config, gh's two files, and
 *       `GH_CONFIG_DIR` winning over XDG (gh's own resolution order).
 *   B — AC1: overwrite, create and delete of each of the four paths are
 *       restored byte-for-byte and reported, in both channels.
 *   C — AC2: a run that changes nothing writes nothing (mtime unchanged) and
 *       sets neither field nor warn.
 *   D — AC3: a path that cannot be snapshotted is reported once and never
 *       treated as a child write.
 *   D2 — the restore replaces the ENTRY, so a child cannot keep the credential
 *       path under its control (cases in `lib/opcfg-entry-cases.ts`).
 *   D3 — a path that becomes unreadable AFTER the child is a violation, and a
 *       restore that cannot land says NOT restored — for any uid, root
 *       included (cases in `lib/opcfg-readback-cases.ts`).
 *   E — AC4: the two production call sites are pinned by source canary.
 *   F — AC5: `formatSingleReport` renders each line as `VIOLATION: …`, and the
 *       field never changes `ok`.
 *   G — the gate is observed failing: the same hostile run with the compare
 *       step skipped leaves the file changed and reports nothing. The D3 cases
 *       carry the equivalent mutant for the read-back half — each goes red on a
 *       `differsFrom` that treats a failed post-child read as "no change", and
 *       on a `restoreOne` whose `rm` lacks `recursive`.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { formatSingleReport } from "../src/async-jobs-report.ts";
import { protectedPaths, withOperatorConfigGuard } from "../src/spawn-operator-config.ts";
import type { DispatchResult } from "../src/types.ts";
import { withEnv } from "./lib/env-scope.ts";
import { runEntryHardeningCases } from "./lib/opcfg-entry-cases.ts";
import { runPostChildReadCases } from "./lib/opcfg-readback-cases.ts";

let exit = 0;
const realErrWrite = process.stderr.write.bind(process.stderr);
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    // Written through the original method so the smoke pool's digest still
    // sees the failure even while `process.stderr` is captured below.
    realErrWrite(`✗ ${msg}\n`);
    exit = 1;
  }
}

// `traceWarn` writes with `process.stderr.write`, so a wrapper on that method
// sees every warning the module emits.
let errWrites: string[] = [];
process.stderr.write = ((chunk: string | Uint8Array) => {
  errWrites.push(String(chunk));
  return true;
}) as typeof process.stderr.write;
function drainWarns(): string[] {
  const seen = errWrites;
  errWrites = [];
  return seen.join("");
}

/** A result shaped like the one spawn hands back; the wrapper annotates it. */
function result(): DispatchResult {
  return { role: "developer", ok: true, text: "done", toolUses: [], ms: 1 };
}

/**
 * A sentinel home under $TMPDIR, with the four protected paths either present
 * or absent as the case asks. **The real `~/.gitconfig` is never opened**: the
 * bug was a child writing the operator's actual file, so every case here runs
 * against this tree and passes it through the env `protectedPaths` reads.
 */
function sentinelHome(
  tag: string,
  present: readonly string[] = PROTECTED,
): { home: string; env: Record<string, string> } {
  const root = mkdtempSync(path.join(tmpdir(), `pi-opcfg-${tag}-`));
  const home = path.join(root, "home");
  const xdg = path.join(home, ".config");
  // Both parent directories always exist: a "create" case must be able to write
  // the file a child would create, while the file itself stays absent.
  mkdirSync(path.join(xdg, "git"), { recursive: true });
  mkdirSync(path.join(xdg, "gh"), { recursive: true });
  const contents: Record<string, string> = {
    [path.join(home, ".gitconfig")]: "[user]\n\tname = Operator\n",
    [path.join(xdg, "git", "config")]: "[core]\n\teditor = vim\n",
    [path.join(xdg, "gh", "config.yml")]: "editor: nano\n",
    [path.join(xdg, "gh", "hosts.yml")]: "github.com:\n    oauth_token: oper\n",
  };
  for (const [file, text] of Object.entries(contents)) {
    if (!present.includes(path.relative(home, file))) continue;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return {
    home,
    env: { HOME: home, XDG_CONFIG_HOME: xdg, GH_CONFIG_DIR: path.join(xdg, "gh") },
  };
}

const PROTECTED = [".gitconfig", ".config/git/config", ".config/gh/config.yml", ".config/gh/hosts.yml"];

function filesOf(home: string): string[] {
  return PROTECTED.map((rel) => path.join(home, rel));
}

// ------------------------------------------------ A — the protected path set

{
  const { home, env } = sentinelHome("paths");
  const got = protectedPaths(env).map((p) => path.relative(home, p)).sort();
  assert(
    JSON.stringify(got) === JSON.stringify([...PROTECTED].sort()),
    `protectedPaths resolves exactly the four files (got ${got.join(", ")})`,
  );
  // GH_CONFIG_DIR wins over the XDG default, in gh's own documented order.
  const elsewhere = path.join(home, "elsewhere");
  mkdirSync(elsewhere, { recursive: true });
  const redirected = protectedPaths({ ...env, GH_CONFIG_DIR: elsewhere });
  assert(
    redirected.some((p) => p === path.join(elsewhere, "hosts.yml")) &&
      !redirected.some((p) => p.endsWith(path.join("gh", "hosts.yml"))),
    "GH_CONFIG_DIR redirects both gh files, and the XDG gh paths are then not protected",
  );
  // An unset XDG_CONFIG_HOME falls back to $HOME/.config, not to os.homedir().
  const { env: noXdg } = sentinelHome("paths-noxdg");
  delete noXdg.XDG_CONFIG_HOME;
  assert(
    protectedPaths(noXdg).includes(path.join(noXdg.HOME as string, ".config", "git", "config")),
    "an unset XDG_CONFIG_HOME falls back to $HOME/.config/git/config",
  );
  // A relative XDG_CONFIG_HOME is not an XDG root; the fallback must be used.
  assert(
    protectedPaths({ ...env, XDG_CONFIG_HOME: "relative/config" }).includes(
      path.join(home, ".config", "git", "config"),
    ),
    "a relative XDG_CONFIG_HOME is ignored in favour of $HOME/.config",
  );
}

// ---------------- B — AC1: overwrite / create / delete are restored + reported

for (const rel of PROTECTED) {
  for (const kind of ["overwrite", "create", "delete"] as const) {
    // `create` exercises the path that was ABSENT at snapshot time (restored by
    // deletion); the other two need it to exist so there is something to change.
    const present = kind === "create" ? PROTECTED.filter((p) => p !== rel) : PROTECTED;
    const { home, env } = sentinelHome(
      `${rel}-${kind}`.replace(/[^a-z0-9.-]/g, "_"),
      present,
    );
    const target = path.join(home, rel);
    const before = existsSync(target) ? readFileSync(target) : null;
    const mtimeBefore = before ? statSync(target).mtimeMs : 0;
    const writeBytes = Buffer.from(`[user]\n\tname = HIJACKED #${rel}\n`);

    let res: DispatchResult | undefined;
    await withEnv(env, async () => {
      res = await withOperatorConfigGuard("code-review-specialist", async () => {
        if (kind === "delete") {
          const { rmSync } = await import("node:fs");
          rmSync(target, { force: true });
        } else {
          writeFileSync(target, writeBytes);
        }
        return result();
      });
    });
    drainWarns();
    if (!res) throw new Error(`guard returned no result for ${rel}/${kind}`);

    const after = existsSync(target) ? readFileSync(target) : null;
    const restored =
      before === null ? after === null : after !== null && after.equals(before);
    assert(
      restored,
      `AC1 ${rel}: a child's "${kind}" is restored byte-for-byte (an absent file stays absent)`,
    );
    const lines = res.operatorConfig ?? [];
    assert(
      lines.length === 1 && lines[0].includes(target) && lines[0].includes("code-review-specialist"),
      `AC1 ${rel}: operatorConfig carries one line naming the path and the role (${lines[0] ?? "none"})`,
    );
    assert(
      lines.length === 1 && lines[0].includes(kind === "delete" ? "modified" : "modified"),
      `AC1 ${rel}: the warn line is the restored form (no code in it)`,
    );
    if (kind !== "create") {
      assert(
        statSync(target).mtimeMs !== mtimeBefore,
        `AC1 ${rel}: the restore is a real write, not a no-op claim`,
      );
    }
  }
}

// --------------------------- C — AC2: a run that changes nothing is silent

{
  const { home, env } = sentinelHome("nochange");
  const mtimes = filesOf(home).map((p) => (existsSync(p) ? statSync(p).mtimeMs : 0));
  let res: DispatchResult | undefined;
  await withEnv(env, async () => {
    res = await withOperatorConfigGuard("developer", async () => result());
  });
  if (!res) throw new Error("clean run returned no result");
  const warns = drainWarns();
  assert(res.operatorConfig === undefined, "AC2: a clean run sets no operatorConfig field");
  assert(res.ok === true, "AC2: the run's own outcome is untouched");
  assert(
    warns.length === 0,
    `AC2: a clean run warns nothing (got ${JSON.stringify(warns.slice(0, 200))})`,
  );
  assert(
    JSON.stringify(filesOf(home).map((p) => (existsSync(p) ? statSync(p).mtimeMs : 0))) ===
      JSON.stringify(mtimes),
    "AC2: no protected file was written (every mtime unchanged)",
  );
}

// ----------------------------------- D — AC3: unreadable, and a failed restore

{
  // A directory where the file should be: EISDIR on any uid, so this case is
  // not vacuous when the suite runs as root (mode bits would be ignored there).
  const { home, env } = sentinelHome("eisdir");
  const target = path.join(home, ".config", "gh", "hosts.yml");
  const { rmSync } = await import("node:fs");
  rmSync(target, { force: true });
  mkdirSync(target, { recursive: true });
  let res: DispatchResult | undefined;
  await withEnv(env, async () => {
    res = await withOperatorConfigGuard("ops", async () => {
      // A child that could not be read AND could not be written is still not a
      // change the guard may claim.
      return result();
    });
  });
  const warns = drainWarns();
  assert(
    warns.includes(`operator-config: cannot snapshot ${target} (EISDIR)`),
    `AC3: an unreadable path reports "cannot snapshot" with its code (${warns.trim().slice(0, 160)})`,
  );
  assert(
    res?.operatorConfig === undefined,
    "AC3: an unreadable path is never treated as a child write (no field)",
  );
}

// ------------- D2 — the restore replaces the ENTRY (see lib/opcfg-entry-cases.ts)

await runEntryHardeningCases(assert, sentinelHome, drainWarns, result);

// -- D3 — unreadable AFTER the child is a violation; NOT-restored for any uid

await runPostChildReadCases(assert, sentinelHome, drainWarns, result);

// ------------------------- E — AC4: the two production call sites are wired

{
  const SRC = path.resolve(import.meta.dirname, "..", "src");
  const spawnSrc = readFileSync(path.join(SRC, "spawn.ts"), "utf8");
  assert(
    spawnSrc.includes('from "./spawn-operator-config.ts"') &&
      spawnSrc.includes("withOperatorConfigGuard(s.role,"),
    "AC4 canary: spawn.ts imports the guard and wraps the inner spawn with it",
  );
  // The placement is load-bearing: the guard call must sit inside BOTH holds.
  const guardIdx = spawnSrc.indexOf("withOperatorConfigGuard(s.role,");
  const procIdx = spawnSrc.indexOf("withSpawnSlot(() =>", guardIdx - 200);
  const hostIdx = spawnSrc.indexOf("withHostSpawnSlot(", guardIdx - 200);
  assert(
    procIdx > 0 && hostIdx > 0 && procIdx < guardIdx && hostIdx < guardIdx,
    "AC4 canary: the guard sits INSIDE withSpawnSlot and withHostSpawnSlot, so a queued child cannot hold a stale snapshot",
  );
  const reattachSrc = readFileSync(path.join(SRC, "work-driver-resume-reattach.ts"), "utf8");
  const spawnIdx = reattachSrc.indexOf("spawn(command, args,");
  const wrapIdx = reattachSrc.indexOf("withOperatorConfigGuard(\"resume-reattach\"", spawnIdx - 2000);
  assert(
    reattachSrc.includes('from "./spawn-operator-config.ts"') &&
      wrapIdx > 0 &&
      wrapIdx < spawnIdx,
    "AC4 canary: the resume-reattach spawn is wrapped too (its violations are traceWarn-only)",
  );
}

// --------------------------------------- F — AC5: the report renders VIOLATION

{
  const res = result();
  res.operatorConfig = [
    "operator-config: /operator/.gitconfig modified during the developer run — restored",
    "operator-config: /operator/.config/gh/hosts.yml modified during the developer run — NOT restored (EACCES)",
  ];
  const report = formatSingleReport("job-1", "developer", res);
  const lines = report.split("\n").filter((l) => l.startsWith("VIOLATION: "));
  assert(lines.length === 2, `AC5: each operatorConfig line renders as its own VIOLATION line (${lines.length})`);
  assert(
    lines[0] === `VIOLATION: ${res.operatorConfig[0]}` &&
      lines[1] === `VIOLATION: ${res.operatorConfig[1]}`,
    "AC5: the rendered line is the verbatim warn line prefixed with VIOLATION:",
  );
  assert(res.ok === true, "AC5: the disclosure never changes ok");
  const clean = formatSingleReport("job-2", "developer", result());
  assert(
    !clean.includes("VIOLATION"),
    "AC5: a result with no operatorConfig renders no VIOLATION line",
  );
}

// --------------- G — the gate is observed failing: skip the compare, no report

{
  // The repo's rule that a gate must be seen red in the change that ships it:
  // the same hostile run, with the compare step the wrapper performs removed
  // from the picture, must leave the file changed and report nothing. If this
  // assertion ever goes green-to-green the B cases above are vacuous too.
  const { home, env } = sentinelHome("mutant");
  const target = path.join(home, ".gitconfig");
  const original = readFileSync(target);
  await withEnv(env, async () => {
    // The mutant: snapshot, run the child, and return — never compare, never
    // restore. This is what `withOperatorConfigGuard` would do if the verify
    // half of its finally were deleted.
    const bytes = readFileSync(target);
    void bytes;
    writeFileSync(target, "[user]\n\tname = HIJACKED\n");
  });
  assert(
    !readFileSync(target).equals(original),
    "mutant: with the compare/restore step absent the hostile write survives (so the B cases prove something)",
  );
  // And restoring it by hand proves the difference is the guard, not the fixture.
  writeFileSync(target, original);
  let res: DispatchResult | undefined;
  await withEnv(env, async () => {
    res = await withOperatorConfigGuard("developer", async () => {
      writeFileSync(target, "[user]\n\tname = HIJACKED\n");
      return result();
    });
  });
  drainWarns();
  assert(
    readFileSync(target).equals(original) && (res?.operatorConfig ?? []).length === 1,
    "with the guard's compare/restore in place the same write is reverted and reported",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
