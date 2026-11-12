#!/usr/bin/env bun
/**
 * #2160 lens fix — the bounds the PARENT puts on a `forge_read` answer.
 *
 * Split out of `test-forge-read.ts` for the §12 size cap; the seam is the
 * concern, not the line count. That file judges which verbs answer and which
 * are refused; this one judges how MUCH of an answer the child gets, which is
 * a different question and had no owner:
 *
 *   - LIST READS. `gh issue/pr list` answers 30 rows and `glab` one page of 20
 *     unless told otherwise, and a short list is indistinguishable, in the bytes
 *     the child reads, from the whole list — there is no total in the payload to
 *     compare the row count against. So every list read asks for the parent's
 *     page size, and a reply that FILLS it says so in one plain line the child
 *     reads. The cap is the parent's, never a request field: a child that could
 *     raise it would be choosing how much of its own context a read spends.
 *   - RAW-TEXT READS. `pr_diff` and `ci_run_log` answer the forge's own text
 *     rather than a mapped row set, so nothing between the CLI and the child's
 *     context bounded them: a generated lockfile's diff or a build's whole log
 *     arrived complete and the child paid for it on every later turn. Both are
 *     capped at the parent, keeping the head, and the byte counts the child did
 *     not get are named.
 *
 * The arm that must not regress in either direction is the quiet one: a read
 * under its cap comes back byte-for-byte unchanged. A diff that silently gained
 * a truncation line would no longer be the bytes the forge sent.
 */

import { FORGE_LIST_LIMIT } from "../src/forge-commands.ts";
import { createForge } from "../src/forge.ts";
import { FORGE_RAW_TEXT_CAP_BYTES, executeForgeRead } from "../src/forge-read-execute.ts";
import {
  ghDetection,
  glDetection,
  ghIssueRows,
  ghPrRows,
  glIssueRows,
  glMrRows,
  mkExec,
} from "./forge-fixtures.ts";
import { assert, check, forgeExitCode } from "./lib/forge-harness.ts";

const JSON_ = (v: unknown): string => JSON.stringify(v);
const GH_DET = ghDetection("acme", "widget");
const GL_DET = glDetection("acme", "widget");

/** The exact line a full page appends — one string, asserted rather than re-typed. */
const CAP_NOTE = "\ncapped at 100 rows; the list may be incomplete";

/** The lead of the raw-text truncation note, matched rather than re-typed. */
const TRUNCATION_MARK = "\n\u2026 truncated: ";

/** Run one verb against a fake exec and return the raw bytes the child would read. */
async function read(
  det: typeof GH_DET,
  exec: ReturnType<typeof mkExec>,
  req: Record<string, unknown>,
): Promise<string> {
  return executeForgeRead(det, "/repo", req as never, {
    buildForge: (d, o) => createForge(d, { execFn: exec.fn, cwd: o.cwd }),
  });
}

