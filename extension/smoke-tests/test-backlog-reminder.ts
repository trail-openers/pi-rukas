#!/usr/bin/env bun
/**
 * #1730 A — the private-backlog reminder a PM session gets when an operator
 * clones their real priority order into `<repo>/.backlog/`.
 *
 * The invariant this feature lives or dies on is a NEGATIVE one: with no
 * `.backlog/` the PM's instructions are byte-identical to what they were
 * before this module existed. Every way this can go wrong is a version of "it
 * fired when it should not have" — a half-cloned backlog, a `.backlog` that
 * turned out to be a file, a directory the operator cannot read, a child that
 * picked the paragraph up. So the baseline (no `.backlog/`) is captured ONCE
 * and every other case is compared to it as a STRING, not inspected for a
 * substring: a substring test would pass while the paragraph leaked into a case
 * that must stay silent, as long as the leak also appeared in the baseline.
 *
 * Five groups:
 *   1. no `.backlog/` → byte-identical to the pre-feature prompt;
 *   2. `.backlog/backlog.md` → the paragraph appended, exactly once, on every
 *      turn;
 *   3. `.backlog/` without the file, `.backlog` as a plain file, `backlog.md`
 *      as a directory, an unreadable `.backlog`, no session dir → each
 *      byte-identical to the baseline, and the probe never throws;
 *   4. the backlog's own text never reaches the prompt, and no git runs;
 *   5. no child path reaches it — statically (`commands.ts` is the only
 *      importer; the modules children load say nothing) and at runtime (PM mode
 *      not armed → the hook contributes nothing).
 *
 * The doctrine one-shot is drained before any assertion, so every prompt here
 * is sticky-preamble-only and nothing depends on `dist/prompts/` being built.
 */

import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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

