#!/usr/bin/env bun
/**
 * #1730 A — the private-backlog reminder a PM session gets when an operator
 * clones their real priority order into `<repository root>/.backlog/`.
 *
 * The invariant this feature lives or dies on is a NEGATIVE one: with nothing
 * to remind about, the PM's instructions are byte-identical to what they were
 * before this module existed. Every way this can go wrong is a version of "it
 * fired when it should not have" — a directory that merely shares the name, a
 * `backlog.md` that is a symlink, a session started in a subdirectory, a child
 * that picked the paragraph up. So the baseline (no `.backlog/`) is captured
 * ONCE, in this run, and every silent case is compared to it as a STRING: a
 * substring test would pass while the paragraph leaked into a case that must
 * stay silent, as long as the leak also appeared in the baseline. Nothing here
 * quotes the sticky preamble's own prose — the baseline IS the preamble's text
 * for this run, so a preamble edit cannot break this test.
 *
 * Groups:
 *   1. no `.backlog/` → byte-identical to the pre-feature prompt;
 *   2. `.backlog` as a real clone with `backlog.md` → the paragraph appended,
 *      exactly once, on every turn (the probe is per turn, not memoised);
 *   3. the silent shapes: no clone marker, plain-file `.backlog`, `backlog.md`
 *      as a directory, `backlog.md` as a symlink, an unreadable `.backlog`, no
 *      session dir, and the `PI_ENSEMBLE_BACKLOG_REMINDER=0` kill switch;
 *   4. a session started in a SUBDIRECTORY still finds the root's backlog
 *      (the root is resolved by walking up, without running git);
 *   5. the backlog's own text never reaches the prompt, no git runs, and no
 *      child path reaches it — statically (commands.ts is the only importer)
 *      and at runtime (PM mode unarmed → the hook contributes nothing).
 *
 * The doctrine one-shot is drained before any assertion, so every prompt here
 * is sticky-preamble-only and nothing depends on `dist/prompts/` being built.
 */

import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock } from "bun:test";
import { BACKLOG_REMINDER, backlogReminderSection } from "../src/backlog-reminder.ts";
import { registerCommands } from "../src/commands.ts";
import { armPmMode, resetPmMode, takeDoctrinePending } from "../src/pm-mode.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const SRC = path.resolve(import.meta.dirname, "..", "src");
const readSrc = (f: string): string => {
  try {
    return readFileSync(path.join(SRC, f), "utf8");
  } catch {
    return "";
  }
};
/**
 * Comments are not code. Every "this module never does X" assertion below is a
 * claim about the executable text, and the seam's own docstring says the words
 * `readFile` and `git` while explaining that it does NOT call them — matching
 * on the raw file would fail the honest module and pass the one that quietly
 * added `await fs.readFile(...)` under a comment saying it never reads.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

// ------------------------------------------------------------------ the harness

interface FakeCtx {
  cwd?: string;
  ui: { notify: (msg: string, kind?: string) => void };
}

/** The hook as Pi calls it — two parameters, the second carrying `cwd`. */
type Hook = (
  event: { type?: string; prompt?: string; systemPrompt?: string; systemPromptOptions?: unknown },
  ctx: FakeCtx,
) => Promise<{ systemPrompt: string } | undefined>;

const hooks: Hook[] = [];
const pi = {
  registerTool: () => undefined,
  registerCommand: () => undefined,
  on: (event: string, handler: Hook) => {
    if (event === "before_agent_start") hooks.push(handler);
    return () => undefined;
  },
  sendUserMessage: () => undefined,
  sendMessage: () => undefined,
  getCommands: () => [],
  getAllTools: () => [],
  setActiveTools: () => undefined,
};

// Only the command/doctrine registration — the full extension entry would also
// arm process-wide watchers this test has no use for.
// biome-ignore lint/suspicious/noExplicitAny: mock pi is narrower than ExtensionAPI
registerCommands(pi as any);
assert(hooks.length === 1, "exactly one before_agent_start hook — the only PM seam");
const hook = hooks[0] as Hook;

const TMP = mkdtempSync(path.join(tmpdir(), "pi-backlog-reminder-"));
const BACKLOG_FILE_NAME = "backlog.md";
/** Content the reminder must NEVER echo — part B renders it, part A only
 * states the file exists. If any of this shows up in a prompt, the seam read it. */
const SECRET_BODY = "SECRET-BACKLOG-ORDER-DO-NOT-RENDER\n## Now (in order)\n- ship the thing\n";

