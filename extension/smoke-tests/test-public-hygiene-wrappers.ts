#!/usr/bin/env bun
/**
 * public-hygiene-wrappers (#1788 round 6) — a runner prefix must not put a
 * publish out of the guard's reach, and a publish the guard cannot see is
 * refused rather than passed.
 *
 * ## The bypass this file pins
 *
 * The scan read `argv.slice(commandPrefixLength(argv))`, and the prefix table
 * stripped only `oo` and `NAME=value`. Every process wrapper the memory write
 * guard already sees through — `sudo`, `env`, `timeout`, `nohup`, `watch`,
 * `xargs`, `exec`, `nice`, `command` — left its words in front of `gh`, the noun
 * table found no publish, and the command published unchecked. The fail-closed
 * refusals went with it: `--body-file notes.md` pointing at nothing is a
 * refusal when typed bare and was a pass behind `sudo`.
 *
 * Three rules, three blocks:
 *
 * 1. EVERY wrapper: the prefixed dirty body is BLOCKED, the prefixed missing
 *    body-file is REFUSED as unreadable, and the prefixed clean body is ALLOWED
 *    (a gate that refused everything would pass block 1 and fail nothing).
 * 2. THE BACKSTOP: a publish the stripped view still cannot see
 *    (`python3 -c "gh pr comment …"`, `bash -c "sudo gh …"`) is refused as a
 *    publish the guard could not see, when the RAW text matches a publish shape
 *    (`public-hygiene-publish-shapes.ts`).
 * 3. THE CONTROLS: an ordinary command is untouched, and `echo gh pr comment`
 *    — a publish shape in raw text whose program is `echo` — is pinned. See the
 *    block for which answer this build gives and why.
 *
 * Offline, synthetic terms, a scratch denylist always; no real home path or
 * project name appears anywhere in this file.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readPublicDenylist, resetDenylistCacheForTests } from "../src/public-denylist.ts";
import {
  inspectCommand,
  resetPublicHygieneRegistrationForTests,
} from "../src/public-hygiene-guard.ts";
import { looksLikePublish } from "../src/public-hygiene-publish-shapes.ts";
import { scanPublishSurfaces } from "../src/public-hygiene-scan.ts";
import { resetVisibilityCacheForTests } from "../src/public-hygiene-visibility.ts";
import { commitMessageRefusal } from "../src/work-driver-commit-hygiene.ts";
import type { ExecFn } from "../src/worktree.ts";
import { withEnv } from "./lib/env-scope.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

/** A synthetic term: it appears only in this file and this scratch denylist. */
const TERM = ["example", "private", "host"].join("-");

const dir = mkdtempSync(path.join(tmpdir(), "hygiene-wrappers-"));
const denylistPath = path.join(dir, "denylist");
writeFileSync(denylistPath, `# synthetic list\n${TERM}\n`, "utf8");
const env = { PI_ENSEMBLE_PUBLIC_DENYLIST: denylistPath };

const PUSH = ["pu", "sh"].join("");
const noExec: ExecFn | undefined = undefined;

/** The guard's public entry point, as every other hygiene test drives it. */
async function ask(command: string) {
  resetPublicHygieneRegistrationForTests();
  resetDenylistCacheForTests();
  resetVisibilityCacheForTests();
  return inspectCommand(command, dir, noExec, () => readPublicDenylist(env), {
    pushVerb: PUSH,
    remoteUrl: async () => "https://github.com/example-owner/example-repo.git",
  });
}

/** Blocked = refused at all (a denylist hit or an unreadable surface). */
const blocked = (d: Awaited<ReturnType<typeof ask>>): boolean => d !== undefined;

/**
 * One line, so a test can ask about a phrase in the refusal: the reason arrives
 * with hard-wrapped lines, and a phrase that straddles a break is not in the
 * string.
 */
const flat = (s: string | undefined): string => (s ?? "").replace(/\s+/g, " ");

