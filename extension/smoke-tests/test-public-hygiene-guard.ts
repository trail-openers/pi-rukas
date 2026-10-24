#!/usr/bin/env bun
/**
 * public-hygiene-guard (#1788) — the acceptance criteria from the issue,
 * driven through the registered `tool_call` hook with a scratch denylist.
 *
 * Offline: a fake ExtensionAPI captures the hook, `opts.execFn` is never
 * reached (no push in these commands), and every env var goes through
 * `withEnv` so a scratch denylist path cannot leak into the next test file.
 *
 * Every term is synthetic (`example-private-host`, `/home/alice/`,
 * `10.1.2.3`); this repository is public and the guard's own fixtures must
 * model the behaviour they enforce.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createForge } from "../src/forge.ts";
import { genericCategoryOf as classifyPublicText } from "../src/public-denylist.ts";
import { readPublicDenylist, resetDenylistCacheForTests } from "../src/public-denylist.ts";
import {
  publicHygieneInstalled,
  publicTextRefusal,
  registerPublicHygieneGuard,
  resetPublicHygieneRegistrationForTests,
} from "../src/public-hygiene-guard.ts";
import { withEnv } from "./lib/env-scope.ts";
import { assert, exit } from "./merge-guard-helpers.ts";
import { forgePrMergeSeam } from "./test-forge-pr-merge-seam.ts";

const dir = mkdtempSync(path.join(tmpdir(), "public-hygiene-"));
// Scratch for the out-of-root cases. It must NOT live under `tmpdir()`: the OS
// temp dir is one of the two admissible roots, so a fixture there sits inside a
// root and cannot express "outside the roots". `$HOME` is outside both (the
// scan cwd of those cases is its own temp dir).
const scratch = path.join(process.env.HOME ?? os.homedir(), ".pi-rukas-hygiene-test-tmp");
mkdirSync(scratch, { recursive: true });
const TERM = "example-private-host";

/** A denylist whose private entry sits on a known line (2, after a comment). */
const denylistPath = path.join(dir, "denylist");
writeFileSync(denylistPath, `# the operator list\n${TERM}\nsecond-term\n`, "utf8");

type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

/** Register the guard on a fake pi and return a dispatcher for its hooks. */
function hook() {
  const handlers: Handler[] = [];
  const pi = {
    on(event: string, fn: Handler) {
      if (event === "tool_call") handlers.push(fn);
    },
  } as unknown as ExtensionAPI;
  // Each block builds its own fake pi, so the once-per-process registration
  // guard is released first — otherwise every block after the first would
  // register nothing and assert against zero hooks.
  resetPublicHygieneRegistrationForTests();
  registerPublicHygieneGuard(pi);
  return async (
    command: string,
    ctx: Record<string, unknown> = {},
  ): Promise<{ block?: boolean; reason?: string } | undefined> => {
    for (const h of handlers) {
      const r = (await h({ toolName: "bash", input: { command } }, ctx)) as
        | { block?: boolean; reason?: string }
        | undefined;
      if (r?.block) return r;
    }
    return undefined;
  };
}

const denylistEnv = { PI_ENSEMBLE_PUBLIC_DENYLIST: denylistPath };

/** Assert a refusal naming the line and the location, and carrying no term. */
function expectRefusal(
  r: { block?: boolean; reason?: string } | undefined,
  label: string,
  opts: { line?: number; location?: string; category?: string } = {},
): void {
  assert(r?.block === true, `${label}: refused`);
  const reason = r?.reason ?? "";
  assert(reason.length > 0, `${label}: the refusal carries a reason`);
  if (opts.line !== undefined) {
    assert(
      reason.includes(String(opts.line)),
      `${label}: the refusal names the denylist line number`,
    );
    assert(
      reason.includes(denylistPath),
      `${label}: the refusal names the denylist file path so the agent can find it`,
    );
  }
  if (opts.location !== undefined) {
    assert(
      reason.includes(opts.location),
      `${label}: the refusal names the location (${opts.location})`,
    );
  }
  if (opts.category !== undefined) {
    // The refusal prose PARAPHRASES the category ("a private network address",
    // "a personal home directory path") for the agent, and must stay free to
    // reword it. The classification is what the test pins, and the machine-
    // readable verdict is where the category actually lives — so the assertion
    // asks the guard, via its own exported check, rather than grepping prose.
    const classified = classifyPublicText(
      opts.category === "private-ipv4" ? "host 10.1.2.3" : "/home/alice/x",
    );
    assert(
      classified === opts.category,
      `${label}: the generic set classifies the case as ${opts.category}`,
    );
  }
  assert(!reason.includes(TERM), `${label}: the refusal never contains the term`);
  assert(
    reason.includes("PI_ENSEMBLE_PUBLIC_HYGIENE=0"),
    `${label}: the refusal names the escape hatch`,
  );
}

