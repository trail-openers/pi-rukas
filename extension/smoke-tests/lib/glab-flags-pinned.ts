/**
 * The pinned `glab` flag sets behind `test-glab-flags.ts`, split out along the
 * data/gate seam so the gate itself stays a readable size.
 *
 * Each set lists BOTH spellings the help prints — the long form a builder emits
 * and the short form that help prints beside it — for exactly the flags the
 * `GLAB_CALLS` rows in `test-glab-flags.ts` emit. That is a requirement, not a
 * courtesy: the gate requires each set to EQUAL the flags its rows emit, so a
 * member nobody emits asserts nothing and is reported. Carrying such a member is
 * how this file once held `glab api --form`/`--placeholder`, `ci status -w/--wait`
 * and `auth status -F/--output` — flags no call ever issued — and went red on an
 * older glab that had since dropped them while the forge layer worked there
 * unaffected.
 *
 * `GLAB_MIN_VERSION` is the floor of the range the shipped flags all exist in,
 * and the one place that literal lives: `test-glab-flags.ts` reads it from here
 * and from `docs/headless.md` and requires the two to agree. Every flag the forge
 * layer emits is listed by that version's own `--help`, which the gate's live arm
 * was run against. Nothing here depends on a flag newer than 1.130.0, whose
 * `--help` is where these sets were captured.
 *
 * To reproduce the 1.89.0 live run: download that release's binary from
 * `https://gitlab.com/gitlab-org/cli/-/releases/v1.89.0` (the `Linux_x86_64` /
 * `Linux_arm64` tarball) into a scratch dir, extract it, and run the gate with
 * that binary first on `PATH` —
 * `PATH=<scratch>/bin:$PATH bun smoke-tests/test-glab-flags.ts`. The live arm
 * reports SKIP rather than a pass when no glab is on `PATH`, so a run that did not
 * have the 1.89.0 binary ahead of the host's glab did not check the floor.
 *
 * `expectedNoteBodyFile` is the same single-source discipline for the one flag
 * glab has never had: the MR note verb takes the body as `-m/--message` and has no
 * file form, so the gate asserts the emitted `--body-file` is unknown against THAT
 * pair rather than against a set that silently omits both spellings.
 */
export const GLAB_MIN_VERSION = "1.89.0";

/** The note-body defect, named once: the command the disclosure post runs, the flag
 *  it emits, and the flag that command's leaf help lists in its place. */
export const expectedNoteBodyFile = {
  key: "mr note create",
  emitted: "--body-file",
  instead: ["-m", "--message"] as const,
};

export const GLAB_FLAGS: Record<string, ReadonlySet<string>> = {
  "mr create": new Set([
    "-s",
    "--source-branch",
    "-b",
    "--target-branch",
    "-t",
    "--title",
    "-d",
    "--description",
    "--draft",
    "-y",
    "--yes",
  ]),
  "mr update": new Set(["--draft", "--ready"]),
  "mr merge": new Set(["--squash", "--auto-merge=false", "--auto-merge", "--sha"]),
  "mr view": new Set(["-F", "--output", "-w", "--web"]),
  "mr list": new Set(["-F", "--output", "-P", "--per-page", "-s", "--source-branch"]),
  "mr diff": new Set<string>(),
  "mr cancel": new Set<string>(),
  // The disclosure post's target. `glab mr note` is a PARENT command whose own
  // FLAGS block lists only `-h` and `-R` on 1.130.0 (1.89.0 adds the legacy
  // `--resolve`/`--unresolve` forms there); the verb that takes a body is the leaf
  // `mr note create`, whose help lists `-m/--message` on BOTH versions and has no
  // file form on either. The set is pinned to that leaf for that reason — see
  // `expectedNoteBodyFile`, which names the emitted `--body-file` as the defect.
  "mr note create": new Set(["-m", "--message"]),
  "issue view": new Set(["-F", "--output"]),
  "issue create": new Set(["-t", "--title", "-d", "--description", "-l", "--label"]),
  "issue list": new Set(["--search", "-A", "--all", "-O", "--output", "-P", "--per-page"]),
  "issue close": new Set<string>(),
  // The recovery hint's issue-body edit. `glab issue` has no `edit` subcommand on
  // either verified version — the verb is `issue update`, whose FLAGS block lists
  // `-d/--description` (1.89.0 and 1.130.0 alike; 1.130.0 also lists
  // `--description-file`, which no hint emits and so is not pinned here).
  "issue update": new Set(["-d", "--description"]),
  "label list": new Set(["-F", "--output", "-p", "--page", "-P", "--per-page"]),
  api: new Set(["-X", "--method", "-H", "--header", "-f", "--raw-field", "--output"]),
  "ci trace": new Set<string>(),
  "ci status": new Set(["-l", "--live"]),
  "ci view": new Set<string>(),
  "auth status": new Set<string>(),
  version: new Set<string>(),
};
