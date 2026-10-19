/**
 * worktree-dep-contract — the dependency-tree names shared by the two sides of
 * the /work worktree (#1655).
 *
 * worktree-provision.ts (driver side, outside the worktree) symlinks these
 * gitignored trees from the main checkout into each worktree. write-fence-path.ts
 * (child side, inside the worktree) recognises those same links as provisioned.
 * Both import the names from here so the two sides cannot drift apart.
 */

/** Gitignored trees shared from the main checkout at the root or one package directory down. */
export const SHAREABLE_DEPS = ["node_modules", ".venv", "vendor"] as const;

/** The dependency tree a package directory carries for itself (`extension/node_modules`). */
export const NESTED_DEP = "node_modules";