// ── 1. gh publish surfaces, inline and from a file.
{
  await withEnv(denylistEnv, async () => {
    const call = hook();
    expectRefusal(
      await call(`gh issue comment 1 --body "please check ${TERM} tonight"`),
      "gh issue comment --body",
      { line: 2, location: "body" },
    );

    const bodyFile = path.join(dir, "body.md");
    writeFileSync(bodyFile, `Hello\n\nSee ${TERM} for details.\n`, "utf8");
    expectRefusal(
      await call(`gh pr create --title hi --body-file ${bodyFile}`),
      "gh pr create --body-file",
      { line: 2, location: "body" },
    );

    expectRefusal(
      await call(`gh api -X POST repos/o/r/issues/1/comments -f body="ping ${TERM}"`),
      "gh api -X POST comments -f body",
      { line: 2, location: "comment" },
    );

    expectRefusal(
      await call(`git commit -m "feat: wire ${TERM} into the build"`),
      "git commit -m",
      { line: 2, location: "commit message" },
    );

    expectRefusal(
      await call(`gh issue create --title "${TERM} is down" --body "notes"`),
      "gh issue create --title",
      { line: 2, location: "title" },
    );

    expectRefusal(
      await call(`gh release create v1.2.3 --notes "ships on ${TERM}"`),
      "gh release create --notes",
      { line: 2, location: "release notes" },
    );

    // A publish hidden inside `bash -c` is the same publish.
    expectRefusal(
      await call(`bash -c 'gh issue comment 7 --body "ask ${TERM}"'`),
      "publish inside bash -c",
      { line: 2, location: "body" },
    );
  });
}

// ── 2. Clean publishes pass, and a command that publishes nothing passes.
{
  await withEnv(denylistEnv, async () => {
    const call = hook();
    for (const cmd of [
      'gh issue comment 1 --body "please check the box tonight"',
      'git commit -m "feat: wire the build step"',
      "gh pr view 5",
      'echo "the term example-private-host appears only in this quoted echo"',
      'gh issue list --search "example-private-host in title"',
    ]) {
      const r = await call(cmd);
      assert(r === undefined, `not refused: ${cmd.slice(0, 58)}`);
    }
  });
}

// ── 3. With no denylist file the generic set still applies to public text.
{
  await withEnv({ PI_ENSEMBLE_PUBLIC_DENYLIST: path.join(dir, "absent-denylist") }, async () => {
    const call = hook();
    expectRefusal(
      await call(`gh issue edit 4 --body "run it on 10.1.2.3 first"`),
      "no denylist: private IPv4 in a body",
      { category: "private-ipv4" },
    );
    expectRefusal(
      await call(`gh pr comment 2 --body "logs in /home/alice/tmp/x.log"`),
      "no denylist: home path in a comment",
      { category: "home-path" },
    );
    // The documentation range and the placeholder home dir must pass: a
    // guard that refused them gets switched off, which is the failure mode
    // the issue's criteria name.
    for (const cmd of [
      'gh issue edit 4 --body "run it on 192.0.2.10 first"',
      'gh pr comment 2 --body "logs in /home/dev/tmp/x.log"',
    ]) {
      assert((await call(cmd)) === undefined, `no denylist, passes: ${cmd.slice(0, 52)}`);
    }
  });
}

