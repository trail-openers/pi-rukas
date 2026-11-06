// Must stay first: points the role prompts at a test-owned dir before src/roles.ts
// resolves them at module load (#1579, same helper as test-AC4).
import "./lib/cancel-prompts.ts";
import { rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import {
  HARNESS_TEMP_PREFIXES,
  TEMP_BYTES_REPORT_THRESHOLD,
  tempAllocatedBytes,
  tempBytesLines,
} from "../src/temp-watch.ts";
import {
  childFreeTemp,
  childWideDir,
  duBytes,
  harnessModeDir,
  makeForeignOwnedDir,
  setMode,
  writeRealBytes,
} from "./lib/temp-bytes-stub-2051.ts";

/**
 * #2051 AC3, the walk's own rules — which bytes of a temp root the measurement
 * counts, and which it refuses to count. Split from
 * `test-AC3-reviewer-temp-bytes.ts` for the §12 size cap; that file owns the
 * end-to-end path (a real dispatch, the guard window, the report line) and this
 * one owns the walk itself.
 *
 * Each rule gets its OWN root, and each total is compared against an independent
 * enumeration of that root (`du -As`, whose 1024-byte blocks are scaled against
 * this walk's 512-byte ones). A fixture that asked only for a byte number the test
 * itself chose could be satisfied by a walk that measured something else; agreeing
 * with an external enumeration is what makes "what is counted" the assertion. One
 * root per rule also keeps the failure modes apart: a shared root let two opposite
 * mistakes cancel exactly, which is how a name-only harness skip could stay green.
 */

const SELF = "test-AC3-reviewer-temp-bytes-walk.ts";
const realErrWrite = process.stderr.write.bind(process.stderr);
let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    realErrWrite(`✗ ${SELF}: ${msg}\n`);
    exit = 1;
  }
}

/**
 * The smallest leak the walk must still call a leak — one block over the 64 MB
 * report bar, which is what an always-run fixture writes when the assertion is
 * "this counts" rather than "this is large" (#2051's own subject is a temp quota
 * filled by bytes, so a fixture is not exempt from it).
 */
const LEAK_BYTES = TEMP_BYTES_REPORT_THRESHOLD + 1024 * 1024;
/**
 * A tree the walk must SKIP, or must count the moment the skip fails — and the
 * harness tree whose exclusion the root total is checked against. It carries real
 * margin over the threshold (not the minimum printable figure) because the case is
 * the skip itself: a tree that only just cleared the bar would let a walk that got
 * the boundary wrong look like one that got the skip wrong.
 */
const BULK_BYTES = TEMP_BYTES_REPORT_THRESHOLD + 1024 * 1024;
/**
 * A tree that only has to be BIG for `du` to witness it: no assertion reads a byte
 * total out of it, so it needs no threshold margin. Kept apart from
 * {@link BULK_BYTES} because the two are different claims — and because these
 * fixtures are in the always-run suite, where every MB is paid on every run.
 */
const LINK_BYTES = 4 * 1024 * 1024;
const ROLE = "code-review-specialist";

/** `mkdtemp` a root this case owns and removes at process end. */
function walkRoot(tag: string): string {
  return childFreeTemp(`walk-${tag}`);
}

/**
 * A walk that was expected to COMPLETE and total. The arms that must NOT be
 * silent have their own assertions; where a fixture is measuring which bytes are
 * IN, a `{ code }` result is a broken fixture rather than a red assertion, and
 * saying so once here keeps the narrowing out of every call site.
 */
async function walkBytes(root: string): Promise<{ bytes: number; bound: string | undefined }> {
  const m = await tempAllocatedBytes(root);
  if (!("bytes" in m))
    throw new Error(`expected a completed byte walk of ${root}, got ${JSON.stringify(m)}`);
  return m;
}

