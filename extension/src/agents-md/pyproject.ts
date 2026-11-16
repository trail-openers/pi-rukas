import { statSync } from "node:fs";
import path from "node:path";

/**
 * pyproject.toml predicates for a Python repository — the one place that
 * decides whether a manifest asks for pytest or ruff.
 *
 * Two callers read these: `agents-md/detect.ts` renders the answer into
 * AGENTS.md's Testing Standards section, and `work-driver-verify-cmd.ts`
 * discovers a Python repo's develop-gate verify command from it. The SAME
 * question must be asked of the SAME files, so neither site keeps its own
 * regex set.
 *
 * Why a walker and not a substring regex: TOML has comments and strings, and
 * `/pytest/` cannot tell them apart. `# run pytest for the helpers`,
 * `keywords = ["pytest"]` and `readme = "pytest.md"` all "name" pytest to a
 * regex, yet none of them says the project runs a pytest suite — and once this
 * predicate also gates a verify command, one of those lines parks a cycle on a
 * repository that never asked for a Python gate. So the document is walked:
 * comments are removed first (a `#` inside a quoted run is data), then an entry
 * counts only where a dependency list can actually sit.
 */

/** A `#` outside a quoted run starts a comment; inside one it is data. */
function stripTomlComments(content: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < content.length; i++) {
    const c = content[i] ?? "";
    if (quote !== null) {
      out += c;
      if (c === "\\") out += content[++i] ?? "";
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      continue;
    }
    if (c === "#") {
      while (i < content.length && content[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    out += c;
  }
  return out;
}

/** The string bodies of ONE line. A TOML string is not allowed to span lines
 * here, so an unbalanced quote cannot pull the next line's values under this
 * line's key. */
function stringBodies(line: string): string[] {
  const bodies: string[] = [];
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] ?? "";
    if (quote === null) {
      if (c === '"' || c === "'") {
        quote = c;
        start = i + 1;
      }
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === quote) {
      bodies.push(line.slice(start, i));
      quote = null;
    }
  }
  return bodies;
}

/**
 * The offset of the `=` that ASSIGNs a value, or -1. `indexOf("=")` is not
 * enough: an array element `"pytest>=8",` carries one inside its string, and
 * splitting there would judge `>=8",` — the entry's tail — instead of the
 * entry. An assignment's `=` sits in code, outside every quote.
 */
function assignmentOffset(line: string): number {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] ?? "";
    if (quote !== null) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "=") return i;
  }
  return -1;
}

