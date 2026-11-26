/**
 * work-driver-verify-repo-paths — #2649: the ONE whitelist of repository paths a
 * smoke test may name, shared by the two questions that must never disagree.
 *
 * The always-run detector asks "does this test name a repository path?" (a test
 * that does reads repository text, so it runs on every develop round). The
 * changed-path classifier asks "does this test name THIS repository file?"
 * (`work-driver-verify-classify.ts`). Both questions are answered by the same
 * spelling rules, so a path one of them accepts cannot be refused by the other —
 * and a reader the detector would count is never invisible to the mapping that
 * decides whether a docs change needs the full suite.
 *
 * The set is a whitelist on purpose: a literal that names nothing in it is not a
 * repository path, so an unrelated `docs/` in a temp fixture cannot make a test a
 * reader.
 *
 * Paths are relative to `extension/`, as in every other selector module — the
 * directories are the repo's, named from the worktree the tests run in.
 */

/** Repository directories a reader may name, as a leading path segment. */
const REPO_DIRS = [
  "src",
  "smoke-tests/lib",
  ".pi",
  "modules",
  "manifests",
  "agents-base",
  "pi-prompts",
  "skill",
  "docs",
  "bin",
  "dist",
  ".github",
  ".devcontainer",
];
/** Repository files a reader may name. `tsconfig*.json` is matched separately. */
const REPO_FILES = [
  "agents.json",
  "package.json",
  "bunfig.toml",
  "release-please-config.json",
  "Dockerfile",
  "install.sh",
  "build.sh",
  "AGENTS.md",
  "README.md",
  "CONTRIBUTING.md",
  "CHANGELOG.md",
];
/** A leading interpolation or relative prefix that does not change which repository path a literal names. */
const LEADING_RE = /^(?:\$\{[^}]*\}\/|\.{1,2}\/|extension\/)*/;
/** `tsconfig.json`, `tsconfig.smoke-tests.json`, … — the projects the develop command typechecks. */
const TSCONFIG_RE = /^tsconfig[\w.-]*\.json$/;

/** The nameable repository directories, as a leading segment. */
export const repoDirs = (): readonly string[] => REPO_DIRS;
/** The nameable repository files, by exact path. */
export const repoFiles = (): readonly string[] => REPO_FILES;

/** Does this literal name a repository path (a nameable file, or under a nameable directory)? */
export function isRepoPath(value: string): boolean {
  const rest = value.replace(LEADING_RE, "");
  if (REPO_FILES.includes(rest) || TSCONFIG_RE.test(rest)) return true;
  return REPO_DIRS.some((d) => rest === d || rest.startsWith(`${d}/`));
}
