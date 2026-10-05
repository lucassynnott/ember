#!/bin/zsh
# Builds, signs and publishes a release to GitHub, where installed apps look for updates.
# Usage: npm run release -- notes.md
set -euo pipefail
cd "${0:A:h}/.."

VERSION=$(node -p 'require("./package.json").version')
TAG="v$VERSION"
NOTES=${1:-}
REPO=lucassynnott/ember
IDENTITY="Developer ID Application: LUCAS GARRETT NOLAN SYNOTT (9785XZK34L)"
DMG="dist/Ember-$VERSION-arm64.dmg"
ZIP="dist/Ember-$VERSION-arm64.zip"

if gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then
  echo "$TAG is already published. Bump the version in package.json first." >&2
  exit 1
fi
[[ -z "$NOTES" || -f "$NOTES" ]] || { echo "Release notes file not found: $NOTES" >&2; exit 1; }

rm -rf dist
npm test
npm run dist
codesign --force --sign "$IDENTITY" --timestamp "$DMG"
codesign --verify --deep --strict "dist/mac-arm64/Ember.app"
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
gh release create "$TAG" -R "$REPO" --title "Ember $VERSION" "${NOTE_ARGS[@]}" "${ASSETS[@]}"
echo "Published $TAG. Installed apps pick it up within a few hours, or from Settings → Updates."
