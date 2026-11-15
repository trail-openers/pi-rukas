/**
 * lib/git-range-canary-inventory — the modules the #1153 argv canary scans, and the scanner.
 *
 * Split out of `test-git-range-1153.ts` for the 500-line cap. The seam is the canary's own:
 * the LIST below and the scanner that reads it are a REGISTRY, and `test-git-range-1153.ts`
 * asserts against it (every importer listed, the control that the scanner can fail) while the
 * fixture half of that suite — the killed-probe arms — does not read it at all. Moving the
 * inventory here means a new git caller is registered in one place, whether the file that
 * notices it is the canary's or a sibling's.
 *
 * The rule the inventory enforces is unchanged: a driver git call passes argv, never a command
 * string, so a token cannot be re-parsed by a shell. Each entry's comment says which module
 * joined under it and why its calls are argv-form; the assertions stay with the canary.
 *
 * Lives in lib/ so the smoke glob never self-executes it.
 */

import { readFileSync, readdirSync } from "node:fs";

/** Every module whose `git` calls the canary reads. Adding a caller of `./git-range.ts`
 * without adding it here reddens the coverage assertion in the canary suite. */
export const LISTED = [
  "git-range.ts",
  "work-driver-diff.ts",
  // #1634 — the adversarial gate's discriminated diff read. Every call goes
  // through `execGit` (argv + the module's own timeout + a bounded maxBuffer),
  // and test-work-driver-adversarial-diff-unreadable.ts asserts on the argv
  // the fake receives, so this file is under the same discipline as the rest.
  "work-driver-diff-read.ts",
  "work-driver-verify.ts",
  "work-driver-verify-pr17.ts",
  "comment-retention.ts",
  // #1378 — the protected-path reads take `DEFAULT_GIT_TIMEOUT_MS` from here so a
  // hung git cannot hang the develop step; both its git calls are argv-form.
  "work-driver-protected-paths-read.ts",
  // #1378 (split for the file cap) — the uncommitted half of that read takes the
  // same bound from here, and its single git call is argv-form.
  "work-driver-protected-paths-status.ts",
  // #1378 (round 3) — the develop gate's `git rev-list --count` read used to have
  // no timeout at all, so a wedged object store hung the whole step. It now takes
  // the same bound from here.
  "work-driver-verify-develop.ts",
  // #1002 round 2 — the path-existence probe reads git at `origin/<branch>` for
  // a path that came out of prose, so it takes the argv form (`argv: ["cat-file",
  // "-e", treeish]`) and this module's own timeout. Its test fakes assert on
  // `argv`, not on a command string.
  "lens-evidence.ts",
  // #1788 — the push scan reads the outgoing range (`git remote`, `rev-parse`,
  // `log --patch`) to decide whether a push publishes private text. Every call
  // is argv-form under `PUSH_SCAN_TIMEOUT_MS` / `PUSH_SCAN_MAX_BUFFER`, and
  // test-public-hygiene-push.ts asserts on `argv` — including that a git which
  // never returns is a refusal rather than a hang or a pass.
  "public-hygiene-push.ts",
  // #2168 — the push scan's repository probe (`git rev-parse --show-toplevel`)
  // runs in the directory the push itself runs in, so it takes the same argv
  // form and the caller's own `timeout`/`maxBuffer`: it is the first read of the
  // scan and the one that must not hang the `tool_call` hook. Its bound is
  // pinned by test-hygiene-push-segment.ts.
  "public-hygiene-push-probe.ts",
  // #2181 — the merge-author allowlist reads the gate file and the author at the
  // base commit through `git cat-file` / `git show`, both argv-form under this
  // module's own `ALLOWLIST_TIMEOUT_MS` / `ALLOWLIST_MAX_BUFFER`, and
  // test-merge-author-base-unreadable.ts asserts on `argv`.
  "merge-author-allowlist.ts",
  // #2283 — the data-provenance gate reads the added file's committed bytes with
  // `git show --end-of-options <oid>:<path>` under its own named bounds, the ref
  // always the oid it pinned first. Its test asserts on `argv`, so the read is
  // under the same discipline as the rest of the develop path.
  "work-driver-verify-develop-provenance.ts",
  // #2283 (split for the file cap) — the token classifier and display forms behind that
  // gate: it issues no git call of its own, and is listed so a future edit that adds one
  // is checked under the same rule rather than joining the argv discipline by silence.
  "work-driver-verify-develop-provenance-token.ts",
  // #2283 — the classic command-criteria tier's head probe (`git rev-parse --verify
  // HEAD`), argv-form under its own bound, so a moved head is a note rather than a hang.
  "work-driver-verify-develop-command-criteria.ts",
];

/** A git command string handed to an exec call: a `(` then a literal beginning `git `. */
export const COMMAND_STRING = /\([ \t]*["'`]git[ \t]/;

/**
 * Lines whose `git `-leading literal is operator-facing prose, not a command.
 *
 * The develop gate builds its failure and note text from template literals that
 * open with the word `git` — `` `git status failed in worktree "${id}" …` `` and
 * its `git diff` twin — and the scanner cannot tell those from a command string
 * without parsing the literal. Naming them is deliberate rather than clever: an
 * in-file allowlist with a reason per line fails LOUDLY when one is deleted or
 * reworded (the line stops matching and the string is flagged again), where a
 * "does this read like a sentence?" heuristic fails silently in whichever
 * direction it gets it wrong. Anything genuinely new stays flagged.
 */
export const PROSE_GIT_LITERALS = [
  "git status failed in worktree",
  "git status failed in ${id}",
  "git diff failed in worktree",
  "git diff failed in ${id}",
  // Operator guidance, not a call: the develop gate tells a developer what to run
  // in their worktree when it has uncommitted work and no commit ahead of base.
  "git add -A && git commit",
];

/** The lines of `source` that pass a `git `-leading command string to an exec call. */
export function commandStringLines(source: string): string[] {
  return source.split("\n").filter((line) => {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return false;
    if (!COMMAND_STRING.test(line)) return false;
    return !PROSE_GIT_LITERALS.some((p) => line.includes(p));
  });
}

/** Every `.ts` in `srcDir` that imports `./git-range.ts` — the set the inventory must cover. */
export function gitRangeImporters(srcDir: string): string[] {
  const importers: string[] = [];
  for (const entry of readdirSync(srcDir)) {
    if (!entry.endsWith(".ts")) continue;
    const source = readFileSync(`${srcDir}/${entry}`, "utf8");
    if (/from "\.\/git-range\.ts"/.test(source)) importers.push(entry);
  }
  return importers;
}
