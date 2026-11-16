/**
 * Static scans for executors that drop the argv form (#1279, #1283). Shared
 * by `test-exec-argv-contract.ts` (production modules) and
 * `test-exec-argv-fakes.ts` (the smoke tests' own fakes).
 *
 * Both return `"<line>: <code>"` entries, so a failure names the site.
 */

/**
 * The code of `line`, with string bodies replaced by `""` and any trailing
 * comment cut away, so prose never reads as a use of a binding.
 *
 * The comment is found by a scan, not by `replace(/\s\/\/.*$/, "")`: that strip
 * needs only whitespace before the slashes, and a regex literal body satisfies
 * it. `const seg = p.split(/\//); …` truncated at the `//` inside `\//` and the
 * hand-on sharing the line was deleted with the "comment" — which is how the
 * scan went blind to a real argv-dropping executor. A scan finds a comment only
 * where neither a string nor a regex is open, so the slashes of `"https://x"`
 * and of `/\//` both stay code.
 *
 * A `/` opens a regex where one can syntactically start — after `= , : [ { ; ! ?
 * | }`, after `return`, or at the head of the line. `&` and `+` are deliberately
 * absent: after `a & b` a slash is division, and `const m = a & b; // run` must
 * still lose its comment. The literal runs to the first `/` outside a character
 * class, keeps its flags, and is emitted verbatim so the code after it stays
 * visible. A `/` with no closing slash is not a literal, so it is kept as the
 * ordinary character it is — swallowing the tail there would hide a hand-on that
 * follows an open `/a//b`. Each line is judged on its own, so a multi-line
 * template literal opens its quote on one line and closes it on the next;
 * template bodies are stripped as strings and are not tracked across lines.
 */
function scannableCode(line: string): string {
  let out = "";
  let quote: string | null = null;
  // The last kept code character: a `/` opens a regex only after one of these.
  let prev = "";
  const regexStarts = () => prev === "" || "=,:[{;!?|}".includes(prev) || /\breturn\s$/.test(out);
  for (let i = 0; i < line.length; i++) {
    const c = line[i] ?? "";
    if (quote !== null) {
      if (c === "\\") i++;
      else if (c === quote) {
        quote = null;
        out += '""';
      }
      continue;
    }
    if (c === "#" || (c === "/" && line[i + 1] === "/" && regexStarts())) break;
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      prev = c;
      continue;
    }
    if (c === "/" && regexStarts()) {
      // A regex body cannot hold a bare `/`, so the literal ends at the first
      // `/` outside a character class. Backslashes are deliberately not honoured
      // as escapes here: treating `\/` as a unit would swallow the closing
      // slash, and the most a literal written that way can suffer is an early
      // end — it can never hide the code that follows it.
      let j = i + 1;
      let cls = false;
      while (j < line.length) {
        const d = line[j] ?? "";
        if (cls && d === "]") cls = false;
        else if (!cls && d === "[") cls = true;
        else if (d === "/" && !cls) break;
        j++;
      }
      if (j >= line.length) {
        // No closing slash, so this is not a literal — a stray slash, or a
        // multi-line regex the scan cannot see past. Keeping the `/` (and its
        // own character as the next `prev`) is what makes a following `//` a
        // comment again: swallowing the tail here would hide a hand-on sitting
        // after an unterminated `/a//b`, which is code, never a regex.
        out += c;
        prev = c;
        continue;
      }
      // Flags start past the closing slash, so only letters are taken as flags:
      // a scan started on the slash itself would swallow the `;` of `/\//);` and
      // leave the comment position unrecognised.
      let k = j + 1;
      while (k < line.length && /[a-z]/.test(line[k] ?? "")) k++;
      out += line.slice(i, k);
      prev = "/";
      i = k - 1;
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
  }
  return out.trim();
}