type Hook = (event: unknown, ctx?: unknown) => Promise<{ systemPrompt: string } | undefined>;

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
/** A temp stand-in for "the repository the session believes it is standing in". */
function repo(named: string): string {
  const dir = path.join(TMP, named);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const BASE = "PI_BASE_PROMPT";
async function run(cwd: string | undefined): Promise<string | undefined> {
  const ctx = cwd === undefined ? undefined : { cwd, ui: { notify: () => undefined } };
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

const plain = repo("plain");
armSession();
const baseline = await run(plain);
assert(typeof baseline === "string" && baseline.length > BASE.length, "PM mode: the hook appends to the prompt");
assert(
  baseline !== undefined && baseline.startsWith(`${BASE}\n\n`) && !baseline.toLowerCase().includes("backlog"),
  "no .backlog/ → nothing mentioning a backlog reaches the PM's instructions",
);
assert(
  (baseline ?? "").includes("PM mode — orchestration only"),
  "...and the sticky preamble is still there, untouched",
);
// The pre-feature prompt was exactly `base + sticky preamble` (the full 53K
// doctrine is one-shot and was drained above). Assert that shape directly, so
// a change to how the pieces are joined — or a doctrine leak into the baseline
// — is caught rather than baked into the string the other cases compare
// against.
assert(
  baseline !== undefined &&
    (baseline ?? "").trimEnd().endsWith("Merge authority is operator-only: neither driver can grant it."),
  "the baseline ends where the sticky preamble ends — nothing else was appended",
);
assert(
  (baseline ?? "").length < BASE.length + 4000,
  "the baseline is preamble-sized, not doctrine-sized (the one-shot really was drained)",
);

// ------------------------------------ 2. `.backlog/backlog.md` → the paragraph, once

const withBacklog = repo("with-backlog");
mkdirSync(path.join(withBacklog, ".backlog"));
// Content the reminder must NEVER echo — part B renders it, part A only states
// the file exists. If any of this shows up in a prompt, the seam read it.
const SECRET_BODY = "SECRET-BACKLOG-ORDER-DO-NOT-RENDER\n## Now (in order)\n- ship the thing\n";
writeFileSync(path.join(withBacklog, ".backlog", "backlog.md"), SECRET_BODY);

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
// mode, and each turn must carry it exactly once.
const second = await run(withBacklog);
assert(second === `${baseline}\n\n${BACKLOG_REMINDER}`, "turn 2 appends it again — once, the same bytes");
assert(
  (second ?? "").split(BACKLOG_REMINDER).length - 1 === 1,
  "turn 2 still has it exactly once (no accumulation across turns)",
);

// ----------------------------------------------------- 3. the silent-absence cases

/** A filesystem shape that must be indistinguishable from "no backlog at all". */
async function expectSilent(named: string, seed: (dir: string) => void): Promise<void> {
  const dir = repo(`silent-${named}`);
  seed(dir);
  armSession();
  const out = await run(dir);
  assert(out === baseline, `.backlog ${named}: byte-identical to the no-backlog baseline`);
}

await expectSilent("dir-with-no-backlog-md", (dir) => mkdirSync(path.join(dir, ".backlog")));
await expectSilent("is-a-plain-file", (dir) => writeFileSync(path.join(dir, ".backlog"), SECRET_BODY));
await expectSilent("md-is-a-directory", (dir) =>
  mkdirSync(path.join(dir, ".backlog", "backlog.md"), { recursive: true }),
);
await expectSilent("dir-is-unreadable", (dir) => {
  const bl = path.join(dir, ".backlog");
  mkdirSync(bl);
  writeFileSync(path.join(bl, "backlog.md"), SECRET_BODY);
  chmodSync(bl, 0o000);
});
// Restore, so the recursive rm at the end can still walk in.
chmodSync(path.join(TMP, "silent-dir-is-unreadable", ".backlog"), 0o755);

armSession();
assert((await run(undefined)) === baseline, "no session dir at all → nothing appended (no process.cwd() probe)");

// The probe itself never rejects, whatever the filesystem says.
for (const [label, seed] of [
  ["a plain directory, no backlog anywhere", (d: string) => mkdirSync(path.join(d, "nothing-here"))],
  ["an unreadable .backlog (EACCES)", (d: string) => {
    const bl = path.join(d, ".backlog");
    mkdirSync(bl);
    writeFileSync(path.join(bl, "backlog.md"), "x");
    chmodSync(bl, 0o000);
  }],
] as const) {
  const dir = repo(`probe-${label.replace(/[^a-z]+/g, "-")}`);
  seed(dir);
  let threw = false;
  let value = "unset";
  try {
    value = await backlogReminderSection(dir);
  } catch {
    threw = true;
  }
  // Undo a 0o000 so the recursive rm at the end can walk in; a case that never
  // created the directory has nothing to restore.
  try {
    chmodSync(path.join(dir, ".backlog"), 0o755);
  } catch {
    /* nothing was locked */
  }
  assert(!threw, `the probe (${label}) never throws`);
  assert(
    value === "" || value === BACKLOG_REMINDER,
    `the probe (${label}) answers with the empty string or the paragraph, nothing else`,
  );
}
{
  // Memoised: the same directory yields the SAME promise, so the per-turn
  // handler does not re-stat the filesystem every PM turn.
  const a = backlogReminderSection(withBacklog);
  const b = backlogReminderSection(withBacklog);
  assert(a === b, "the probe is cached per session directory (one stat per session, not per turn)");
  assert(a !== backlogReminderSection(plain), "...keyed by directory, so two sessions do not share an answer");
}

// ------------------------------------ 4. the content is not read, and git is not run

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

// ---------------------------------------------- 5. no child path reaches the paragraph

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

  // Children are separate processes loading child-guards.ts / role prompts, and
  // neither knows the word. A paragraph reaching a developer or reviewer would
  // have to arrive through one of these two files.
  for (const f of ["child-guards.ts", "spawn.ts", "role-tools.ts"]) {
    const text = stripComments(readSrc(f));
    assert(text.length > 0, `non-vacuity: ${f} was read`);
    assert(!/backlog/i.test(text), `${f} — the subagent path — has no code path touching a backlog`);
  }

  // Runtime: PM mode not armed, backlog present → the hook contributes nothing.
  resetPmMode();
  assert(
    (await run(withBacklog)) === undefined,
    "PM mode not armed (a child's shape) with a backlog on disk → the hook adds nothing at all",
  );
  armSession();
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\nexit ${exit}`);
process.exit(exit);