// ── 4. An unreadable or out-of-root body file is refused, never assumed clean.
{
  await withEnv(denylistEnv, async () => {
    const call = hook();
    const missing = await call(`gh pr create --title t --body-file ${path.join(dir, "gone.md")}`);
    assert(missing?.block === true, "an unreadable body file is refused");
    assert(
      (missing?.reason ?? "").includes("body"),
      "the unreadable refusal names which surface could not be read",
    );
    assert(
      (missing?.reason ?? "").includes("could not be checked"),
      "the unreadable refusal says an unchecked publish is not a clean one",
    );

    // A file outside BOTH admissible roots is refused rather than read. The
    // roots are the scan cwd's tree and the OS temp dir, and on this host
    // `tmpdir()` is `$HOME/tmp`, so a fixture under `dir` (which is itself under
    // the temp dir) sits inside a root and passes for the right reason — it is
    // not the state under test. These two fixtures are built under the user's
    // home and are therefore outside both roots whatever `tmpdir()` resolves to.
    const outsideDir = mkdtempSync(path.join(scratch, "outside-"));
    const outside = path.join(outsideDir, "outside.md");
    writeFileSync(outside, `host = ${TERM}\n`, "utf8");
    const escaped = await call(`gh pr create --title t --body-file ${outside}`);
    assert(escaped?.block === true, "a body file outside both admissible roots is refused");
    rmSync(outsideDir, { recursive: true, force: true });
    // The check is on the PATH, not the content: the same path with CLEAN text
    // must be refused too. Without this, the only observable difference between
    // "refused because outside the roots" and "read it and found a term" is the
    // wording of a sentence nobody would notice, and a guard that quietly reads
    // files it says it will not is the shape this assertion exists to catch.
    const cleanOutsideDir = mkdtempSync(path.join(scratch, "outside-clean-"));
    const cleanOutside = path.join(cleanOutsideDir, "clean.md");
    writeFileSync(cleanOutside, "nothing private in here\n", "utf8");
    const refusedOnPath = await call(`gh pr create --title t --body-file ${cleanOutside}`);
    assert(
      refusedOnPath?.block === true,
      "an out-of-root file is refused on its path even when its text is clean",
    );
    assert(
      (refusedOnPath?.reason ?? "").toLowerCase().includes("outside"),
      "and that refusal is the out-of-root sentence, not a hit",
    );
    rmSync(cleanOutsideDir, { recursive: true, force: true });
    assert(
      (escaped?.reason ?? "").toLowerCase().includes("outside"),
      "the out-of-root refusal says the file is outside the admissible roots",
    );

    // A file inside the cwd tree IS admissible (the normal shape for a body).
    const inside = path.join(dir, "ok.md");
    writeFileSync(inside, "a clean body\n", "utf8");
    assert(
      (await call(`gh pr create --title t --body-file ${inside}`)) === undefined,
      "a body file inside the scan root passes when its text is clean",
    );
  });
}

// ── 5. A configured-but-unreadable denylist refuses (it is not "no denylist").
{
  const notAFile = path.join(dir, "not-a-file");
  mkdirSync(notAFile, { recursive: true });
  await withEnv({ PI_ENSEMBLE_PUBLIC_DENYLIST: notAFile }, async () => {
    const call = hook();
    const r = await call(`gh issue comment 1 --body "nothing private here at all"`);
    assert(r?.block === true, "an unreadable denylist refuses a publish");
    assert(
      (r?.reason ?? "").includes("could not be checked"),
      "the refusal says the private check could not run",
    );
  });
}

// ── 6. The escape hatch: exactly 0 disables; any other value leaves it on.
{
  await withEnv({ ...denylistEnv, PI_ENSEMBLE_PUBLIC_HYGIENE: "0" }, async () => {
    const call = hook();
    assert(
      (await call(`gh issue comment 1 --body "ask ${TERM}"`)) === undefined,
      "PI_ENSEMBLE_PUBLIC_HYGIENE=0 disables every check",
    );
    assert(
      (await call(`gh issue edit 1 --body "host 10.1.2.3"`)) === undefined,
      "the hatch disables the generic set too",
    );
  });
  await withEnv({ ...denylistEnv, PI_ENSEMBLE_PUBLIC_HYGIENE: "false" }, async () => {
    const call = hook();
    const r = await call(`gh issue comment 1 --body "ask ${TERM}"`);
    assert(r?.block === true, "a non-0 value is not an off switch (only 0 disables)");
  });
}

// ── 7. The pure text check the forge seam uses (driver-authored posts).
{
  await withEnv(denylistEnv, async () => {
    const r = publicTextRefusal("pull request body", `deployed on ${TERM} yesterday`);
    assert(typeof r === "string" && r.length > 0, "the forge seam check refuses a dirty body");
    assert(!(r ?? "").includes(TERM), "and its refusal carries no term");
    assert(
      publicTextRefusal("pull request body", "deployed on the staging box") === undefined,
      "a clean driver-authored body passes the check",
    );
    await withEnv({ PI_ENSEMBLE_PUBLIC_HYGIENE: "0" }, async () => {
      assert(
        publicTextRefusal("pull request body", `${TERM} again`) === undefined,
        "the hatch disables the forge seam check as well",
      );
    });
  });
}

