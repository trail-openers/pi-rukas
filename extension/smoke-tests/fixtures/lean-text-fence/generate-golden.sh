#!/usr/bin/env bash
# Regenerate the fenceText golden from the release tag.
#
# Extracts v0.14.71's own `extension/src/lean/text-fence.ts` into a temp dir laid out as a
# mirror of the paths the recorder spells, and runs the recorder there, so the renderer whose
# bytes land in the committed JSON are the release's own. Nothing is written into this directory
# but the JSON: the extraction and the recorder both live in the temp mirror, and this script
# rewrites the recorder's single `import` to name the file it just extracted and hashed. So the
# renderer is not a name somebody could park beside the generator — the path the recorded bytes
# came from is a path this script wrote in this run and verified by digest, and a stale or
# hand-written copy anywhere in the tree is simply never read.
#
# Everything else the recorder reaches is a symlink, so nothing here is a second copy that could
# go stale — except the three files a symlink cannot express: the corpus module and the recorder
# (a symlink resolves to its real path, so bun would resolve their imports beside the real file),
# and the JSON it writes (which must land in the tree, so the recorder writes into a mirror of
# this directory instead of through a link).
#
# Run from anywhere:
#   bash extension/smoke-tests/fixtures/lean-text-fence/generate-golden.sh
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# This file lives four levels under the repo root: extension/smoke-tests/fixtures/<name>.
repo=$(CDPATH= cd -- "$here/../../../.." && pwd)

# The provenance constants live in golden-corpus.ts, the file the offline test also imports.
corpus="$here/golden-corpus.ts"
tag=$(sed -n 's/^export const BASE_TAG = "\(.*\)";$/\1/p' "$corpus")
base_file=$(sed -n 's/^export const BASE_FILE = "\(.*\)";$/\1/p' "$corpus")
base_commit=$(sed -n 's/^export const BASE_COMMIT = "\(.*\)";$/\1/p' "$corpus")
base_sha256=$(sed -n 's/^export const BASE_SHA256 = "\(.*\)";$/\1/p' "$corpus")

if [ -z "$tag" ] || [ -z "$base_file" ] || [ -z "$base_commit" ] || [ -z "$base_sha256" ]; then
  echo "generate-golden.sh: could not read BASE_TAG/BASE_FILE/BASE_COMMIT/BASE_SHA256 from golden-corpus.ts" >&2
  exit 1
fi

# Refuse to record over a tag whose bytes are not the stamped ones. Without these two checks the
# stamp in the JSON is decoration: `git show` follows a moved tag as happily as a stable one, and
# the fixture would go on claiming v0.14.71 while carrying somebody else's renderer.
tag_commit=$(git -C "$repo" rev-parse --verify "$tag^{commit}")
case "$tag_commit" in
  "$base_commit"*) ;;
  *)
    echo "generate-golden.sh: $tag resolves to $tag_commit, not the stamped $base_commit" >&2
    exit 1
    ;;
esac

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mirror="$tmp/extension/smoke-tests/fixtures/lean-text-fence"
mkdir -p "$mirror"

git -C "$repo" show "$tag:extension/src/lean/text-fence.ts" >"$mirror/$base_file"
extracted=$(sha256sum "$mirror/$base_file")
if [ "${extracted%% *}" != "$base_sha256" ]; then
  echo "generate-golden.sh: $tag's text-fence.ts hashes to ${extracted%% *}, not the stamped $base_sha256" >&2
  exit 1
fi

cp "$corpus" "$mirror/golden-corpus.ts"
# Point the recorder's one import at the digest-verified extraction. Rewriting that line, rather
# than importing a shim from the tree, is what makes the source of the bytes a fact about this run.
sed "s#^import { fenceText } from \".*\";\$#import { fenceText } from \"./$base_file\";#" \
  "$here/generate-golden.ts" >"$mirror/generate-golden.ts"
if ! grep -q "from \"\./$base_file\";" "$mirror/generate-golden.ts"; then
  echo "generate-golden.sh: could not point the recorder at $base_file" >&2
  exit 1
fi
ln -s "$repo/extension/src" "$tmp/extension/src"
ln -s "$repo/extension/node_modules" "$tmp/extension/node_modules"

bun "$mirror/generate-golden.ts"
mv "$mirror/fenceText-v0.14.71.json" "$here/fenceText-v0.14.71.json"
echo "generate-golden.sh: wrote $here/fenceText-v0.14.71.json"
