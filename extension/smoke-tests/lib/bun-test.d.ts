/**
 * The two Bun globals the ledger-writer-shape / override-provenance smoke
 * tests use, declared locally so they type-check under `tsconfig.json`'s
 * `"types": ["node"]` (which is what `tsconfig.smoke-tests.json` extends).
 *
 * Why a hand-written declaration rather than `@types/bun`: the project does
 * not depend on it, and adding it project-wide would retype the ~100 smoke
 * files this project has never checked — the backlog
 * `tsconfig.smoke-tests.json` exists to ratchet down. This names exactly the
 * two symbols these files touch, so the surface stays auditable.
 *
 * Named `.d.ts` and placed in `lib/` (not `test-*.ts`) so the CI suite glob
 * never tries to execute it.
 */
declare module "bun:test" {
  /** The subset `lib/writer-shape-mock-arms.test.ts` uses: `mock.module(path,
   * factory)` replaces a module's exports for the rest of the process. The
   * factory's own return type is left loose — it is the shape the importing
   * file asserts against, not something this declaration constrains. */
  export const mock: ((modulePath: string, factory: () => unknown) => void) & {
    module: (modulePath: string, factory: () => unknown) => void;
  };
}

interface BunNamespace {
  spawnSync(
    cmd: string[],
    opts?: {
      encoding?: "utf8" | "buffer";
      env?: Record<string, string | undefined>;
      cwd?: string;
    },
  ): {
    stdout: string | Uint8Array;
    stderr: string | Uint8Array;
    exitCode: number | null;
  };
}

declare var Bun: BunNamespace;