/** A temp stand-in for "the repository the session believes it is standing in". */
function repo(named: string): string {
  const dir = path.join(TMP, named);
  mkdirSync(dir, { recursive: true });
  return dir;
}
/** Make a temp dir look like a git working tree, so the root walk stops at it. */
function asClone(dir: string): string {
  mkdirSync(path.join(dir, ".git"), { recursive: true });
  return dir;
}
/** The shape that turns the reminder on: a clone with a regular `backlog.md`. */
function withBacklogRepo(named: string): string {
  const dir = asClone(repo(named));
  const bl = path.join(dir, ".backlog");
  mkdirSync(path.join(bl, ".git"), { recursive: true });
  writeFileSync(path.join(bl, BACKLOG_FILE_NAME), SECRET_BODY);
  return dir;
}

const BASE = "PI_BASE_PROMPT";
async function run(cwd: string | undefined): Promise<string | undefined> {
  const ctx: FakeCtx = { cwd, ui: { notify: () => undefined } };
  const out = await hook(
    { type: "before_agent_start", prompt: "x", systemPrompt: BASE, systemPromptOptions: {} },
    ctx,
  );
  return out?.systemPrompt;
}

/** Arm PM mode and spend the one-shot full doctrine up front. */
function armSession(): void {
  resetPmMode();
  armPmMode();
  takeDoctrinePending();
}

// ------------------------------------------- 1. the baseline: no `.backlog/` at all

const plain = asClone(repo("plain"));
armSession();
const baseline = await run(plain);
assert(typeof baseline === "string" && baseline.length > BASE.length, "PM mode: the hook appends to the prompt");
assert(
  baseline !== undefined && baseline.startsWith(`${BASE}\n\n`) && !baseline.toLowerCase().includes("backlog"),
  "no .backlog/ → nothing mentioning a backlog reaches the PM's instructions",
);
// The pre-feature prompt was exactly `base + sticky preamble` (the full 53K
// doctrine is one-shot and was drained above). Assert that shape rather than
// quoting the preamble: this run's baseline IS its text, so nothing here can
// drift when the preamble's prose changes.
assert(
  (baseline ?? "").length < BASE.length + 4000,
  "the baseline is preamble-sized, not doctrine-sized (the one-shot really was drained)",
);

// ------------------------------------ 2. a real clone → the paragraph, once per turn

const withBacklog = withBacklogRepo("with-backlog");
armSession();
const reminded = await run(withBacklog);
assert(
  reminded === `${baseline}\n\n${BACKLOG_REMINDER}`,
  "backlog present → exactly ONE paragraph appended after the existing pieces, byte-exact",
);
assert(
  (reminded ?? "").split(BACKLOG_REMINDER).length - 1 === 1,
  "the paragraph appears exactly once, not duplicated",
);
assert(
  (reminded ?? "").includes(".backlog/backlog.md") &&
    (reminded ?? "").includes("## Now (in order)") &&
    (reminded ?? "").includes("Triage"),
  "it names the path, the agreed-order list, and the Triage rule",
);
assert(
  (reminded ?? "").includes("never by editing the file without committing"),
  "it forbids reordering without an operator-approved commit to that repository",
);

// Per turn, not per session: PM re-reads it every turn it is in orchestrator
// mode, and a backlog cloned mid-session must be heard without a restart.
const second = await run(withBacklog);
assert(second === `${baseline}\n\n${BACKLOG_REMINDER}`, "turn 2 appends it again — once, the same bytes");
assert(
  (second ?? "").split(BACKLOG_REMINDER).length - 1 === 1,
  "turn 2 still has it exactly once (no accumulation across turns)",
);

// ----------------------------------------------------- 3. the silent-absence cases

/** A filesystem shape that must be indistinguishable from "no backlog at all". */
async function expectSilent(named: string, seed: (dir: string) => void): Promise<void> {
  const dir = asClone(repo(`silent-${named}`));
  seed(dir);
  armSession();
  let out: string | undefined;
  try {
    out = await run(dir);
  } finally {
    // Undo a 0o000 the recursive rm at the end could not walk through; a case
    // that never locked a directory has nothing to restore.
    try {
      chmodSync(path.join(dir, ".backlog"), 0o755);
    } catch {
      /* nothing was locked */
    }
  }
  assert(out === baseline, `.backlog ${named}: byte-identical to the no-backlog baseline`);
}

