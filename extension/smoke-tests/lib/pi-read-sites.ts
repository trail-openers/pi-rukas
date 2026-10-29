/**
 * Smoke-test helper (#1907): the read-site scan behind
 * `test-headless-inputs.ts`'s `.pi/*` inventory check. Split out so that gate
 * stays under the AGENTS.md §12 size cap.
 *
 * Two readers, because a project file reaches the driver two ways.
 *
 * **Filesystem** — the ordinary shape: a site joins the path to a root
 * (`path.join(root, ".pi", "x")`, `` `${root}/.pi/x` ``, or
 * `path.join(root, CONST)` where `CONST = ".pi/x"`) and a filesystem read or
 * exec follows within two lines.
 *
 * **git blob** (`gitBlob: true`) — the shape a config the engine reads AT A
 * COMMIT uses. `lean/config.ts` does not call `exec` where it names the path:
 * `loadWorkConfig` builds the ref and hands it to `gitShow`, which issues the
 * argv-form `exec("git", { argv: ["show", ref] })` a few lines away. So the
 * reader's NAME counts as well as the call. Not folded into `READ_API`
 * wholesale — a module whose only "read" is an arbitrary `exec` is exactly the
 * false positive the narrow list exists to avoid — and it matches the CALL, not
 * the injected type annotation (`export type ConfigExec = typeof execp`), which
 * names a seam, not a read. The names are written by concatenation, not as
 * literals: this very file's doc-comment quotes them, and a gate whose pattern
 * matches the prose that explains it has stopped testing anything.
 */

import path from "node:path";

/** A comment line states rather than reads, so it is never a site. */
const COMMENT = /^\s*(\*|\/\*|\/\/)/;

const READ_API =
  /\b(readFileSync|readFile|access|accessSync|existsSync|stat|statSync|fileExists|spawn|execFile)\b/;

const GIT_READ_API = new RegExp(
  "\\bexec(p|FileP)?\\(\"git\"|\\bgit" + "Show\\(|\\bgit" + "Type\\(|\\bgit\\(",
);

/**
 * How many lines a git read may sit from the line that names the path. Six: an
 * argv is written inside the options object its call opens (`execp("git", {`
 * then `argv: ["show", ref]`), so a real read is never far, and anything wider
 * would let an unrelated git command elsewhere in the module stand in for it.
 */
const GIT_READ_WINDOW = 6;

/** How many lines a filesystem read may sit from the line that names the path. */
const READ_WINDOW = 3;

/**
 * Every place in `files` (path → source text) that reads `piPath`.
 *
 * For a git-blob config a site is a line that QUOTES the path — quoted only,
 * because a doc-comment mention is prose and reads nothing — with the git read
 * issued within `GIT_READ_WINDOW` lines of it. The reader there is a named
 * helper (`gitShow(`) rather than a bare `exec`, and that name counts too: what
 * is being proved is that the module fetches this path out of git, and a helper
 * whose whole job is that fetch is the fetch.
 */
export function readSites(
  files: Map<string, string>,
  piPath: string,
  gitBlob = false,
): string[] {
  const base = path.basename(piPath);
  const consts = new Set<string>();
  const constRe = (exported: boolean) =>
    new RegExp(`${exported ? "export " : ""}const (\\w+) = "${piPath.replace(".", "\\.")}"`, "g");
  for (const text of files.values()) {
    for (const m of text.matchAll(constRe(false))) consts.add(m[1] as string);
    // `export const X = ".pi/x"` — the form a module keeps a committed config's
    // path in. The scan above cannot see it: its `const (\w+)` needs `const `
    // immediately before the name, and `export ` sits between them here.
    if (gitBlob) for (const m of text.matchAll(constRe(true))) consts.add(m[1] as string);
  }
  const sites: string[] = [];
  if (gitBlob) {
    const backtick = String.fromCharCode(96);
    const dollar = String.fromCharCode(36);
    const quoted = [
      `"${piPath}"`,
      backtick + piPath + backtick,
      // The ref the lean loader builds: `${baseSha}:.pi/work.json`.
      backtick + dollar + `{baseSha}:` + piPath + backtick,
    ];
    for (const [rel, text] of files) {
      const lines = text.split("\n");
      lines.forEach((line, n) => {
        if (COMMENT.test(line) || !quoted.some((q) => line.includes(q))) return;
        if (GIT_READ_API.test(lines.slice(n, n + GIT_READ_WINDOW).join("\n")))
          sites.push(`${rel}:${n + 1}`);
      });
    }
    return sites;
  }
  const forms = [`".pi", "${base}"`, `}/${piPath}\``, ...[...consts].map((c) => `, ${c})`)];
  for (const [rel, text] of files) {
    const lines = text.split("\n");
    lines.forEach((line, n) => {
      if (COMMENT.test(line) || !forms.some((f) => line.includes(f))) return;
      if (READ_API.test(lines.slice(n, n + READ_WINDOW).join("\n"))) sites.push(`${rel}:${n + 1}`);
    });
  }
  return sites;
}

