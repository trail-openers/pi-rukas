#!/usr/bin/env bun
/**
 * #1866 follow-up / lens round 1 — WHICH bytes of a text-mode child the
 * supervisor forwards.
 *
 * `test-headless-supervise.ts` owns "did the child answer, and with what code".
 * This file owns the other half of the host contract: the child's stream is
 * cut at the line the PARSER accepted, and only the two documented prose line
 * shapes go ahead of the document.
 *
 * Two defects live here:
 *
 * 1. The forwarder located the document by comparing every line with
 *    `JSON.stringify(answered)`. A child whose line is valid JSON but not
 *    byte-identical to the re-stringify of its own parse (extra spaces,
 *    reordered keys) matched NOTHING, so the head never cut and the WHOLE
 *    buffer went out as "prose" ahead of the re-stringified document — two
 *    documents on the host's stream, the one property the supervisor exists to
 *    keep. `parseResultLine` now returns the index of the line it accepted and
 *    the forwarder echoes THOSE bytes.
 * 2. "Not the document" was the only test a line had to pass to be forwarded as
 *    prose, so anything a child printed before its result (a library warning, a
 *    stray `console.log`) reached the host. Only the `pi-rukas-headless: `
 *    summary and the `error:` reason are prose now; everything else is dropped.
 *
 * Every fixture document is built by the real `resultDocument(...)` builder so
 * the bytes under test are the bytes `formatResultDocument` writes.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RESULT_SCHEMA_VERSION, resultDocument } from "../src/headless/result.ts";
import {
  ERROR_PREFIX,
  SUMMARY_PREFIX,
  parseResultLine,
  proseLinesBefore,
  superviseWork,
} from "../src/headless/supervise.ts";

let exit = 0;
function assert(cond: boolean, msg: string, actual?: unknown) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}${actual !== undefined ? ` (got ${JSON.stringify(actual)})` : ""}`);
    exit = 1;
  }
}

const repoRoot = mkdtempSync(path.join(os.tmpdir(), "headless-sup-prose-"));
const bun = process.execPath;
/** The result-document lines on a stream — the host's JSON contract. */
const docs = (out: string): string[] =>
  out.split("\n").filter((l) => l.trim().startsWith("{") && l.includes('"schemaVersion"'));
/** A child's document line, built by the real builder rather than by hand. */
const builtDoc = (exitCode: number, issue = 345, status = "merged"): string =>
  JSON.stringify(
    resultDocument(
      { exitCode, results: [{ issue, status, stateFile: "/dev/null", exitCode }] },
      { commit: null, version: "0.0.0-test" },
    ),
  );
/**
 * Re-key a document so its bytes differ from `JSON.stringify` of its own parse:
 * reordered keys and padded separators. Still valid JSON, still a document —
 * which is the whole point.
 */
const scramble = (doc: string): string => {
  const obj = JSON.parse(doc) as Record<string, unknown>;
  let s = "{";
  for (const k of Object.keys(obj).reverse()) s += ` "${k}" : ${JSON.stringify(obj[k])},`;
  return `${s.slice(0, -1)} }`;
};
/** A child that prints `lines` (each terminated) then exits with `code`. */
const printer = (lines: string[], code: number, tail = ""): string =>
  [
    ...lines.map((l) => `process.stdout.write(${JSON.stringify(l)} + String.fromCharCode(10));`),
    // The document itself always arrives as the LAST argv element, so no
    // quoting layer between here and the child can rewrite its bytes.
    "process.stdout.write(process.argv[process.argv.length - 1] + String.fromCharCode(10));",
    tail,
    `process.exit(${code});`,
  ].join("");