async function main(): Promise<void> {
  console.log("list page size:");
  await check("every list read carries the parent's page size", async () => {
    const exec = mkExec({ "": { stdout: "[]" } });
    for (const req of [
      { verb: "issue_list" },
      { verb: "issue_search", query: "widget" },
      { verb: "pr_list" },
    ]) {
      await read(GH_DET, exec, req);
      await read(GL_DET, exec, req);
    }
    const gh = exec.calls.filter((c) => c.startsWith("gh "));
    const gl = exec.calls.filter((c) => c.startsWith("glab "));
    assert(gh.length === 3 && gl.length === 3, `six list commands ran (${exec.calls.join(" | ")})`);
    for (const c of gh) {
      assert(c.includes(`--limit ${FORGE_LIST_LIMIT}`), `the gh list read asks for the page: ${c}`);
    }
    for (const c of gl) {
      assert(
        c.includes(`--per-page ${FORGE_LIST_LIMIT}`),
        `the glab list read asks for the page: ${c}`,
      );
    }
  });
  await check("a list that fills the page says it was capped; a shorter one says nothing", async () => {
    const full = mkExec({ "gh pr list": { stdout: JSON_(ghPrRows(FORGE_LIST_LIMIT)) } });
    const capped = await read(GH_DET, full, { verb: "pr_list" });
    assert(capped.endsWith(CAP_NOTE), `a full page is disclosed (${JSON_(capped.slice(-70))})`);
    const short = mkExec({ "glab issue list": { stdout: JSON_(glIssueRows(3)) } });
    const complete = await read(GL_DET, short, { verb: "issue_list" });
    assert(
      !complete.includes("capped at"),
      `a short page is returned unchanged (${JSON_(complete.slice(-70))})`,
    );
  });
  await check("the cap is answered for all three list verbs on both forges", async () => {
    const cases: Array<{
      det: typeof GH_DET;
      needle: string;
      req: Record<string, unknown>;
      rows: unknown[];
    }> = [
      {
        det: GH_DET,
        needle: "gh issue list",
        req: { verb: "issue_list" },
        rows: ghIssueRows(FORGE_LIST_LIMIT),
      },
      {
        det: GH_DET,
        needle: "gh issue list --search",
        req: { verb: "issue_search", query: "widget" },
        rows: ghIssueRows(FORGE_LIST_LIMIT),
      },
      {
        det: GH_DET,
        needle: "gh pr list",
        req: { verb: "pr_list", state: "open" },
        rows: ghPrRows(FORGE_LIST_LIMIT),
      },
      {
        det: GL_DET,
        needle: "glab issue list",
        req: { verb: "issue_list", state: "all" },
        rows: glIssueRows(FORGE_LIST_LIMIT),
      },
      {
        det: GL_DET,
        needle: "glab mr list",
        req: { verb: "pr_list" },
        rows: glMrRows(FORGE_LIST_LIMIT),
      },
    ];
    for (const c of cases) {
      const exec = mkExec({ [c.needle]: { stdout: JSON_(c.rows) } });
      const out = await read(c.det, exec, c.req);
      assert(
        out.endsWith(CAP_NOTE),
        `${JSON_(c.req)} at a full page discloses the cap (${JSON_(out.slice(-60))})`,
      );
    }
  });

  console.log("raw-text caps:");
  await check("a diff read past its cap keeps its head and names the bytes it dropped", async () => {
    const dropped = "TAIL-MARKER";
    const exec = mkExec({
      "gh pr diff 17": { stdout: `${"x".repeat(FORGE_RAW_TEXT_CAP_BYTES)}${dropped}` },
    });
    const diff = await read(GH_DET, exec, { verb: "pr_diff", number: 17 });
    assert(
      diff.startsWith("x".repeat(FORGE_RAW_TEXT_CAP_BYTES)) && !diff.includes(dropped),
      "the head of the diff is kept and the tail is gone",
    );
    assert(
      diff ===
        `${"x".repeat(FORGE_RAW_TEXT_CAP_BYTES)}\n… truncated: ${dropped.length} of ${FORGE_RAW_TEXT_CAP_BYTES + dropped.length} bytes`,
      `the whole reply is the head plus the note (${JSON_(diff.slice(-48))})`,
    );
  });
  await check("a log read past its cap keeps its head and names the bytes it dropped", async () => {
    const exec = mkExec({
      "/jobs": {
        stdout: JSON_([{ id: 1, name: "build", status: "completed", conclusion: "failure" }]),
      },
      "--log-failed": { stdout: `${"y".repeat(FORGE_RAW_TEXT_CAP_BYTES)}TAIL` },
    });
    const log = await read(GH_DET, exec, { verb: "ci_run_log", id: 901 });
    assert(
      log.startsWith("y".repeat(FORGE_RAW_TEXT_CAP_BYTES)) && !log.includes("TAIL"),
      "the head of the log is kept and the tail is gone",
    );
    assert(
      /\n… truncated: 4 of 204804 bytes$/.test(log),
      `the truncation names the byte counts (${JSON_(log.slice(-40))})`,
    );
  });
  await check(
    "a cap that lands inside a multi-byte character keeps complete characters and honest counts",
    async () => {
      // The bound is a byte bound, but `slice` counts UTF-16 code units, so a
      // 204 800-unit slice can end between the two halves of a surrogate pair. A
      // 204 800-unit slice can end between the two halves of a surrogate pair. A
      // lone high surrogate is invalid text: any later UTF-8 encode of the reply
      // (a JSON body, an utf8 pipe) replaces it with U+FFFD, so the child would
      // read a corrupt final character — from a read whose contract is the forge's
      // own bytes. And a note that counts against the cap rather than what was
      // kept is a byte count that does not match the bytes the child got.
      //
      // Four arms, one per overshoot of a 4-byte character over the byte bound,
      // so the fix cannot pass by keeping the head one character short at the
      // arms where the naive slice happened to land clean.
      for (const offset of [0, 1, 2, 3]) {
        // `…` is U+2026 and the ellipsis+space of the note are not filler: the
        // head ends in ASCII, so any truncation line the reply gains is the
        // parent's and sits exactly at the cap.
        const filler = "a";
        const emoji = "\u{1F389}";
        const text = `${filler.repeat(FORGE_RAW_TEXT_CAP_BYTES - 3 + offset)}${emoji.repeat(2000)}`;
        const total = Buffer.byteLength(text, "utf8");
        const exec = mkExec({ "gh pr diff 17": { stdout: text } });
        const diff = await read(GH_DET, exec, { verb: "pr_diff", number: 17 });
        const noteAt = diff.lastIndexOf(TRUNCATION_MARK);
        assert(noteAt > 0, `offset ${offset}: the reply carries a truncation note`);
        const kept = diff.slice(0, noteAt);
        const keptBytes = Buffer.byteLength(kept, "utf8");
        const last = kept.charCodeAt(kept.length - 1);
        assert(
          !(last >= 0xdc00 && last <= 0xdfff),
          `offset ${offset}: the kept head ends on a complete character (last code unit 0x${last.toString(16)})`,
        );
        assert(
          Buffer.from(kept, "utf8").toString("utf8") === kept,
          `offset ${offset}: the kept head round-trips through a UTF-8 encode unchanged`,
        );
        assert(keptBytes <= FORGE_RAW_TEXT_CAP_BYTES, `offset ${offset}: the byte cap holds`);
        const note = diff.slice(noteAt + TRUNCATION_MARK.length);
        const claimed = Number(note.match(/^(\d+) of (\d+) bytes$/)?.[1]);
        assert(
          claimed === total - keptBytes,
          `offset ${offset}: the note names the bytes actually dropped (${note}; total ${total}, kept ${keptBytes})`,
        );
      }
    },
  );
  await check("a read at or under the cap comes back byte-for-byte unchanged", async () => {
    const exact = "z".repeat(FORGE_RAW_TEXT_CAP_BYTES);
    const exec = mkExec({ "gh pr diff 17": { stdout: exact } });
    assert(
      (await read(GH_DET, exec, { verb: "pr_diff", number: 17 })) === exact,
      "a diff that exactly fills the cap gains nothing",
    );
    const small = mkExec({ "gh pr diff 18": { stdout: "+small\n" } });
    assert(
      (await read(GH_DET, small, { verb: "pr_diff", number: 18 })) === "+small\n",
      "an ordinary diff is the forge's bytes, unaltered",
    );
  });

  await forgeExitCode("forge_read list and raw-text reads are bounded by the parent");
}

await main();
