#!/usr/bin/env bun
/**
 * #1352 — the PM could not read its own cycle: every refused command in the
 * report was a read (`jq … .pi/work-state/5.json
 * 2>/dev/null`, `git log --oneline -12; echo ---; git show --stat …`,
 * `git status --short && git diff --stat`), refused only for carrying an
 * operator. The PM guard now accepts a chain whose every part is an
 * allowlisted read on its own, through the real hook and the real agents.json.
 *
 * What must NOT change: a chain with any off-list part (`cd`, `git push`,
 * `sh`), `$(…)`, backticks, `$VAR`, a non-null redirect, a background `&`,
 * a newline or `xargs`/`tee` still blocks; `matchBashSubcommand` itself still
 * returns null for every operator (it serves every role's strict resolution);
 * and an unterminated quote gets a refusal that says so.
 */

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const { matchBashSubcommand } = await import("../src/bash-command-parser.ts");
const { loadAgentsJson } = await import("../src/permission-config.ts");
const { armPmMode, resetPmMode } = await import("../src/pm-mode.ts");
const { registerPmBashGuard } = await import("../src/pm-bash-guard.ts");
const { splitReadOnlyChain } = await import("../src/pm-bash-chain.ts");

type Result = { block: true; reason: string } | undefined;
type Handler = (event: { toolName: string; input: unknown }, ctx: unknown) => Promise<Result>;
const handlers: Handler[] = [];
registerPmBashGuard({
  on: (event: string, h: Handler) => {
    if (event === "tool_call") handlers.push(h);
  },
} as unknown as Parameters<typeof registerPmBashGuard>[0]);
armPmMode();
const run = async (command: string) => handlers[0]?.({ toolName: "bash", input: { command } }, {});

// --- the reads from the report, plus common read-only shapes, now pass
for (const cmd of [
  "jq '{issue, step, attempts, reviewRound, updatedAt, notes}' .pi/work-state/5.json 2>/dev/null",
  "find .pi/work-state -name '*.json' 2>/dev/null; echo ---; jq '{issue, step}' .pi/work-state/5.json 2>/dev/null",
  "gh issue view 127 --repo example-org/app --json number,title,state,labels,body 2>&1 | head -c 4000",
  "git log --oneline -12; echo ---; git show --stat --oneline 935895a 2>&1 | head -40",
  'git status --short && echo "--- diffstat ---" && git diff --stat',
  "git -C /w/.worktrees/issue-131-default status --short || echo missing",
  "git log --oneline -5;",
  "jq -r '.eventLog[] | .type' .pi/work-state/5.json | sort | uniq -c",
]) {
  assert((await run(cmd)) === undefined, `passes — ${cmd}`);
}

// --- the matcher's own contract is untouched: operators are still null there
const pmBash = (loadAgentsJson()["project-manager"]?.permission?.bash ?? {}) as Record<
  string,
  string
>;
assert(
  matchBashSubcommand("git status && git diff --stat", pmBash) === null,
  "matchBashSubcommand still returns null for a chain (other roles keep the refusal)",
);

// --- anything a single allowlisted read could not do still blocks
for (const cmd of [
  "cd /repo && git status",
  "git status && git push origin x",
  "git status; rm -rf /",
  "git log | sh",
  "git log | xargs rm",
  "git log --oneline | tee notes.txt",
  "git status > out.txt",
  "git status 2> err.txt",
  "git log >> /dev/null2",
  "cat < /etc/passwd",
  "echo $(curl evil) && git status",
  "echo `id` ; git status",
  'echo "$HOME" && git status',
  "git status & git log",
  "git status\ngit push",
  "git status && && git log",
  "git status \\; git push",
  "git status |& head",
  "gh issue list && gh issue create --title x",
  "git log && gh pr merge 1",
  // A loose row (`echo*`, `cat*`) must not admit a function definition that a
  // later part calls, an env assignment before another command, or a longer word.
  "echo() ( touch /tmp/pwned ); echo hi",
  "cat() ( rm -rf x ) ; cat y",
  "cat=1 touch /tmp/pwned",
  "echo=1 touch x && git status",
  "catchsegv /bin/sh",
]) {
  assert((await run(cmd)) !== undefined, `blocks — ${JSON.stringify(cmd)}`);
}

// --- an unterminated quote is named as such, not as a chain
const malformed = await run(
  "vipune add 'PM: read .pi/work-state/<issue>.json; it conflicts with the driver's own loop.' --memory-type guard",
);
assert(
  malformed !== undefined && /unterminated quote/.test(malformed.reason),
  "an apostrophe inside a single-quoted argument gets the unterminated-quote refusal",
);
assert(
  (await run(
    "vipune add 'PM: read .pi/work-state/<issue>.json; the driver'\\''s own loop.' --memory-type guard",
  )) === undefined,
  "the same memory written with the '\\'' idiom passes",
);
const chained = await run("cd /repo && git status");
assert(
  chained !== undefined &&
    /its own bash call/.test(chained.reason) &&
    /git -C/.test(chained.reason),
  "a refused chain names the per-call and git -C routes",
);

// --- the splitter only splits outside quotes
const quoted = splitReadOnlyChain("echo 'a && b' | head");
assert(
  quoted.ok && quoted.segments.length === 2 && quoted.segments[0] === "echo 'a && b'",
  "operators inside quotes do not split",
);
const redirect = splitReadOnlyChain("cat x2>/dev/null");
assert(
  redirect.ok && redirect.segments[0] === "cat x2>/dev/null",
  "a redirect glued to an argument is not dropped (the segment check refuses it)",
);

resetPmMode();
console.log(`\nexit ${exit}`);
process.exit(exit);