/** The last dotted/quoted segment of a key — the part that names the field. */
function keySegment(key: string): string {
  const parts = key
    .replace(/["']/g, "")
    .trim()
    .split(/[.\s]+/)
    .filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/** A table header line, `[table]` or `[[array.of.tables]]`. */
const TABLE_HEADER = /^[ \t]*\[{1,2}[^\]]*\]{1,2}[ \t]*$/;
/** `[[table]]` — an array of tables, whose string fields are that table's own
 * metadata even when the header names "dependenc" (`[[tool.uv.dependency-metadata]]`). */
const ARRAY_OF_TABLES_HEADER = /^[ \t]*\[\[[^\]]*\]\][ \t]*$/;
/** A key or table header declaring a dependency section: `dependencies =`,
 * `[dependency-groups]`, `[project.optional-dependencies]`,
 * `[tool.poetry.group.dev.dependencies]`. */
const DEPENDENCY_DECL =
  /^[ \t]*\[{0,2}["']?[A-Za-z0-9_. -]*dependenc[A-Za-z0-9_.-]*["']?\]{0,2}(?:[ \t]*[=:]|[ \t]*$)/;
/** A key whose own name says its contents are requirements. */
const REQUIREMENTS_SEGMENT = /^(?:optional-|dev-)?dependencies$|^(?:build-)?requires$/i;
/**
 * A PEP 508-ish dependency SPEC: name, optional extras, optional version
 * marker. A spec NEVER carries a space, which is what separates `"pytest>=8"`
 * from a prose value like `"a pytest plugin host"`.
 */
const specOf = (tool: string) =>
  new RegExp(`^${tool}(?:[A-Za-z0-9._-]*)?(?:\\[[A-Za-z0-9,_. -]+\\])?(?:[<>=!~+][^ ]*)?$`);
/** poetry/pdm pin a tool as a bare key with a quoted version value. */
const pinOf = (tool: string) =>
  new RegExp(`^[ \\t]*["']?${tool}["']?[ \\t]*=[ \\t]*["'][^"']*["'][ \\t]*$`);

/**
 * Does this manifest list `tool` as a dependency? An entry counts only where a
 * dependency list can sit: an element of a `dependencies`/`requires` array (the
 * opening line or a continuation line of it), or a bare `pytest = "^8"` pin
 * inside a dependency table. A metadata value — `keywords`, `description`,
 * `readme`, `name`, `classifiers`, an author's name — is the manifest talking
 * about itself and never counts.
 */
function manifestListsTool(pyprojectContent: string, tool: string): boolean {
  const spec = specOf(tool);
  const pin = pinOf(tool);
  let inDependencyTable = false;
  let inArrayOfTables = false;
  let arrayDepth = 0;
  for (const line of stripTomlComments(pyprojectContent).split("\n")) {
    if (TABLE_HEADER.test(line)) {
      inArrayOfTables = ARRAY_OF_TABLES_HEADER.test(line);
      inDependencyTable = DEPENDENCY_DECL.test(line) && !inArrayOfTables;
      arrayDepth = 0;
      continue;
    }
    const eq = assignmentOffset(line);
    const key = eq < 0 ? "" : line.slice(0, eq);
    const value = eq < 0 ? line : line.slice(eq + 1);
    // A dependency key of its own (`dependencies =`, `dev-dependencies =`) — but
    // only outside an array-of-tables, where the same key names that table's own
    // metadata — or any assignment while a dependency TABLE is current, which is
    // how `[dependency-groups]` + `dev = ["pytest"]` is spelled.
    const isDeclaration =
      eq >= 0 &&
      (inDependencyTable || (REQUIREMENTS_SEGMENT.test(keySegment(key)) && !inArrayOfTables));
    const opened = (value.match(/\[/g) ?? []).length;
    const closed = (value.match(/\]/g) ?? []).length;
    // `{` anywhere on the line means the strings there are inline-table FIELDS
    // (`[{ name = "pytest" }]`), not array elements, so they are not
    // dependencies of this manifest.
    if ((isDeclaration || (eq < 0 && arrayDepth > 0)) && !value.includes("{")) {
      for (const body of stringBodies(value)) if (spec.test(body.trim())) return true;
      // A poetry/pdm pin (`pytest = "^8"`): a bare key with a quoted version,
      // meaningful only outside an array.
      if (eq >= 0 && opened === 0 && arrayDepth === 0 && pin.test(line)) return true;
    }
    arrayDepth = Math.max(0, arrayDepth + opened - closed);
  }
  return false;
}

/**
 * Does this repository hold a pytest suite? True when the manifest configures
 * pytest (`[tool.pytest…]`) or lists it as a dependency, or when either of its
 * two conventional files sits at the root. `root` is where the conventional
 * filenames are looked for; the caller passes the `pyproject.toml` bytes it
 * already read rather than leaving this module to read them, because the verify
 * gate that shares the predicate reads every file asynchronously and must not
 * import a sync read.
 */
export function pyprojectNamesPytest(pyprojectContent: string, root: string): boolean {
  return (
    /^[ \t]*\[tool\.pytest/m.test(pyprojectContent) ||
    manifestListsTool(pyprojectContent, "pytest") ||
    isFile(root, "pytest.ini") ||
    isFile(root, "conftest.py")
  );
}

/**
 * Does this repository configure ruff? A `[tool.ruff…]` table (the
 * `[tool.ruff.lint]` form implies it), a `ruff` dependency entry, or either of
 * ruff's own config filenames at the root.
 */
export function pyprojectConfiguresRuff(pyprojectContent: string, root: string): boolean {
  return (
    /^[ \t]*\[tool\.ruff[.\]]/m.test(pyprojectContent) ||
    manifestListsTool(pyprojectContent, "ruff") ||
    isFile(root, "ruff.toml") ||
    isFile(root, ".ruff.toml")
  );
}

/** Is `rel` a file under `root`? Read-only, never throws. */
function isFile(root: string, rel: string): boolean {
  try {
    return statSync(path.join(root, rel)).isFile();
  } catch {
    return false;
  }
}
