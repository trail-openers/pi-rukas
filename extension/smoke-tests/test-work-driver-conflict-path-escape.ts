#!/usr/bin/env bun
// #981 — conflict-path escaping unit test. A conflict path from `git
// ls-files -u` is untrusted data that lands in operator-facing markdown
// (PR body, handoff, park evidence); it must render into a code span
// without breaking it: a backtick in the data closes the span, a CR/LF
// truncates the one-line note, `](` is inert inside the span but is the
// markdown link opener an unescaped path would open.
import { renderConflictPath } from "../src/work-driver-conflict-evidence.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

{
  // The unit assertion the review asked for: a path containing a backtick,
  // `](`, AND a newline — all three at once.
  const nasty = "a/b](`c\n`d`.txt";
  const out = renderConflictPath(nasty);
  assert(out.startsWith("`") && out.endsWith("`"), "renders into a code span (backtick-delimited)");
  const body = out.slice(1, -1);
  assert(!body.includes("`"), "no raw backtick survives inside the span (would close it early)");
  assert(
    !out.includes("\n") && !out.includes("\r"),
    "no raw CR/LF survives (would truncate the one-line note)",
  );
  assert(body.includes("]("), "the `](` sequence is preserved verbatim (inert inside the span)");

  // A benign path renders unchanged inside the span.
  const benign = "src/foo/bar.ts";
  assert(
    renderConflictPath(benign) === "`src/foo/bar.ts`",
    "a benign path renders verbatim inside the span",
  );

  // CRLF specifically (Windows line endings in a path).
  const crlf = "src/a\r\nb.txt";
  const outCrlf = renderConflictPath(crlf);
  assert(!outCrlf.includes("\r") && !outCrlf.includes("\n"), "CRLF in a path is neutralised");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
