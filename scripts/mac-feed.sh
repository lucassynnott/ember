#!/bin/zsh
# Puts a Mac release's update manifest (latest-mac.yml, with full download links to that release) where Macs look.
# Usage: zsh scripts/mac-feed.sh v1.11.5            updates the "mac-latest" feed that Ember 1.11.5+ reads
#        zsh scripts/mac-feed.sh v1.11.5 <tag>      also attaches it to another release, such as a Windows one, so
#                                                  Macs on 1.11.4 or earlier (which read whichever release is
#                                                  marked Latest) keep updating when that release is Latest.
set -euo pipefail
REPO=lucassynnott/ember
MAC_TAG=$1
ALSO=${2:-}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
gh release download "$MAC_TAG" -R "$REPO" -p latest-mac.yml -D "$WORK"
BASE="https://github.com/$REPO/releases/download/$MAC_TAG/"
# Relative file names become full links, so the manifest works from any release.
sed -E "s#^(  - url: |path: )([^h][^ ]*)#\1$BASE\2#" "$WORK/latest-mac.yml" > "$WORK/feed.yml"
mv "$WORK/feed.yml" "$WORK/latest-mac.yml"
grep -q "$BASE" "$WORK/latest-mac.yml" || { echo "Couldn't rewrite latest-mac.yml" >&2; exit 1; }
if ! gh release view mac-latest -R "$REPO" >/dev/null 2>&1; then
  gh release create mac-latest -R "$REPO" --prerelease --latest=false --target mac --title "Ember for Mac: update feed" \
    --notes "Where Ember for Mac checks for updates. It points at the newest Mac release; download Ember from that release, not here."
fi
gh release upload mac-latest "$WORK/latest-mac.yml" -R "$REPO" --clobber
[[ -n "$ALSO" ]] && gh release upload "$ALSO" "$WORK/latest-mac.yml" -R "$REPO" --clobber
echo "Mac update feed now points at $MAC_TAG${ALSO:+ (also attached to $ALSO)}"
