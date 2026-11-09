#!/usr/bin/env bun
/**
 * #2138 — the fix fence compares the shared `config` as keys, not as bytes.
 *
 * Split out of test-adversarial-fix-fence.ts (whose T9 owns `hooks/`) for the
 * 500-line gate; the arms here are that file's config cases. Real git, as there.
 *
 *   exempt churn  branch.<b>.remote/merge added or removed, remote.<n>.fetch added
 *                 or removed, and a whitespace/comment reformat of the same key
 *                 list — all clean
 *   violations    remote.<n>.url, core.hooksPath, include.path, alias.x — each
 *                 naming the key; a mixed round naming only the non-exempt key
 *   the fold      two ways a value can hide a whole entry — set to
 *                 `<text><US><next key>` with that key unset (what a delimiter-
 *                 joining comparison saw as unchanged, #2138 adversarial CRITICAL),
 *                 and a record moved under another key's name (same multiset,
 *                 different effective key): both violations naming the keys
 *   reorder       a non-exempt multi-valued key whose values swap — a violation
 *                 naming it, since git's last value is the effective one
 *   fail closed   a truncated, an empty, an unreadable or a zero-key config read
 *                 is a violation, never a clean compare; an empty config file
 *                 written during the round is one too
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type FenceRecord, createFixFence } from "../src/adversarial-fix-guard.ts";
import { isExemptConfigKey } from "../src/git-config-keys.ts";
import { execp } from "../src/exec.ts";
import type { ExecFn } from "../src/worktree.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`\u2713 ${msg}`);
  else {
    console.error(`\u2717 ${msg}`);
    exit = 1;
  }
}

const made: string[] = [];
const tmp = (tag: string): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), `fence-2138-${tag}-`));
  made.push(d);
  return d;
};
const git = (dir: string, ...args: string[]): string =>
  execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" }).toString();
const repo = (tag: string): string => {
  const dir = tmp(tag);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "test");
  writeFileSync(path.join(dir, "f.txt"), "one\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
};
/** A worktree of `source` on a fresh branch, at a fresh path. */
const worktreeOf = (source: string, branch: string): string => {
  const dir = path.join(tmp(`wt-${branch}`), "wt");
  git(source, "worktree", "add", "-q", "-b", branch, dir);
  return dir;
};
const configFile = (caller: string): string =>
  path.join(
    git(caller, "rev-parse", "--path-format=absolute", "--git-common-dir").trim(),
    "config",
  );
