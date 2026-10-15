/**
 * Static scans for executors that drop the argv form (#1279, #1283). Shared
 * by `test-exec-argv-contract.ts` (production modules) and
 * `test-exec-argv-fakes.ts` (the smoke tests' own fakes).
 *
 * Both return `"<line>: <code>"` entries, so a failure names the site.
 */

/** Every place `source` hands a bare `promisify(exec)` on instead of calling it. */
export function shellOnlyEscapes(source: string): string[] {
  const escapes: string[] = [];
  const lines = source.split("\n");
  const defRe = /\b(?:const|let)\s+(\w+)(?::\s*[\w.]+)?\s*=\s*promisify\(\s*exec\w*\s*\)/g;
  for (const def of source.matchAll(defRe)) {
    const use = new RegExp(`(?<!typeof\\s)\\b${def[1]}\\b(?!\\s*\\()`);
    lines.forEach((line, i) => {
      // String contents are prose, not uses ("refusing shell interpolation").
      const code = line.trim().replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');
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