{
  // R1 / never follow a link, in BOTH directions the harness skip could be fooled.
  // A symlink's dirent is never a directory and the top-level skip matches the
  // link's NAME, so a link named after a harness tree is the case the skip cannot
  // be trusted to cover, and a plain-named link is the case where a following walk
  // simply adds the target's bytes. Measured with a nested payload too: the skip
  // is top-level only, so a directory below the root — of either kind — is measured.
  const root = walkRoot("rules");
  const outside = walkRoot("outside");
  // The target is a tree with real allocation of its OWN, entered through a link:
  // `du -s` follows the link, so an independent enumeration reports these bytes
  // while the walk must report none. Two links, so both directions the harness skip
  // could be fooled are covered: a plain-named one (a following walk would add its
  // target's bytes) and a harness-NAMED one (the case the top-level skip cannot be
  // trusted to cover, since it matches a name the child chose).
  writeRealBytes(path.join(outside, "outside-huge.bin"), LINK_BYTES);
  symlinkSync(outside, path.join(root, "childlink"));
  const harnessLink = walkRoot("harness-named"); // OUTSIDE the root, like any leak target
  setMode(harnessLink, 0o700); // the mode a real harness tree carries
  writeRealBytes(path.join(harnessLink, "tree.bin"), LINK_BYTES);
  symlinkSync(harnessLink, path.join(root, "pi-rukas-review-linked"));
  const linksOnly = await walkBytes(root);
  assert(
    linksOnly.bytes === 0 && duBytes(outside) >= LINK_BYTES && duBytes(harnessLink) >= LINK_BYTES,
    `temp-watch: the two links alone count nothing, though the trees they name really hold ${duBytes(outside) + duBytes(harnessLink)} — a walk that followed either would print that (${JSON.stringify(linksOnly)})`,
  );
  // Every harness-named entry below is built `harnessModeDir`-style: own uid and
  // mode 0700, the only shape the skip may accept. The child's own dirs come from
  // `childWideDir`, whose mode no umask can make 0700.
  const harness = harnessModeDir(path.join(root, "pi-rukas-review-abc"));
  writeRealBytes(path.join(harness, "tree.bin"), BULK_BYTES);
  // The leaks sit under NESTED directories rather than loose in the root, so the
  // totals double as the witness for recursion: a walk that queued only the root's
  // own directories finds nothing here and still agrees with every other number.
  writeRealBytes(path.join(root, "pi-rukas-child-named", "deeper", "leak.bin"), LINK_BYTES);
  writeRealBytes(path.join(root, "nested", "deeper", "child.bin"), LINK_BYTES);
  const walked = await walkBytes(root);
  assert(
    "bytes" in walked &&
      duBytes(root, "childlink", "pi-rukas-review-linked") - duBytes(harness) === walked.bytes,
    "temp-watch: and that total is what an independent enumeration of the same tree reports (walk minus the one harness tree)",
  );
  assert(
    tempBytesLines(
      ROLE,
      { bytes: 0, bound: undefined },
      { bytes: TEMP_BYTES_REPORT_THRESHOLD + 512, bound: undefined },
    )[0] === `temp-bytes: ${TEMP_BYTES_REPORT_THRESHOLD + 512} (allocated) during the ${ROLE} run`,
    "temp-watch: a completed walk prints the line with no partial-walk tail",
  );
}

{
  // R1, one conjunct per root. The skip needs the harness prefix AND our uid AND
  // mode 0700; a child can hand itself the prefix by typing it and the wide mode by
  // leaving the umask alone, so each conjunct is measured on a root of its own
  // against `du`, where dropping it changes the total instead of cancelling another
  // fixture. A foreign-uid entry is asserted only when this process can actually
  // create one (it cannot without privilege, and a fixture that pretended would
  // pin nothing).
  const root = walkRoot("skip");
  const wide = childWideDir(path.join(root, "pi-rukas-child-probe"));
  writeRealBytes(path.join(wide, "leak.bin"), LEAK_BYTES);
  const measuredWide = await tempAllocatedBytes(root);
  assert(
    "bytes" in measuredWide &&
      measuredWide.bytes === LEAK_BYTES &&
      measuredWide.bytes === duBytes(root),
    `temp-watch: a harness-PREFIXED dir at the mode a child's own mkdir gets is a leak, not a harness tree, and matches du (${JSON.stringify([measuredWide, duBytes(root)])})`,
  );
  const ours = harnessModeDir(path.join(root, "pi-rukas-spawn-slots-1006"));
  writeRealBytes(path.join(ours, "tree.bin"), BULK_BYTES);
  const skipped = await tempAllocatedBytes(root);
  assert(
    "bytes" in skipped &&
      skipped.bytes === LEAK_BYTES &&
      duBytes(root) - duBytes(ours) === skipped.bytes,
    `temp-watch: our own uid + mode 0700 is the ONLY thing a harness name buys — du says the root holds ${BULK_BYTES / LINK_BYTES}x the link tree and the walk excludes exactly that one tree (${JSON.stringify([skipped, duBytes(root)])})`,
  );
  setMode(ours, 0o755); // same name, same owner, one bit wider
  const widened = await tempAllocatedBytes(root);
  assert(
    "bytes" in widened && widened.bytes === LEAK_BYTES + BULK_BYTES,
    `temp-watch: and the moment that tree is not 0700 the whole harness tree is counted — the mode is not decoration (${JSON.stringify(widened)})`,
  );
  // A harness-prefixed tree the PARENT does not own, carrying bytes: the conjunct
  // under test is the OWNER, not the size, so no assertion reads a byte total out of
  // the tree itself (the expected sum below is the root's other entries). A few MB
  // witness it as well as a hundred would — and this host cannot even make one.
  const foreign = await makeForeignOwnedDir(path.join(root, "pi-rukas-canary-other"), LINK_BYTES);
  if (foreign !== undefined) {
    const withForeign = await tempAllocatedBytes(root);
    assert(
      "bytes" in withForeign && withForeign.bytes === 2 * LEAK_BYTES + BULK_BYTES,
      `temp-watch: a harness-prefixed 0700 dir the parent does not own is measured, not skipped (${JSON.stringify(withForeign)})`,
    );
    rmSync(foreign, { recursive: true, force: true });
  } else {
    console.log(
      "– foreign-uid skip case skipped: this process cannot create another uid's directory",
    );
  }
}

console.log(`\nexit ${exit}`);

process.exit(exit);
