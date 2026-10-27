/**
 * lens-skill-inline — the parent reads a lens's SKILL.md and hands the BODY to
 * the child in its prompt (#1847).
 *
 * The old contract was: spawn the lens with `--skill <dir>` and tell it, in the
 * prompt, to open that file itself. Pi's `--skill` only ADVERTISES a skill
 * (name, description, location — the body is inlined only by the `/skill:name`
 * slash command, which nothing here calls), so every lens child had to go and
 * read the file. Measured across four PRs on v0.14.22–v0.14.25, at least one
 * lens per round announced "I'll load my assigned skill" and then spent 150–500
 * turns and 20–80 M tokens doing it, frequently through codemode or bash —
 * reads the #1827 re-read cap could not even see.
 *
 * So the parent reads the body once and puts it in the prompt. There is nothing
 * left for the child to go and fetch, which is the fix; the cap's nested-count
 * half (#1847 milestone 2) is the backstop for a child that fetches anyway.
 *
 * Two rules the body forces on us:
 *
 *   1. **The wrapper cannot be closed from inside.** Every bundled lens skill
 *      carries triple-backtick fences and backticks, so a fence- or
 *      backtick-based wrapper is escapable by the payload. The delimiter is an
 *      XML-ish tag whose name carries a per-spawn random nonce: the body would
 *      have to guess the nonce to close the tag, and a body that contains the
 *      closing tag anyway is REFUSED rather than inlined.
 *   2. **A lens with no skill never spawns.** The body is read before the spawn,
 *      so an unreadable or missing file blocks the lens with a named error —
 *      same shape as `skill not installed:` — instead of spending four attempts
 *      on an unguided reviewer.
 *
 * The frontmatter goes through `firstFrontmatterBlock` (skill-frontmatter.ts),
 * the same seam the #871 surface gate and the #873 roster read, so the accepted
 * frontmatter format has exactly one definition.
 */

import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs";
import path from "node:path";
import { SKILL_FILE_NAME } from "./lens-skill-path.ts";
import { firstFrontmatterBlock } from "./skill-frontmatter.ts";

/** What the seam may return: a decoded string, or the raw Buffer (which the
 * reader returns rather than utf8, so the size bound below is taken on the
 * bytes BEFORE any decode). */
type SkillFileReader = (file: string) => string | Buffer;

let skillFileReader: SkillFileReader | undefined;

/** Install a reader for the SKILL.md read. Returns the previous value. */
export function setSkillFileReaderForTests(
  fn: SkillFileReader | undefined,
): SkillFileReader | undefined {
  const prior = skillFileReader;
  skillFileReader = fn;
  return prior;
}

/** A body carrying this substring cannot be wrapped safely, and the refusal
 * names the shape rather than the content: the content is the untrusted payload
 * and a trace line is a transport for it. Module-private: the refusal reaches
 * the operator through `readLensSkillBody`'s error, which composes it with the
 * path, so no caller needs the bare constant. */
const UNWRAPPABLE_SKILL_BODY = "skill body contains the inline delimiter";

/** The OPENING tag's literal name, nonce excluded. A body that carries it —
 * with or without a nonce the parent can predict — is nested inside its own
 * wrapper, so the reader downstream cannot tell the skill's prose from a
 * second document that opens its own tag. Refused for the same reason as a
 * stray closing tag, and by the same rule: the shape is named, never the text. */
const OPEN_TAG_NAME = "<lens-skill-body";

/** Ceiling on the size of the SKILL.md the parent will inline (#1847).
 *
 * The body goes into the lens child's PROMPT verbatim, so an oversized
 * SKILL.md is not a slow review but a request the provider refuses, arriving
 * dozens of turns later as a provider error with nothing pointing at the file
 * that caused it. Measured, the six bundled lens skills are 3–8 KB; 256 KB is
 * ~30× the largest real one, far above anything a lens can be and far below
 * anything that would make a prompt unreadable. Refusing at the read, before
 * the spawn, is the whole point: the lens blocks with a named error instead of
 * four attempts against an impossible prompt. Charged on the BYTES READ (the
 * Buffer's length, before the utf8 decode), so the frontmatter that later gets
 * stripped counts too — a hair conservative, and the only bound that refuses an
 * oversized file without decoding it first. */
export const MAX_SKILL_BODY_BYTES = 256 * 1024;

/** The opening tag of the wrapper, nonce included. */
export function skillOpenTag(nonce: string): string {
  return `<lens-skill-body nonce="${nonce}">`;
}

/** The closing tag the body must not contain. */
export function skillCloseTag(nonce: string): string {
  return "</lens-skill-body>";
}

/**
 * Strip the leading frontmatter block, keeping the body verbatim.
 *
 * Module-private: `readLensSkillBody` is the only caller, and a test that
 * reached in here would be testing a step rather than the refusal the caller
 * owes the operator.
 *
 * `firstFrontmatterBlock` returns null when the text does not begin with a
 * `---` block (or the block is never closed), and that null means "no
 * frontmatter to strip" — NOT "unreadable". A skill without frontmatter can
 * never have been parsed into the roster, so this branch is the caller's
 * fixture rather than the real tree; the body is still delivered whole.
 */
