#!/bin/zsh
# Builds, signs and publishes a release. Installed apps update from the public
# releases repo (they can't read the private source repo), so the update files go there.
# Usage: npm run release -- notes.md
set -euo pipefail
cd "${0:A:h}/.."

VERSION=$(node -p 'require("./package.json").version')
TAG="v$VERSION"
NOTES=${1:-}
SOURCE_REPO=lucassynnott/meeting-notes
RELEASES_REPO=lucassynnott/meeting-notes-releases
IDENTITY="Developer ID Application: LUCAS GARRETT NOLAN SYNOTT (9785XZK34L)"
DMG="dist/Meeting-Notes-$VERSION-arm64.dmg"
ZIP="dist/Meeting-Notes-$VERSION-arm64.zip"

if gh release view "$TAG" -R "$RELEASES_REPO" >/dev/null 2>&1; then
  echo "$TAG is already published. Bump the version in package.json first." >&2
  exit 1
fi
[[ -z "$NOTES" || -f "$NOTES" ]] || { echo "Release notes file not found: $NOTES" >&2; exit 1; }

rm -rf dist
npm test
npm run dist
codesign --force --sign "$IDENTITY" --timestamp "$DMG"
codesign --verify --deep --strict "dist/mac-arm64/Meeting Notes.app"
[[ -f dist/latest-mac.yml ]] || { echo "dist/latest-mac.yml is missing; updates would not see this release." >&2; exit 1; }
# Signing the DMG changes its bytes, so refresh its entry in the update manifest.
node - "$DMG" <<'NODE'
const fs = require("fs"), crypto = require("crypto"), path = require("path");
const dmg = process.argv[2];
const manifest = "dist/latest-mac.yml";
const bytes = fs.readFileSync(dmg);
const sha512 = crypto.createHash("sha512").update(bytes).digest("base64");
const name = path.basename(dmg).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const text = fs.readFileSync(manifest, "utf8").replace(
  new RegExp(`(- url: ${name}\\n\\s+sha512: )\\S+(\\n\\s+size: )\\d+`),
  `$1${sha512}$2${bytes.length}`,
);
fs.writeFileSync(manifest, text);
NODE
(cd dist && shasum -a 256 "${DMG:t}" "${ZIP:t}" > SHA256SUMS.txt)

ASSETS=("$DMG" "$ZIP" dist/*.blockmap dist/latest-mac.yml dist/SHA256SUMS.txt)
NOTE_ARGS=(--generate-notes)
[[ -n "$NOTES" ]] && NOTE_ARGS=(--notes-file "$NOTES")

git tag "$TAG"
git push origin main "$TAG"
gh release create "$TAG" -R "$SOURCE_REPO" --title "Meeting Notes $VERSION" "${NOTE_ARGS[@]}" "$DMG" "$ZIP" dist/SHA256SUMS.txt
RELEASE_NOTES=(--notes "Signed build of Meeting Notes $VERSION. Installed copies update to this automatically.")
[[ -n "$NOTES" ]] && RELEASE_NOTES=(--notes-file "$NOTES")
gh release create "$TAG" -R "$RELEASES_REPO" --title "Meeting Notes $VERSION" "${RELEASE_NOTES[@]}" "${ASSETS[@]}"
echo "Published $TAG. Installed apps pick it up within a few hours, or from Settings → Updates."
