/**
 * skill-frontmatter — the single first-frontmatter-block reader for
 * SKILL.md files (epic #867).
 *
 * Pi's skill loader treats the FIRST `---`-delimited block at the top of
 * SKILL.md as frontmatter and ignores `---` blocks in the body (e.g.
 * skill/devops-infrastructure/SKILL.md has an in-body `name: CI/CD` inside
 * a code block — a whole-file `/^name:/` scan is wrong by construction).
 * Every consumer that reads SKILL.md metadata — the #871 skill-name surface
 * gate and the #873 runtime lens roster — reads through these two helpers
 * so the accepted format has exactly one definition.
 *
 * CRLF-tolerant (an installed dir may hold CRLF-authored SKILL.md files).
 * Only the first block is read. Value style: unquoted or quoted
 * (`name: x`, `name: "x"`, `name: 'x'`); YAML comments are not supported
 * and not gated.
 */

/**
 * The first `---`-delimited frontmatter block, or null when the text does
 * not begin with one (or the block is never closed).
 */
export function firstFrontmatterBlock(text: string): string | null {
  if (!/^---[ \t]*\r?$/.test(text.split(/\r?\n/)[0] ?? "")) return null;
  const rest = text.slice(3);
  const end = rest.search(/^---[ \t]*\r?$/m);
  if (end === -1) return null;
  return rest.slice(0, end);
}

/**
 * A single top-level `key:` value from the first frontmatter block only,
 * or null when the key is absent. Surrounding single/double quotes are
 * stripped; a trailing CR is tolerated.
 */
export function frontmatterField(text: string, key: string): string | null {
  const block = firstFrontmatterBlock(text);
  if (block === null) return null;
  const m = block.match(new RegExp(`^${key}:[ \\t]*(.+?)[ \\t]*\\r?$`, "m"));
  if (!m || m[1] === undefined) return null;
  return m[1].replace(/^["']|["']$/g, "");
}

/** `name:` value from the first frontmatter block only (null when absent). */
export function frontmatterName(text: string): string | null {
  return frontmatterField(text, "name");
}