function stripFrontmatter(text: string): string {
  const block = firstFrontmatterBlock(text);
  if (block === null) return text.trim();
  return text.slice(block.length + 6).trim();
}

/**
 * Wrap a skill body in the nonce-tagged delimiter.
 *
 * Returns null when the body carries either half of the wrapper — a closing tag
 * would let the payload end its own wrapper and continue as prompt text; an
 * OPENING tag nests a second document inside the skill, which is the same
 * confusable-prompt failure seen from the other side and the one a body could
 * otherwise grow by accident (a vendored skill that quotes the wrapper in its
 * own examples). Nonce collisions are impossible in practice (UUIDv4), so the
 * null is a wall, not a routine branch.
 */
export function wrapSkillBody(body: string, nonce: string): string | null {
  if (body.includes(skillCloseTag(nonce))) return null;
  if (body.includes(OPEN_TAG_NAME)) return null;
  return `${skillOpenTag(nonce)}\n${body}\n${skillCloseTag(nonce)}`;
}

/**
 * Read one lens's skill body and wrap it for the prompt.
 *
 * Case (e) of smoke-tests/test-lens-skill-inline-1847.ts has to make THIS read
 * fail while the roster (lens-roster.ts) keeps reading the SAME path
 * successfully, and no filesystem state separates two reads of one path — so
 * the read honours an optional reader installed by `setSkillFileReaderForTests`
 * before falling through to the real `nodeFs.readFileSync`.
 *
 * Returns `{ wrapped }` — the wrapped body, which is the only thing the caller
 * puts in the prompt — or `{ error }`, which the caller turns into a blocked
 * lens BEFORE spawning. Four refusals, each naming the file and saying
 * `(not spawned)` so an operator can tell a pre-spawn block from a failed run:
 * unreadable (with the errno — ENOENT and EACCES are different fixes), a body
 * carrying either half of the wrapper, and a file over `MAX_SKILL_BODY_BYTES`
 * (measured on the bytes read, before the utf8 decode).
 *
 * Reads the file ONCE: `runLensChild` calls this ABOVE its retry loop, so four
 * attempts reuse one read rather than re-opening (and re-decoding) the same
 * SKILL.md four times.
 */
export function readLensSkillBody(skillDir: string): { wrapped: string } | { error: string } {
  const file = path.join(skillDir, SKILL_FILE_NAME);
  let text: string;
  let bytes: number;
  try {
    // Test seam (the only one in this module): lets a test make THIS read fail
    // while leaving the roster read of the same path intact — the one
    // distinction no filesystem fixture can express, since the roster opens
    // <dir>/SKILL.md first and anything that breaks the file breaks the roster
    // before the parent ever reads it.
    const raw = skillFileReader ? skillFileReader(file) : nodeFs.readFileSync(file);
    // Bounded BEFORE the utf8 decode and before the spawn (#1847): the body
    // lands in the child's prompt, so an oversized file is a provider-side
    // failure dozens of turns in, not a slow review. The byte length of the
    // Buffer the reader returned is the check — decoding a multi-megabyte
    // SKILL.md to discover it is too large is work the refusal exists to avoid.
    // A reader that hands back a string (the test seam) has already decoded, and
    // `Buffer.byteLength` measures what the prompt would actually carry.
    bytes = Buffer.isBuffer(raw) ? raw.length : Buffer.byteLength(raw, "utf8");
    if (bytes > MAX_SKILL_BODY_BYTES) {
      return {
        error: `skill too large: ${file} (${bytes} > ${MAX_SKILL_BODY_BYTES} bytes, not spawned)`,
      };
    }
    text = Buffer.isBuffer(raw) ? raw.toString("utf8") : raw;
  } catch (err) {
    // The errno, not just the message: `skill not readable` covers a missing
    // file (ENOENT — a broken symlink, an unrun install.sh), a permission
    // problem (EACCES) and an I/O error, and an operator reading only the path
    // cannot tell "re-run install.sh" from "fix the mode". Node puts the code on
    // the error, and `unknown` means a reader that threw something else (the
    // test seam, or a future reader), which is reported as such rather than
    // invented.
    const code =
      typeof err === "object" &&
      err !== null &&
      typeof (err as { code?: unknown }).code === "string"
        ? (err as { code: string }).code
        : undefined;
    return {
      error: `skill not readable: ${file} (${code ?? "unreadable"}, not spawned)`,
    };
  }
  const body = stripFrontmatter(text);
  // The size bound lives in the try block ABOVE, on the Buffer's byte length,
  // before any decode: measuring the stripped body here would decode the whole
  // file first, which is the cost the refusal exists to avoid. The charge is the
  // file's bytes rather than the body's, so a skill whose frontmatter is large
  // is measured slightly conservatively — bounded before the spawn is the point.
  const nonce = randomUUID().replace(/-/g, "");
  const wrapped = wrapSkillBody(body, nonce);
  if (wrapped === null) {
    return { error: `${UNWRAPPABLE_SKILL_BODY}: ${file} (not spawned)` };
  }
  return { wrapped };
}