try {
  // ── --json mode forwards the document ALONE, even from a text-mode-shaped
  // child: prose is never smuggled onto a JSON host's stdout.
  {
    let out = "";
    const doc = builtDoc(10);
    const code = await superviseWork({
      repoRoot,
      issues: [345],
      json: true,
      command: [bun, "-e", printer([`${SUMMARY_PREFIX} #345 merged (exit 10)`], 10), doc],
      write: (s) => {
        out += s;
      },
    });
    assert(
      code === 10 && out === `${doc}\n`,
      "--json mode forwards the document alone: a text-mode-shaped child does not smuggle prose onto a JSON host's stdout",
      { code, out },
    );
  }

  // ── the whitelist, asserted directly: which lines of a head are prose.
  {
    const whitelisted = proseLinesBefore(
      [
        `${SUMMARY_PREFIX} #345 merged (exit 10)`,
        "warning: noise from a library",
        `${ERROR_PREFIX} cap-hit`,
        builtDoc(10),
        "late",
      ],
      3,
    );
    assert(
      whitelisted === `${SUMMARY_PREFIX} #345 merged (exit 10)\n${ERROR_PREFIX} cap-hit\n`,
      "only the published prose prefixes survive, in the child's own order",
      whitelisted,
    );
    assert(
      proseLinesBefore(["prose", "{ not json", builtDoc(10), "late prose", ""], 2) === "",
      "a non-whitelisted line before the document is not prose, and neither is a brace-line",
    );
    assert(
      proseLinesBefore([builtDoc(10), "late prose", ""], 0) === "",
      "nothing after the document is forwarded",
    );
    assert(
      proseLinesBefore(
        [`${SUMMARY_PREFIX}#no-space`, `${ERROR_PREFIX}no-space`, builtDoc(10)],
        2,
      ) === "",
      "a line that merely starts with the prefix but carries no space is not prose either",
    );
    // The locator is the whole of the byte-exactness property: the index points
    // at the line the child wrote, not at a line equal to its re-stringify.
    const padded = `  ${scramble(builtDoc(10))}  `;
    const located = parseResultLine(`${padded}\n`);
    assert(
      located?.index === 0,
      "parseResultLine reports the index of the line it accepted, whitespace and key order intact",
      located,
    );
    assert(
      parseResultLine(`noise\n{ "schemaVersion": ${RESULT_SCHEMA_VERSION} }\n`)?.index ===
        undefined,
      "a non-document brace-line is still not a document, padded or not",
    );
  }

  // ── Fix 1: a child whose document bytes are NOT the re-stringify of its own
  // parse still yields exactly ONE document, forwarded byte for byte.
  {
    let out = "";
    const scrambled = scramble(builtDoc(10));
    const code = await superviseWork({
      repoRoot,
      issues: [345],
      json: false,
      command: [bun, "-e", printer([`${SUMMARY_PREFIX} #345 merged (exit 10)`], 10), scrambled],
      write: (s) => {
        out += s;
      },
    });
    assert(
      code === 10 && docs(out).length === 1,
      "a document whose bytes differ from its re-stringify still yields exactly ONE document",
      { code, out, docs: docs(out) },
    );
    assert(
      out === `${SUMMARY_PREFIX} #345 merged (exit 10)\n${scrambled}\n`,
      "the forwarded document is the child's own LINE, byte for byte, after its summary",
      out,
    );
    assert(
      (JSON.parse(out.split("\n")[1] as string) as { exitCode?: number }).exitCode === 10,
      "and the forwarded line is still the same document the parser accepted",
      out,
    );
  }

  // ── Fix 2: a stray non-prefixed line ahead of the summary is DROPPED, not
  // forwarded as prose. "Not the document" is not what makes a line prose.
  {
    let out = "";
    const doc = builtDoc(10);
    const code = await superviseWork({
      repoRoot,
      issues: [345],
      json: false,
      command: [
        bun,
        "-e",
        printer(
          [
            "warning: a library cleared its cache",
            `${SUMMARY_PREFIX} #345 merged (exit 10)`,
            "debug: some internal chatter",
            `${ERROR_PREFIX} cap-hit — stopped at a cap`,
          ],
          10,
        ),
        doc,
      ],
      write: (s) => {
        out += s;
      },
    });
    const lines = out.split("\n").filter((l) => l.trim() !== "");
    assert(
      code === 10 &&
        lines.length === 3 &&
        lines[0] === `${SUMMARY_PREFIX} #345 merged (exit 10)` &&
        lines[1] === `${ERROR_PREFIX} cap-hit — stopped at a cap` &&
        lines[2] === doc,
      "only the summary and error lines survive, in order, ahead of the document",
      { code, out },
    );
    assert(
      !out.includes("warning:") && !out.includes("debug:"),
      "the stray non-prefixed lines the child printed are dropped",
      out,
    );
  }

  // ── #1866 follow-up: text mode still keeps the two documented prose lines and
  // still emits exactly one document. The forwarder used to emit only the
  // document LINE, so a text-mode host — promised the `pi-rukas-headless: #N
  // status (exit N)` summary — read a single JSON blob instead.
  {
    let out = "";
    const doc = builtDoc(10);
    const code = await superviseWork({
      repoRoot,
      issues: [345],
      json: false,
      command: [
        bun,
        "-e",
        printer(
          [`${SUMMARY_PREFIX} #345 merged (exit 10)`, `${ERROR_PREFIX} cap-hit — stopped at a cap`],
          10,
          "process.stdout.write('stray bytes after the document' + String.fromCharCode(10));",
        ),
        doc,
      ],
      write: (s) => {
        out += s;
      },
    });
    const lines = out.split("\n").filter((l) => l.trim() !== "");
    assert(
      code === 10 && lines.length === 3 && lines[0] === `${SUMMARY_PREFIX} #345 merged (exit 10)`,
      "text mode forwards the summary and error line, then the document",
      { code, out },
    );
    assert(
      lines[1] === `${ERROR_PREFIX} cap-hit — stopped at a cap`,
      "the error line keeps its place, in the child's own order",
      out,
    );
    assert(lines[2] === doc, "the document LINE is the last thing on the stream, verbatim", out);
    assert(
      !out.includes("stray bytes after the document"),
      "bytes the child printed AFTER its document are still not forwarded",
      out,
    );
    assert(docs(out).length === 1, "exactly one document line on a text-mode stdout", out);
  }
} finally {
  rmSync(repoRoot, { recursive: true, force: true });
}

process.exit(exit);