// ── 7b. The same seam for a DRIVER-AUTHORED COMMIT MESSAGE (#1788, PM
// decision 8). The driver's forge writes are in-process execs, so the
// tool_call hook never sees them: `forge.ts`'s `checkPublicText` is what stops
// a commit-message string the driver composes itself (a squash-subject, a
// release note) from reaching the forge with a private term in it.
{
  await withEnv(denylistEnv, async () => {
    const execed: string[] = [];
    const det = {
      forge: "github",
      host: "github.com",
      url: "https://github.com/example-owner/example-repo.git",
      source: "remote",
    } as const;
    const forge = createForge(det as never, {
      execFn: (async (_cmd: string, _opts?: unknown) => {
        execed.push(_cmd);
        return { stdout: "{}", exitCode: 0 };
      }) as never,
      cwd: dir,
    });
    const dirty = `feat(x): wire ${TERM} into the build`;
    let thrown: unknown;
    try {
      await forge.issueCreate("release notes", `commit ${dirty} to the release`);
    } catch (err) {
      thrown = err;
    }
    assert(thrown !== undefined, "a driver-authored commit message is refused at the forge seam");
    assert(
      (thrown as Error)?.name === "PublicHygieneError",
      "as the hygiene error the driver's error paths already recognise",
    );
    const message = String((thrown as Error)?.message ?? "");
    assert(message.length > 0 && !message.includes(TERM), "and its refusal carries no term");
    assert(
      execed.length === 0,
      "nothing was execed: the check runs before the forge command, not after the post",
    );
    // And the clean counterpart, so the block is not satisfied by a seam that
    // refuses everything. The assertion is on what reached the exec, not on the
    // call resolving: a fake forge whose stdout is not a created-issue URL
    // rejects for that reason AFTER the check passed, and conflating the two
    // would report a passing seam as a refusing one.
    execed.length = 0;
    await forge
      .issueCreate("release notes", "commit feat(x): wire the build")
      .catch(() => undefined);
    assert(
      execed.length === 1,
      "a clean driver-authored message reaches the exec — the seam did not refuse it",
    );
  });
}

// ── 7c. The same seam for a MERGE COMMIT SUBJECT (#1788 round 2). A squash
// merge publishes the subject as the commit message on main, so it is a public
// text surface like a title or a body — and the merge is the one forge write
// the cycle cannot undo. The check must run BEFORE `run`, so a refused subject
// merges nothing. The assertions live in `test-forge-pr-merge-seam.ts`, which
// also runs them as its own file so the offline loop discovers them.
{
  await withEnv(denylistEnv, async () => {
    await forgePrMergeSeam(TERM, dir, createForge);
  });
}

// ── 8. The hook is registered exactly once per process (double-registration).
{
  await withEnv(denylistEnv, async () => {
    const handlers: Handler[] = [];
    const pi = {
      on(event: string, fn: Handler) {
        if (event === "tool_call") handlers.push(fn);
      },
    } as unknown as ExtensionAPI;
    resetPublicHygieneRegistrationForTests();
    registerPublicHygieneGuard(pi);
    registerPublicHygieneGuard(pi);
    registerPublicHygieneGuard(pi);
    // One hook, so the guard's exec-heavy push scan runs once per tool_call;
    // a second registration would run it twice (the #926 companion no-op
    // exists for the same reason).
    assert(
      handlers.length === 1,
      `registering three times installs exactly one hook (got ${handlers.length})`,
    );
    assert(publicHygieneInstalled(), "the process-wide flag records the registration");
    // And the installed hook still refuses, so the guard is not inert.
    const r = (await handlers[0]?.(
      { toolName: "bash", input: { command: `gh issue comment 1 --body "ask ${TERM}"` } },
      {},
    )) as { block?: boolean } | undefined;
    assert(r?.block === true, "the single installed hook is live");
    resetPublicHygieneRegistrationForTests();
  });
}

rmSync(dir, { recursive: true, force: true });
process.exit(exit);
