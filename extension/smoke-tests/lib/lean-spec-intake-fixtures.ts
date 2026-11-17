/**
 * lib/lean-spec-intake-fixtures — fixtures for the spec-intake suite
 * (`test-lean-spec-intake-*.ts`), kept out of the case files so none of them
 * crosses AGENTS.md §12's line cap.
 *
 * Nothing here asserts: a fixture that reported a verdict would be judging
 * someone else's run (the convention `lib/lean-engine-fixtures.ts` follows).
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gitTestEnv } from "./git-test-env.ts";

/** One criterion as a fixture states it: a bare sentence, or one with an id. */
export type SpecBullet = string | { id?: string; text?: string };

/** A `PiSpec` block in the shape `parsePiSpec` accepts, as one fenced string. */
export function specBlock(criteria: SpecBullet[], problem: string): string {
  // The fields are written EXPLICITLY rather than spread from the caller's
  // object: a spread of a bare `{ text }` produced `{"0": "a"}`, which
  // `parsePiSpec` rightly refuses and every case then failed on the fixture
  // instead of the code.
  const body = {
    problem,
    criteria: criteria.map((c, i) => ({
      id: typeof c === "string" ? `AC${String(i + 1)}` : (c.id ?? `AC${String(i + 1)}`),
      text: typeof c === "string" ? c : c.text,
      verify: "test",
    })),
    size: "S",
  };
  return "```pi-spec v1\n" + JSON.stringify(body, null, 2) + "\n```";
}

/** The child's reply: the fenced block a derived spec arrives in. */
export function deriveReply(criteria: SpecBullet[], problem = "the problem"): string {
  return ["Here is the contract.", specBlock(criteria, problem), "Done."].join("\n");
}

/** A reply with no parsable block — the handback case. */
export const NO_BLOCK_REPLY = "I could not tell what this issue wants.";

/**
 * Write `files` into `repo` and commit them; returns the commit sha.
 *
 * `ready` loads `.pi/work.json` AT the run's base sha, so a case that wants a
 * particular config has to commit it and then seed the run with the sha that
 * holds it — writing it into the working tree decides nothing.
 */
export function worktreeCommit(
  repo: string,
  files: Record<string, string>,
  message = "fixture",
): string {
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(repo, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body, "utf8");
  }
  const run = (args: string[]): string => {
    const r = spawnSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      env: {
        ...gitTestEnv(),
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr ?? ""}`);
    return (r.stdout ?? "").trim();
  };
  run(["add", "-A"]);
  run(["commit", "-q", "-m", message, "--allow-empty"]);
  return run(["rev-parse", "HEAD"]);
}

/**
 * A forge stub that answers `gh issue view`/`issue comment`/`issue edit`.
 *
 * `ready` reads the issue through the forge adapter when one is detected and
 * falls back to raw `gh` when it is not; every case here runs with
 * `PI_ENSEMBLE_FORGE=none`, so the raw fallback is the read under test and a
 * PATH entry is the narrowest fake that keeps the production JSON parse in
 * place (the same reasoning as `fakeGhDir` in `lib/lean-seed-fixtures.ts`).
 *
 * The reply is `cat`ed from a file, never `printf`ed: `%s` swallows a fence's
 * backquotes and produced `{"body":""}` from a well-formed spec in the suite
 * this one copies.
 *
 * Returns the dir to put on PATH and the record the stub accumulated:
 * `edits` is what makes "the body is never edited" assertable — every
 * `gh issue edit` the run attempted is a line in it, so a run that tried to
 * write the derived spec into the issue is caught by a non-empty array rather
 * than by the absence of something.
 */
export function ghStub(
  dir: string,
  issue: { title: string; body: string },
): {
  binDir: string;
  calls: { edits: string[]; comments: string[] };
} {
  mkdirSync(dir, { recursive: true });
  const calls = { edits: [] as string[], comments: [] as string[] };
  const answer = path.join(dir, "answer.json");
  writeFileSync(
    answer,
    JSON.stringify({
      body: issue.body,
      title: issue.title,
      number: 1,
      state: "OPEN",
      url: "https://forge.invalid/o/r/issues/1",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      labels: [],
      author: { login: "t" },
    }),
    "utf8",
  );
  const edits = path.join(dir, "edits.txt");
  const comments = path.join(dir, "comments.txt");
  writeFileSync(
    path.join(dir, "gh"),
    [
      "#!/bin/sh",
      'ARGS="$(printf "%s\\n" "$@")"',
      'DIR="$(dirname "$0")"',
      'case "$ARGS" in',
      '  *"issue edit"*) printf "%s\\n" "$*" >> "$DIR/edits.txt"; cat "$DIR/answer.json"; exit 0;;',
      '  *"issue comment"*) printf "%s\\n" "COMMENT" >> "$DIR/comments.txt"; printf "%s\\n" "https://forge.invalid/o/r/issues/1#comment" ; exit 0;;',
      '  *"issue view"*) cat "$DIR/answer.json"; exit 0;;',
      "  *) exit 0;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return {
    binDir: dir,
    calls: {
      get edits() {
        return linesOf(edits);
      },
      get comments() {
        return linesOf(comments);
      },
    },
  };
}

function linesOf(file: string): string[] {
  let raw = "";
  try {
    raw = require("node:fs").readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return raw.split("\n").filter((l: string) => l !== "");
}

/** Remove a stub dir. */
export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * A temp git repo with git identity configured, so a case can commit a config at the
 * base the run reads. `git init` plus one empty commit: a run's base must be a commit
 * that EXISTS before `contractOf` asks git for `.pi/work.json` at it.
 */
export function tempGitRepo(tag: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), `lean-intake-${tag}-`));
  const git = (args: string[]): void => {
    const r = spawnSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      env: { ...gitTestEnv(), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t" },
    });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr ?? ""}`);
  };
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  git(["commit", "-q", "--allow-empty", "-m", "fixture"]);
  return { dir, cleanup: () => removeDir(dir) };
}