await expectSilent("is-a-plain-file", (dir) => writeFileSync(path.join(dir, ".backlog"), SECRET_BODY));
await expectSilent("clone-without-backlog-md", (dir) => mkdirSync(path.join(dir, ".backlog", ".git"), { recursive: true }));
await expectSilent("md-is-a-directory", (dir) => {
  mkdirSync(path.join(dir, ".backlog", ".git"), { recursive: true });
  mkdirSync(path.join(dir, ".backlog", BACKLOG_FILE_NAME), { recursive: true });
});
// The provenance rule: a directory called `.backlog` holding a plausible
// `backlog.md` is not the operator's private clone until a `.git` says so.
await expectSilent("no-clone-marker", (dir) => {
  mkdirSync(path.join(dir, ".backlog"), { recursive: true });
  writeFileSync(path.join(dir, ".backlog", BACKLOG_FILE_NAME), SECRET_BODY);
});
// A `backlog.md` that is a symlink is somebody else's file, and the paragraph
// tells the PM to treat what it finds there as the agreed order.
await expectSilent("md-is-a-symlink", (dir) => {
  const bl = path.join(dir, ".backlog");
  mkdirSync(path.join(bl, ".git"), { recursive: true });
  writeFileSync(path.join(dir, "elsewhere.md"), SECRET_BODY);
  symlinkSync(path.join(dir, "elsewhere.md"), path.join(bl, BACKLOG_FILE_NAME));
});
if (process.getuid?.() === 0) {
  console.log("– skipped: .backlog is unreadable (EACCES) — root ignores the 0o000 mode, so it would prove nothing");
} else {
  await expectSilent("dir-is-unreadable", (dir) => {
    const bl = path.join(dir, ".backlog");
    mkdirSync(bl);
    writeFileSync(path.join(bl, BACKLOG_FILE_NAME), SECRET_BODY);
    chmodSync(bl, 0o000);
  });
}

armSession();
assert(
  (await run(undefined)) === baseline,
  "no session dir at all → nothing appended (no process.cwd() probe), and the turn still gets its preamble",
);

// The kill switch: the probe must not run at all, so a backlog on disk stays
// unmentioned.
const killSwitch = withBacklogRepo("kill-switch");
process.env.PI_ENSEMBLE_BACKLOG_REMINDER = "0";
armSession();
assert((await run(killSwitch)) === baseline, "PI_ENSEMBLE_BACKLOG_REMINDER=0 → no reminder, backlog or not");
delete process.env.PI_ENSEMBLE_BACKLOG_REMINDER;
armSession();
assert(
  (await run(killSwitch)) === `${baseline}\n\n${BACKLOG_REMINDER}`,
  "and with the switch unset again, the very same repo does remind (the run above was the switch, not the fixture)",
);

// The probe itself never rejects, whatever the filesystem says.
for (const [label, seed] of [
  ["a plain directory, no backlog anywhere", (d: string) => mkdirSync(path.join(d, "nothing-here"))],
  ["an unreadable .backlog (EACCES)", (d: string) => {
    const bl = path.join(d, ".backlog");
    mkdirSync(bl);
    writeFileSync(path.join(bl, BACKLOG_FILE_NAME), "x");
    chmodSync(bl, 0o000);
  }],
] as const) {
  if (label.includes("EACCES") && process.getuid?.() === 0) {
    console.log(`– skipped: the probe (${label}) — root ignores the 0o000 mode`);
    continue;
  }
  const dir = asClone(repo(`probe-${label.replace(/[^a-z]+/g, "-")}`));
  seed(dir);
  let threw = false;
  let value = "unset";
  try {
    value = await backlogReminderSection(dir);
  } catch {
    threw = true;
  } finally {
    try {
      chmodSync(path.join(dir, ".backlog"), 0o755);
    } catch {
      /* nothing was locked */
    }
  }
  assert(!threw, `the probe (${label}) never throws`);
  assert(
    value === "" || value === BACKLOG_REMINDER,
    `the probe (${label}) answers with the empty string or the paragraph, nothing else`,
  );
}

{
  // The probe is read live: a directory that grows a backlog between two calls
  // changes the answer, which is what dropping the memo bought.
  const late = asClone(repo("late-clone"));
  assert((await backlogReminderSection(late)) === "", "an empty repo answers with the empty string");
  mkdirSync(path.join(late, ".backlog", ".git"), { recursive: true });
  writeFileSync(path.join(late, ".backlog", BACKLOG_FILE_NAME), SECRET_BODY);
  assert(
    (await backlogReminderSection(late)) === BACKLOG_REMINDER,
    "a backlog cloned AFTER the first probe is heard on the next call (no memo, no stale answer)",
  );
}

// ------------------- 4. a session started in a subdirectory still finds the root

