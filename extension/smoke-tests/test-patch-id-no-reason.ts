#!/usr/bin/env bun
/**
 * Every no-patch-id exit of `workingTreePatchId` names the step that failed, and no
 * no-write site renders the literal `unknown`.
 *
 * (1) One stub-git arm per exit asserts the returned `noPatchIdReason`. (2) Each reason
 * is driven through both ledger writers: the lens writer's WARN line carries it in its
 * parenthetical and returns it as `reason`; the adversarial writer returns it as
 * `reason`. (3) The round cap's refusal and trace render it on a real clone whose
 * branch has no change against the mainline — the empty-diff exit — and still refuse.
 */
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeAdversarialLedgerEntry } from "../src/adversarial-ledger.ts";
import { writeLensLedgerEntry } from "../src/lens-ledger.ts";
import { admitLensRound } from "../src/lens-round-cap.ts";
import { type LedgerExecFn, workingTreePatchId } from "../src/review-ledger.ts";
import type { DispatchResult } from "../src/types.ts";
import { gitTestEnv, writeCloneMainlineRef } from "./lib/git-test-env.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

type Answer = string | Error;
/** A git that answers by command prefix; a thrown Error is a failed command. */
function stubGit(over: Record<string, Answer>): LedgerExecFn {
  const answers: Record<string, Answer> = {
    "git symbolic-ref": "origin/main",
    "gh repo view": new Error("offline"),
    "git config --get remote.origin.url": "file:///origin",
    "git merge-base": "0123456789abcdef0123456789abcdef01234567",
    "git diff": "e74f3fef3b3851dd52c3c9f7c5fe5dfd1c7cdfdd feature.ts",
    "git status": "",
    "git config": new Error("unset"),
    "git remote": "",
    ...over,
  };
  return (async (cmd: string) => {
    const key = Object.keys(answers).find((k) => cmd.startsWith(k));
    const a = key === undefined ? new Error(`unexpected: ${cmd}`) : answers[key];
    if (a instanceof Error) throw a;
    return { stdout: a ?? "", stderr: "" };
  }) as LedgerExecFn;
}

const EXITS: [string, Record<string, Answer>, RegExp][] = [
  [
    "mainline",
    { "git symbolic-ref": new Error("no origin/HEAD") },
    /^cannot resolve the mainline branch/,
  ],
  ["remote", { "git config --get remote.origin.url": new Error("unset") }, /^no git remote found/],
  [
    "merge-base error",
    { "git merge-base": new Error("bad object") },
    /^merge-base against origin\/main failed: .*bad object/,
  ],
  ["no merge-base", { "git merge-base": "" }, /^no merge-base between HEAD and origin\/main/],
  [
    "patch-id error",
    { "git diff": new Error("patch-id died") },
    /^working-tree patch-id failed: .*patch-id died/,
  ],
  [
    "empty diff",
    { "git diff": "" },
    /^empty diff: the working tree has no change against its merge-base 01234567 with origin\/main/,
  ],
];

const capture = async <T>(fn: () => Promise<T>): Promise<{ value: T; err: string }> => {
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((c: string | Uint8Array) => {
    lines.push(String(c));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: await fn(), err: lines.join("") };
  } finally {
    process.stderr.write = write;
  }
};

// ── (1)+(2) each exit names itself, and both writers render that name
for (const [name, over, want] of EXITS) {
  const exec = stubGit(over);
  const id = await workingTreePatchId(exec, "/nowhere", { digest: true });
  const why = id.noPatchIdReason ?? "";
  assert(
    id.patchId === undefined && want.test(why),
    `(1) ${name}: the reason names the step (${why})`,
  );
  const lens = await capture(() =>
    writeLensLedgerEntry(
      "APPROVED",
      "HIGH",
      "/nowhere",
      undefined,
      false,
      undefined,
      undefined,
      "b",
      undefined,
      undefined,
      undefined,
      id,
    ),
  );
  const shown = /no patch id \((.*)\); the round is not recorded/.exec(lens.err)?.[1];
  assert(shown === why, `(2) ${name}: the lens WARN names it (${String(shown)})`);
  assert(
    !lens.value.recorded && lens.value.reason === why,
    `(2) ${name}: and returns it as the reason`,
  );
  assert(!lens.err.includes("unknown"), `(2) ${name}: the lens writer never prints \`unknown\``);
  const adv = await writeAdversarialLedgerEntry({ ok: true } as DispatchResult, {
    workCwd: "/nowhere",
    resolvedBranch: "b",
    execFn: exec,
  });
  assert(
    !adv.recorded && adv.reason === why,
    `(2) ${name}: the adversarial writer's reason is it too`,
  );
}

// The recorded-with-a-warning channel is untouched: a patch id, the untracked warning, no reason.
{
  const id = await workingTreePatchId(stubGit({ "git status": "?? new.ts\n" }), "/nowhere");
  assert(
    id.patchId !== undefined &&
      id.noPatchIdReason === undefined &&
      id.warning === "untracked files not covered by the ledger patchId: new.ts",
    `(1) untracked files keep their warning text and set no reason (${String(id.warning)})`,
  );
}

// ── (3) the round cap renders the empty-diff reason and still refuses
{
  gitTestEnv();
  const root = mkdtempSync(path.join(os.tmpdir(), "patch-id-reason-"));
  const repo = path.join(root, "repo");
  const g = (cwd: string, ...a: string[]) =>
    execSync(`git ${a.map((x) => `'${x}'`).join(" ")}`, { cwd, encoding: "utf8" }).trim();
  g(root, "init", "-q", "--bare", "origin.git");
  execSync(`mkdir ${repo}`);
  g(repo, "init", "-q", "-b", "main");
  g(repo, "config", "user.email", "t@t");
  g(repo, "config", "user.name", "t");
  writeFileSync(path.join(repo, "a.ts"), "export const a = 1;\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "base");
  g(repo, "remote", "add", "origin", path.join(root, "origin.git"));
  g(repo, "push", "-q", "-u", "origin", "main");
  writeCloneMainlineRef(repo, g);
  g(repo, "checkout", "-qb", "feature/empty");
  const debug = process.env.PI_ENSEMBLE_DEBUG;
  process.env.PI_ENSEMBLE_DEBUG = "1";
  const r = await capture(() => admitLensRound({ cwd: repo, env: {} }));
  if (debug === undefined) delete process.env.PI_ENSEMBLE_DEBUG;
  else process.env.PI_ENSEMBLE_DEBUG = debug;
  const note = r.value.admitted ? "" : (r.value.refusal.note ?? "");
  assert(!r.value.admitted, "(3) a round with no patch id is still refused");
  assert(
    note.startsWith("ROUND_CAP_REACHED — the round cannot be recorded: empty diff: "),
    `(3) the refusal names the empty diff (${note.slice(0, 140)})`,
  );
  assert(
    /lens-round-cap: no patch id \(empty diff: /.test(r.err) && !r.err.includes("unknown"),
    `(3) and so does the trace, never \`unknown\` (${r.err.trim().slice(0, 200)})`,
  );
  execSync(`rm -rf ${root}`);
}

process.exit(failures());