/** Every place `source` hands a bare `promisify(exec)` on instead of calling it. */
export function shellOnlyEscapes(source: string): string[] {
  const escapes: string[] = [];
  const lines = source.split("\n");
  const defRe = /\b(?:const|let)\s+(\w+)(?::\s*[\w.]+)?\s*=\s*promisify\(\s*exec\w*\s*\)/g;
  for (const def of source.matchAll(defRe)) {
    const use = new RegExp(`(?<!typeof\\s)\\b${def[1]}\\b(?!\\s*\\()`);
    lines.forEach((line, i) => {
      // String contents are prose, not uses ("refusing shell interpolation"),
      // and a trailing `//` comment is prose too — `defRe` accepts any
      // `promisify(exec*)`, so the bound name is often an ordinary English word,
      // and `const run = promisify(execFile)` plus one prose "run" was read as a
      // hand-on. The leading-marker checks below only catch a comment that STARTS
      // the line, so a `{ // …` opener needs the comment removed — by
      // `scannableCode`, which tells a comment apart from a regex or a URL.
      const code = scannableCode(line);
      if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
      // An import binds a name; it hands nothing on.
      if (code.startsWith("import ")) return;
      if (/=\s*promisify\(/.test(code)) return;
      if (use.test(code)) escapes.push(`${i + 1}: ${code}`);
    });
  }
  return escapes;
}

/** The body of the arrow function whose `=>` ends just before `from`. */
function arrowBody(source: string, from: number): string {
  let i = from;
  let depth = 0;
  if (source[i] === "{") {
    for (; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}" && --depth === 0) break;
    }
    return source.slice(from, i + 1);
  }
  for (; i < source.length; i++) {
    const c = source[i] ?? "";
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      if (depth === 0) break;
      depth--;
    } else if ((c === ";" || c === ",") && depth === 0) break;
  }
  return source.slice(from, i);
}

/**
 * Every executor-shaped arrow function — `(cmd, opts) => …`, the second
 * parameter an options object — that hands `cmd` to a shell (`sh -c cmd`,
 * node's `exec(cmd, …)`, or a `promisify(exec)` it defines) and never looks
 * at `argv`. An argv-form call through it runs a bare `git` (#1279's shape).
 * A body that reads `argv`, or matches via `commandOf` / `asShellForm`
 * (lib/argv-shell.ts), is argv-aware. A second parameter typed `string` (a
 * fixture's own `sh(cmd, cwd)`) is not an executor and is skipped.
 *
 * Scope — arrow functions with exactly two parameters `(cmd, opts) => …` only.
 * NOT caught: `function` declarations, one-parameter (cmd-only) stubs, and
 * anything that forwards `cmd` to a shared executor such as `realExec` (that
 * executor is checked where it is defined, lib/exec-fake.ts).
 */
export function argvDroppingFakes(source: string): string[] {
  const shells = ["exec"];
  for (const m of source.matchAll(
    /\b(?:const|let)\s+(\w+)(?::[^=]+)?\s*=\s*promisify\(\s*exec\s*\)/g,
  ))
    if (m[1]) shells.push(m[1]);
  const fnRe =
    /(?:async\s*)?\(\s*(\w+)(?:\s*:\s*string)?\s*,\s*\w+\??(\s*:[^)]*)?\)\s*(?::[^=]*)?=>\s*/g;
  const found: string[] = [];
  for (const m of source.matchAll(fnRe)) {
    const [head = "", cmd = "", optsType = ""] = m;
    if (/^\s*:\s*string\s*$/.test(optsType)) continue;
    const body = arrowBody(source, (m.index ?? 0) + head.length);
    // `(?<!\.)`: a method call (`re.exec(line)`) is not node's `exec`.
    const toShell = new RegExp(
      `"-c",\\s*${cmd}\\b|(?<!\\.)\\b(?:${shells.join("|")})\\(\\s*${cmd}\\s*[,)]`,
    );
    if (!toShell.test(body) || /\bargv\b|\bcommandOf\b|\basShellForm\b/.test(body)) continue;
    const line = source.slice(0, m.index).split("\n").length;
    found.push(`${line}: ${(source.split("\n")[line - 1] ?? "").trim()}`);
  }
  return found;
}