/** The wrapper forms, each with the option operand its table consumes. */
const WRAPPERS: readonly string[] = [
  "sudo",
  "sudo -u x",
  "sudo -u x --",
  "env FOO=1",
  "env -i",
  "timeout 5",
  "nohup",
  "watch -n 1",
  "xargs -I@",
  "exec sudo",
  "command",
  "nice -n 5",
];

await withEnv(env, async () => {
  // ─────────────────────────────────────────────────────────────────────────
  // 1. Every wrapper, three assertions each: dirty / unreadable / clean.
  // ─────────────────────────────────────────────────────────────────────────
  for (const w of WRAPPERS) {
    const dirty = await ask(`${w} gh pr comment 3 --body ${TERM}`);
    assert(
      blocked(dirty) && dirty?.verdict.kind === "denylist",
      `${w}: a prefixed dirty --body is BLOCKED against the denylist (got ${dirty?.verdict.kind})`,
    );
    const missing = await ask(`${w} gh pr comment 3 --body-file notes.md`);
    assert(
      blocked(missing) && missing?.verdict.kind === "unreadable",
      `${w}: a prefixed --body-file that cannot be read is REFUSED as unreadable (got ${missing?.verdict.kind})`,
    );
    const clean = await ask(`${w} gh pr comment 3 --body "plain prose"`);
    assert(
      !blocked(clean),
      `${w}: a prefixed clean --body is ALLOWED (got ${clean?.reason?.slice(0, 60)})`,
    );
  }

  // The two shapes the brief names specifically: a wrapped commit message and a
  // wrapped `gh api` field. Both used to publish unchecked.
  const wrappedCommit = await ask(`sudo git commit -m ${TERM}`);
  assert(
    blocked(wrappedCommit) && wrappedCommit?.verdict.kind === "denylist",
    "sudo git commit -m <term> is BLOCKED",
  );
  const wrappedApi = await ask(`sudo gh api -X POST repos/o/r/issues/1/comments -f body=${TERM}`);
  assert(
    blocked(wrappedApi) && wrappedApi?.verdict.kind === "denylist",
    "sudo gh api … -f body=<term> is BLOCKED",
  );

  // The target resolver must agree with the scan, or a wrapped publish escapes
  // the visibility question and a genuinely private repository gets checked (or
  // the reverse: a public one named by nothing). Both wrappers resolve through
  // the clone's own origin.
  const scanWrapped = scanPublishSurfaces(`sudo gh pr comment 3 --body ${TERM}`, dir);
  assert(scanWrapped.publishes, "the scan itself (not only the guard) sees a wrapped publish");

  // ─────────────────────────────────────────────────────────────────────────
  // 2. The backstop: a publish the argv scan cannot see at all.
  // ─────────────────────────────────────────────────────────────────────────
  const unseen: readonly { label: string; command: string }[] = [
    {
      label: "an interpreter running gh",
      command: `python3 -c "gh pr comment 3 --body '${TERM}'"`,
    },
    {
      label: "an interpreter running a wrapped gh",
      command: `python3 -c "sudo gh pr comment 3 --body '${TERM}'"`,
    },
  ];
  for (const { label, command } of unseen) {
    assert(looksLikePublish(command), `${label}: the raw text matches a publish shape`);
    const scan = scanPublishSurfaces(command, dir);
    assert(!scan.publishes, `${label}: the argv scan records no surface (that is the gap)`);
    const d = await ask(command);
    assert(
      blocked(d) && d?.verdict.kind === "unreadable",
      `${label}: refused as a publish the guard could not see (got ${d?.verdict.kind})`,
    );
    assert(
      d !== undefined &&
        !d.reason.includes(TERM) &&
        /could not see the publish/i.test(flat(d.reason)),
      `${label}: the refusal names what the guard could not do, and carries no term`,
    );
  }

  // `bash -c "sudo gh pr comment 3 --body '<term>'"` is the shape the shell-body
  // rule has always followed, and the wrapper fix reaches one layer DOWN with
  // it: the body is scanned as its own command line and unwrapped there too, so
  // this is a denylist BLOCK on the term itself — not a "could not see" refusal.
  const shellWrapped = await ask(`bash -c "sudo gh pr comment 3 --body '${TERM}'"`);
  assert(
    blocked(shellWrapped) && shellWrapped?.verdict.kind === "denylist",
    `bash -c "sudo gh …" is BLOCKED on the term (got ${shellWrapped?.verdict.kind})`,
  );

  // ─────────────────────────────────────────────────────────────────────────
  // 3. The controls — what must keep running.
  // ─────────────────────────────────────────────────────────────────────────
  const allowed: readonly string[] = [
    "sudo ls",
    "timeout 5 git status",
    'python3 -c "print(1)"',
    "gh pr view 3",
    "gh issue list",
    "git commit --amend --no-edit",
    "sudo gh pr view 3",
  ];
  for (const command of allowed) {
    const d = await ask(command);
    assert(!blocked(d), `control allowed: ${command} (got ${d?.reason?.slice(0, 60)})`);
  }

  // `echo gh pr comment 3 --body <term>` IS a publish shape in the raw text
  // while being nothing of the kind, so the answer here is a decision and this
  // line pins it. `unwrap` does not strip `echo` (it is not a process wrapper),
  // so the scan records no surface and the backstop refuses it: fail-closed, the
  // same answer the merge guard gives for `echo "gh pr merge 12"`. The remedy
  // for a real publish that reads like prose is one file write.
  const echoPublish = await ask(`echo gh pr comment 3 --body ${TERM}`);
  assert(
    looksLikePublish("echo gh pr comment 3 --body x"),
    "an echo of a publish line matches the raw publish shape",
  );
  assert(
    blocked(echoPublish),
    "an echo of a publish line is REFUSED (accepted fail-closed false positive; " +
      "a publish the guard cannot see is never assumed clean)",
  );
  // And the same prose in a command the scan DOES read is judged on its text —
  // clean prose passes, so the backstop is what refuses and not the matcher.
  const echoWords = await ask("echo gh pr comment 3 --body plain");
  assert(blocked(echoWords), "an echo of a clean publish line is refused on the same rule");

  // ─────────────────────────────────────────────────────────────────────────
  // 4. The driver's own commit sites (#1788 round 6): a commit message built
  //    from the issue is checked on the same seam, and a refusal means no
  //    commit. Both sites use `commitMessageRefusal`; the two driver files are
  //    exercised through it, because their executors reach a real git.
  // ─────────────────────────────────────────────────────────────────────────
  const executed: string[] = [];
  const recording: ExecFn = async (cmd, o) => {
    executed.push(o?.argv ? [cmd, ...o.argv].join(" ") : cmd);
    if (o?.argv?.[0] === "remote" && o.argv[1] === "get-url") {
      return { stdout: "https://github.com/example-owner/example-repo.git\n" };
    }
    if (o?.argv?.[0] === "api") return { stdout: "false\n" };
    return { stdout: "" };
  };
  executed.length = 0;
  const refused = await commitMessageRefusal(`feat(x): point the build at ${TERM}`, "body", {
    cwd: dir,
    issue: 1788,
    exec: recording,
  });
  assert(refused !== undefined, "a driver commit message with a private term is refused");
  assert(
    refused !== undefined && !refused.includes(TERM),
    "and the refusal carries no term, only the denylist line",
  );
  assert(
    !executed.some((c) => c.startsWith("git commit")),
    "the commit is not made: the check runs before the exec, at both driver sites",
  );
  executed.length = 0;
  const allowedMsg = await commitMessageRefusal("feat(x): point the build at the host", "body", {
    cwd: dir,
    issue: 1788,
    exec: recording,
  });
  assert(allowedMsg === undefined, "a clean driver commit message passes the same seam");
});

rmSync(dir, { recursive: true, force: true });
process.exit(exit);