{
  const deep = path.join(withBacklog, "extension", "smoke-tests");
  mkdirSync(deep, { recursive: true });
  armSession();
  const nested = await run(deep);
  assert(
    nested === `${baseline}\n\n${BACKLOG_REMINDER}`,
    "a session started two directories down still gets the reminder — the root is resolved by walking up",
  );
  // And the walk is bounded. A session 60 levels below the nearest `.git` is
  // past `MAX_ROOT_HOPS`, so the probe gives up: no reminder, and — the part
  // that matters — no throw and no turn lost.
  let beyondBound = asClone(repo("beyond-bound"));
  for (let i = 0; i < 60; i++) beyondBound = path.join(beyondBound, "level");
  mkdirSync(beyondBound, { recursive: true });
  mkdirSync(path.join(beyondBound, ".backlog", ".git"), { recursive: true });
  writeFileSync(path.join(beyondBound, ".backlog", BACKLOG_FILE_NAME), SECRET_BODY);
  armSession();
  assert(
    (await run(beyondBound)) === baseline,
    "a session past the walk bound finds no root → silent, bounded, and still gets its preamble",
  );
}

// ------------------------------------ 5. the content is not read, and git is not run

{
  const seam = stripComments(readSrc("backlog-reminder.ts"));
  assert(seam.length > 0, "non-vacuity: backlog-reminder.ts was read");
  assert(
    !/readFile|createReadStream|openSync|readdir/.test(seam),
    "the seam never reads the backlog's content — part B renders it, part A states it exists",
  );
  assert(
    !/child_process|execFile|execp|spawn\s*\(|\bgit\b\s*\(/.test(seam),
    "the seam never runs git or any other subprocess",
  );
  assert(
    !(reminded ?? "").includes("SECRET-BACKLOG-ORDER-DO-NOT-RENDER") &&
      !(reminded ?? "").includes("ship the thing"),
    "the backlog's own text does not appear in the PM's prompt",
  );
}

// ---------------------------------------------- 5b. no child path reaches the paragraph

{
  const importers: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && !entry.name.startsWith("backlog-reminder.")) {
        // An IMPORT, not any mention of the filename: `work-driver-verify-always-run.ts`
        // lists `smoke-tests/test-backlog-reminder.ts` as data, and a bare
        // substring match would report that generated list as a second importer.
        if (/from\s+["'][^"']*backlog-reminder\.ts["']/.test(stripComments(readFileSync(full, "utf8")))) {
          importers.push(entry.name);
        }
      }
    }
  };
  walk(SRC);
  assert(
    importers.length === 1 && importers[0] === "commands.ts",
    `commands.ts is the only importer of backlog-reminder.ts (saw: ${importers.join(", ") || "none"})`,
  );

  const commands = stripComments(readSrc("commands.ts"));
  const pmGate = commands.indexOf("if (!isPmModeActive()) return undefined;");
  const seamCall = commands.indexOf("backlogReminderSection(");
  assert(pmGate > 0, "non-vacuity: the PM-mode guard is still the hook's first statement");
  assert(
    seamCall > pmGate,
    "the backlog probe sits BEHIND that guard, so a session that never armed PM mode returns before it",
  );

  // Runtime: PM mode not armed, backlog present → the hook contributes nothing.
  resetPmMode();
  assert(
    (await run(withBacklog)) === undefined,
    "PM mode not armed (a child's shape) with a backlog on disk → the hook adds nothing at all",
  );
  armSession();
}

// ------------------ 6. a probe that rejects must still leave the PM its preamble

{
  // The seam swallows its own failures, so the only way to exercise the
  // handler's `catch` is a seam that does not. `mock.module` cannot re-target
  // the `commands.ts` already imported above, so this loads a second copy whose
  // import of the seam resolves to the mock. The specifier goes through a
  // variable: the `?query` is Bun's cache-buster, not a path TypeScript can
  // resolve, and a literal import would fail the smoke-tests type-check.
  mock.module(new URL("../src/backlog-reminder.ts", import.meta.url).href, () => ({
    BACKLOG_REMINDER,
    backlogReminderSection: async () => {
      throw new Error("injected: probe rejected");
    },
  }));
  const freshCommands = "../src/commands.ts?rejected-probe";
  const fresh: { registerCommands: (api: unknown) => void } = await import(freshCommands);
  const freshHooks: Hook[] = [];
  fresh.registerCommands({
    ...pi,
    on: (event: string, handler: Hook) => {
      if (event === "before_agent_start") freshHooks.push(handler);
      return () => undefined;
    },
  });
  assert(freshHooks.length === 1, "the second copy registers the same single hook");
  const freshHook = freshHooks[0] as Hook;
  armSession();
  const survived = await freshHook(
    { type: "before_agent_start", prompt: "x", systemPrompt: BASE, systemPromptOptions: {} },
    { cwd: withBacklog, ui: { notify: () => undefined } },
  );
  assert(
    survived?.systemPrompt === baseline,
    "a REJECTED probe still returns the sticky preamble — the failure costs the paragraph, not the turn",
  );
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\nexit ${exit}`);
process.exit(exit);
