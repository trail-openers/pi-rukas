/**
 * The golden recorder's entry point. Run it through `generate-golden.sh`, never by hand.
 *
 * The import below names this checkout's own renderer, and `main()` refuses any run from inside
 * the repository for exactly that reason. The wrapper copies this file to a temp mirror and
 * rewrites this one line to the `fenceText` of the module it extracted from the release tag and
 * hashed against `BASE_SHA256`, so the recorded bytes can only come from that file — never from a
 * shim somebody could leave in the tree. The second argument is the directory this run records
 * from, which is what `main()` refuses to run from inside a work tree — the recorder states where it
 * is, so the guard is about the run and not about a path constant. `golden-corpus.ts` beside this
 * file holds the corpus and
 * the provenance constants; nothing in the tracked tree records a byte.
 */
import { fenceText } from "../../../src/lean/text-fence.ts";
import { main } from "./golden-corpus.ts";

main(fenceText, import.meta.dirname);
