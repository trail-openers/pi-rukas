/**
 * lean/version — the extension version stamped on every run record.
 *
 * Its own leaf because the two readers of it sit on opposite sides of a cycle
 * that has no business existing: the seed (`lean/seed.ts`) is a run-start fact
 * read before the record exists, while `lean/command.ts` is the per-step handler
 * table — eleven handlers, a forge adapter and a spawn seam. When the version
 * lived in the command module, the seed had to import the command to stamp a
 * run, and the command imports the seed to start one: a genuine module cycle
 * whose only content was a `package.json` read. Neither side needs the other for
 * it, so neither keeps it.
 *
 * Never throws: a state file is written on every step, and an unreadable
 * manifest is no reason to lose a run. `"unknown"` says the stamp is missing,
 * which is what a reader years later needs to know.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The extension version, stamped on every run so a state file reads years later. */
export function leanVersion(): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(HERE, "..", "..", "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}
