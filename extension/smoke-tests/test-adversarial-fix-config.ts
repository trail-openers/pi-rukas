#!/usr/bin/env bun
/**
 * #2138 — the fix fence compares the shared `config` as keys, not as bytes.
 *
 * Split out of test-adversarial-fix-fence.ts (whose T9 owns `hooks/`) for the
 * 500-line gate; the arms here are that file's config cases. Real git, as there.
 *
 *   exempt churn  branch.<b>.remote/merge added or removed, remote.<n>.fetch added
 *                 or removed, and a reformat of the same key list — all clean
 *   violations    remote.<n>.url, core.hooksPath, include.path, alias.x — each
 *                 naming the key; a mixed round naming only the non-exempt key
 *   fail closed   a config git cannot read is a violation, never a clean compare
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { type FenceRecord, createFixFence } from "../src/adversarial-fix-guard.ts";

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

/** The caller's shared config, rendered the way the guard's entry reads. */
const configEntry = (caller: string): string => {
  const common = git(caller, "rev-parse", "--path-format=absolute", "--git-common-dir").trim();
  const records = git(common, "config", "--file", path.join(common, "config"), "--list", "--null");
  const keys: string[] = [];
  for (const record of records.split("\0")) {
    if (record === "") continue;
    const nl = record.indexOf("\n");
    const key = record.slice(0, nl).toLowerCase();
    if (isExemptKey(key)) continue;
    keys.push(`${key}\t${record.slice(nl + 1)}`);
  }
  return `shared:config\t${keys.join("\u001f")}`;
};
/** The exempt key templates the guard removes before comparing (#2138). */
const EXEMPT = ["branch.*.remote", "branch.*.merge", "remote.*.fetch"];
const isExemptKey = (key: string): boolean => {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  return first > 0 && last > first && EXEMPT.includes(`${key.slice(0, first)}.*.${key.slice(last + 1)}`);
};
/**
 * The config bytes that produce exactly this `shared:config\t<key\tvalue…>` entry.
 * `key = value` lines are git's own accepted form, subsections included.
 */
const keysToConfig = (entry: string): string => {
  const value = entry.slice("shared:config\t".length);
  return value
    .split("\u001f")
    .filter((pair) => pair !== "")
    .map((pair) => {
      const tab = pair.indexOf("\t");
      const key = pair.slice(0, tab);
      const first = key.indexOf(".");
      return `${key.slice(0, first)}.${key.slice(first + 1)} = ${pair.slice(tab + 1)}`;
    })
    .join("\n");
};
/**
 * Drive the fence with `body` running inside the fenced round, and return the
 * recorded texts. `before` is the config entry read before the round, so a body
 * can restore the bytes after a read the guard must fail on.
 */
async function configRound(
  tag: string,
  body: (caller: string, before: string) => void,
  seed?: (caller: string) => void,
): Promise<{ texts: string[] }> {
  const caller = repo(tag);
  seed?.(caller);
  const work = worktreeOf(caller, `wt-${tag}`);
  const before = configEntry(caller);
  const recs: FenceRecord[] = [];
  await createFixFence({ callerCwd: caller }, recs).round(1, work, async () =>
    body(caller, before),
  );
  return { texts: recs.map((r) => `${r.kind}: ${r.text}`) };
}
async function main() {
  {
    const caller = repo("t9x");
    const work = worktreeOf(caller, "wt-t9x");
    const recs: FenceRecord[] = [];
    await createFixFence({ callerCwd: caller }, recs).round(1, work, async () => {
      git(caller, "config", "user.name", "changed-by-round");
    });
    assert(
      recs.some(
        (r) =>
          r.kind === "violation" &&
          r.text.includes("config keys: user.name"),
      ),
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
    // Same key list, different bytes: a comment and blank lines, every value kept.
    [
      "t9fmt",
      (caller: string) => {
        const file = path.join(
          git(caller, "rev-parse", "--path-format=absolute", "--git-common-dir").trim(),
          "config",
        );
        const original = readFileSync(file, "utf8");
        // A comment, blank lines, and reflowed separators — the bytes change, the
        // parsed key/value list does not.
        const kept = original
          .split("\n")
          .filter((line) => !line.trim().startsWith("#") && line.trim() !== "")
          .map((line) =>
            line.includes("=")
              ? `   ${line.slice(0, line.indexOf("=")).trim()}   =   ${line.slice(line.indexOf("=") + 1).trim()}`
              : `	${line.trim()}`,
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
      // A tracked remote and a tracked branch: the arms need real exempt entries to churn.
      (caller) => {
        git(caller, "config", "remote.origin.url", "git@github.com:example/remote.git");
        git(caller, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
        git(caller, "config", "--add", "remote.origin.fetch", "+refs/tags/*:refs/tags/*");
        git(caller, "config", "branch.tracked.remote", "origin");
        git(caller, "config", "branch.tracked.merge", "refs/heads/tracked");
      },
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
  {
    // Fail closed: a config git cannot read is a violation, never a clean compare.
    // The bytes stay the snapshot's own, so the read itself is the only failure.
    const { texts } = await configRound("t9unreadable", (caller, before) => {
      const file = path.join(
        git(caller, "rev-parse", "--path-format=absolute", "--git-common-dir").trim(),
        "config",
      );
      // `before` is the entry the guard snapshotted, so this is its own bytes.
      writeFileSync(file, keysToConfig(before));
      chmodSync(file, 0);
    });
    assert(
      texts.length === 1 &&
        texts[0].startsWith("violation:") &&
        /not completed/.test(texts[0]),
      `T9-config: an unreadable config is a violation carrying the git error, never a clean compare (${texts.join(" | ")})`,
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