/** Seed the exempt entries the churn arms need: a tracked remote and a branch. */
const seedExempt = (caller: string): void => {
  git(caller, "config", "remote.origin.url", "git@github.com:example/remote.git");
  git(caller, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
  git(caller, "config", "--add", "remote.origin.fetch", "+refs/tags/*:refs/tags/*");
  git(caller, "config", "branch.tracked.remote", "origin");
  git(caller, "config", "branch.tracked.merge", "refs/heads/tracked");
};
/**
 * Drive the fence with `body` running inside the fenced round, and return the
 * recorded texts. `exec` lets an arm inject the config read's stdout.
 */
async function configRound(
  tag: string,
  body: (caller: string) => void,
  seed?: (caller: string) => void,
  configStdout?: string,
): Promise<{ texts: string[] }> {
  const caller = repo(tag);
  seed?.(caller);
  const work = worktreeOf(caller, `wt-${tag}`);
  const recs: FenceRecord[] = [];
  const exec = configStdout === undefined ? undefined : execWithConfigStdout(configStdout);
  const ran = await createFixFence({ callerCwd: caller }, recs, exec).round(1, work, async () =>
    body(caller),
  );
  // A round the fence could not arm is its own failure: the caller never saw a
  // clean compare, so surface it as a violation the assertions can name.
  if (!ran.ran)
    return { texts: [`violation: could not arm (${ran.outcome}: ${ran.reason})`] };
  return { texts: recs.map((r) => `${r.kind}: ${r.text}`) };
}
/**
 * An executor whose `git config` read returns exactly these bytes. The config is
 * still read once per snapshot and the throw still lands inside the snapshot, so
 * `--before`/`--after` pass through to the real git and only the compared read lies.
 */
const execWithConfigStdout = (stdout: string): ExecFn => (cmd, opts) =>
  cmd === "git" && opts?.argv?.includes("--list")
    ? Promise.resolve({ stdout, stderr: "" })
    : execp(cmd, opts ?? {});
/** The line whose value is `alpha`, and the line defining `two` — the fold's prey. */
const foldedBytes = (src: string): string =>
  src
    .split("\n")
    .map((line) => (/^\s*one\s*=/.test(line) ? `  one = "alpha${"\u001f"}safe.two\tbeta"` : line))
    .filter((line) => !/^\s*two\s*=/.test(line))
    .join("\n");

async function main() {
  {
    const caller = repo("t9x");
    const work = worktreeOf(caller, "wt-t9x");
    const recs: FenceRecord[] = [];
    await createFixFence({ callerCwd: caller }, recs).round(1, work, async () => {
      git(caller, "config", "user.name", "changed-by-round");
    });
    assert(
      recs.some((r) => r.kind === "violation" && r.text.includes("config keys: user.name")),
      "T9-config: a change to the shared config is a violation that names the changed key",
    );
  }
  // ---- #2138: churn another cycle wrote to the shared config is not blamed on the round.
  // Each pair writes and then removes the same keys, so the file's bytes differ from
  // the before-snapshot's while the compared key list does not.
  for (const [tag, write, undo] of [
    [
      "t9b1",
      (caller: string) => {
        git(caller, "config", "branch.concurrent.remote", "origin");
        git(caller, "config", "branch.concurrent.merge", "refs/heads/concurrent");
      },
      (caller: string) => {
        git(caller, "config", "--remove-section", "branch.concurrent");
      },
    ],
    [
      "t9b2",
      (caller: string) => {
        git(caller, "config", "--remove-section", "branch.tracked");
      },
      (caller: string) => {
        git(caller, "config", "branch.tracked.remote", "origin");
        git(caller, "config", "branch.tracked.merge", "refs/heads/tracked");
      },
    ],
    [
      "t9f1",
      (caller: string) => {
        git(caller, "config", "--add", "remote.origin.fetch", "+refs/notes/*:refs/notes/*");
      },
      (caller: string) => {
        // The pattern is a regex over the value; `refs/notes` alone is unique here.
        git(caller, "config", "--unset-all", "remote.origin.fetch", "refs/notes");
      },
    ],
    [
      "t9f2",
      (caller: string) => {
        git(caller, "config", "--unset-all", "remote.origin.fetch", "refs/tags");
      },
      (caller: string) => {
        git(caller, "config", "--add", "remote.origin.fetch", "+refs/tags/*:refs/tags/*");
      },
    ],
    // Same key list in the same order, different bytes: a comment, blank lines and
    // reflowed separators, every value kept.
    [
      "t9fmt",
      (caller: string) => {
        const file = configFile(caller);
        const original = readFileSync(file, "utf8");
        const kept = original
          .split("\n")
          .filter((line) => !line.trim().startsWith("#") && line.trim() !== "")
          .map((line) =>
            line.includes("=")
              ? `   ${line.slice(0, line.indexOf("=")).trim()}   =   ${line.slice(line.indexOf("=") + 1).trim()}`
              : `\t${line.trim()}`,
          );
        writeFileSync(file, `# rewritten by another cycle\n\n${kept.join("\n")}\n\n`);
      },
      (caller: string) => {},
    ],
  ] as const) {
    const { texts } = await configRound(
      tag,
      (caller) => {
        write(caller);
        undo(caller);
      },
      seedExempt,
    );
    assert(texts.length === 0, `T9-config: exempt config churn (${tag}) is not a violation`);
  }
  for (const [tag, write, key] of [
    [
      "t9url",
      (caller: string) => {
        git(caller, "config", "remote.origin.url", "git@example.com:mirror.git");
      },
      "remote.origin.url",
    ],
    [
      "t9hooks",
      (caller: string) => {
        git(caller, "config", "core.hooksPath", "/tmp/evil-hooks");
      },
      "core.hookspath",
    ],
    [
      "t9inc",
      (caller: string) => {
        git(caller, "config", "include.path", "extra.cfg");
      },
      "include.path",
    ],
    [
      "t9alias",
      (caller: string) => {
        git(caller, "config", "alias.co", "checkout");
      },
      "alias.co",
    ],
  ] as const) {
    const { texts } = await configRound(tag, (caller) => write(caller));
    assert(
      texts.length === 1 &&
        texts[0].startsWith("violation:") &&
        texts[0].includes(`config keys: ${key}`),
      `T9-config: a change to ${key} is a violation naming the key`,
    );
  }
  {
    // Mixed: exempt churn alongside a real change names only the non-exempt key.
    const { texts } = await configRound("t9mix", (caller) => {
      git(caller, "config", "branch.concurrent.remote", "origin");
      git(caller, "config", "user.name", "changed-by-round");
    });
    assert(
      texts.length === 1 &&
        texts[0].includes("config keys: user.name") &&
        !texts[0].includes("branch.concurrent"),
      "T9-config: exempt churn mixed with a real change names only user.name",
    );
  }
  // ---- the \x1f fold the joined comparison could not see (#2138 adversarial CRITICAL).
  {
    const { texts } = await configRound(
      "t9fold",
      (caller) => {
        const file = configFile(caller);
        writeFileSync(file, foldedBytes(readFileSync(file, "utf8")));
      },
      (caller) => {
        seedExempt(caller);
        git(caller, "config", "safe.one", "alpha");
        git(caller, "config", "safe.two", "beta");
      },
    );
    assert(
      texts.length === 1 &&
        texts[0].startsWith("violation:") &&
        texts[0].includes("config keys: safe.one, safe.two"),
      `T9-config: folding safe.two into safe.one's value with a US separator is a violation naming both keys (${texts.join(" | ")})`,
    );
  }
  {
    // A non-exempt multi-valued key whose values are reordered is a violation: the
    // multiset is unchanged, git's last-value-wins semantics are not.
    const { texts } = await configRound(
      "t9order",
      (caller) => {
        const file = configFile(caller);
        const lines = readFileSync(file, "utf8").split("\n");
        const [first, second] = [
          lines.findIndex((l) => /^\s*url = git@github.com:example\/remote.git$/.test(l)),
          lines.findIndex((l) => /^\s*url = git@example.com:mirror.git$/.test(l)),
        ];
        if (first < 0 || second < 0) throw new Error("fixture lost its two remote urls");
        [lines[first], lines[second]] = [lines[second] as string, lines[first] as string];
        writeFileSync(file, lines.join("\n"));
      },
      (caller) => {
        seedExempt(caller);
        // `remote.<name>.url` is NOT exempt, and a repeated key keeps the last value.
        git(caller, "config", "--add", "remote.origin.url", "git@example.com:mirror.git");
      },
    );
    assert(
      texts.length === 1 &&
        texts[0].startsWith("violation:") &&
        texts[0].includes("config keys: remote.origin.url"),
      `T9-config: reordering a non-exempt multi-valued key's values is a violation naming it (${texts.join(" | ")})`,
    );
  }
  {
    // The positional fold: `two = beta` rewritten to `one = beta` keeps the parsed
    // multiset's VALUES and changes only which key git reads `beta` under.
    const { texts } = await configRound(
      "t9posfold",
      (caller) => {
        const file = configFile(caller);
        const lines = readFileSync(file, "utf8").split("\n");
        const i = lines.findIndex((line) => /^\s*two = beta$/.test(line));
        if (i < 0) throw new Error("fixture lost safe.two");
        lines[i] = "  one = beta";
        writeFileSync(file, lines.join("\n"));
      },
      (caller) => {
        git(caller, "config", "safe.one", "alpha");
        git(caller, "config", "safe.two", "beta");
      },
    );
    assert(
      texts.length === 1 &&
        texts[0].startsWith("violation:") &&
        /config keys: safe\.(one, safe\.two|one)$/.test(texts[0]),
      `T9-config: a record moved under another key's name is a violation naming it (${texts.join(" | ")})`,
    );
  }
  {
    // An empty config file written during the round: git exits 0 with no records.
    const { texts } = await configRound("t9empty", (caller) => {
      writeFileSync(configFile(caller), "");
    });
    assert(
      texts.length === 1 &&
        texts[0].startsWith("violation:") &&
        /no records/.test(texts[0]),
      `T9-config: an empty config file written during the round is a violation, never a clean compare (${texts.join(" | ")})`,
    );
  }
  for (const [tag, stdout, expect] of [
    // The `--list --null` read of BOTH snapshots returns these bytes, so the
    // snapshot is unreadable and the round is refused — fail-closed, not clean.
    ["truncated", "core.bare\nfalse", /truncated/],
    ["empty", "", /no records/],
    ["no-newline-separator", "core.bare\0", /record 0 has no key\/value newline/],
  ] as const) {
    const { texts } = await configRound("t9read", () => {}, undefined, stdout);
    assert(
      texts.length === 1 &&
        /violation:/.test(texts[0]) &&
        expect.test(texts[0]) &&
        !texts[0].includes("core.bare"),
      `T9-config: a ${tag} config read is a violation naming the case, never the value (${texts.join(" | ")})`,
    );
  }
  {
    // Fail closed on the read itself: the bytes stay the snapshot's own, so chmod
    // on the real file is enough — no rebuild, no delimiter to keep byte-identical.
    const { texts } = await configRound("t9unreadable", (caller) => {
      chmodSync(configFile(caller), 0);
    });
    assert(
      texts.length === 1 && texts[0].startsWith("violation:") && /not completed/.test(texts[0]),
      `T9-config: an unreadable config is a violation carrying the git error, never a clean compare (${texts.join(" | ")})`,
    );
  }
  {
    // The exemption predicate the fence uses is the one the test asserts against.
    assert(
      isExemptConfigKey("branch.x.remote") &&
        isExemptConfigKey("remote.origin.fetch") &&
        !isExemptConfigKey("remote.origin.url") &&
        !isExemptConfigKey("branch.x.username") &&
        !isExemptConfigKey("core.hookspath"),
      "T9-config: isExemptConfigKey exempts exactly the three key templates",
    );
  }
}

try {
  await main();
} finally {
  for (const d of made) rmSync(d, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
