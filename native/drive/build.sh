#!/bin/zsh
# Builds Ember Drive (the helper app with its FSKit extension), signed with Developer ID, into native/drive/build/export.
set -e
setopt null_glob
cd "${0:A:h}"
xcodegen generate >/dev/null
rm -rf build/EmberDrive.xcarchive build/export
OUT=$(xcodebuild -project EmberDrive.xcodeproj -scheme EmberDrive -configuration Release -derivedDataPath build -archivePath build/EmberDrive.xcarchive -allowProvisioningUpdates archive 2>&1) || true
echo "$OUT" | grep -E "error:" | sort -u
echo "$OUT" | grep -q "ARCHIVE SUCCEEDED" || { echo "Ember Drive: archive failed"; exit 1; }
xcodebuild -exportArchive -archivePath build/EmberDrive.xcarchive -exportPath build/export -exportOptionsPlist ExportOptions.plist -allowProvisioningUpdates >/dev/null 2>&1 || { echo "Ember Drive: export failed"; exit 1; }
# The export drops entitlements no provisioning profile covers, which includes the helper's (team-prefixed) app group.
# Those need no profile on macOS, so the helper app alone is signed again with them; its extension keeps its own
# signature and FSKit profile.
IDENTITY=$(security find-identity -v -p codesigning | grep "Developer ID Application" | grep "(9785XZK34L)" | head -1 | awk '{print $2}')
codesign --force --sign "$IDENTITY" --options runtime --timestamp --entitlements Agent/Agent.entitlements "build/export/Ember Drive.app"
codesign --verify --deep --strict "build/export/Ember Drive.app"
# Xcode's own copies (the archive, the build products) would register as more Ember Drives and confuse FSKit.
# They're dropped from Launch Services and deleted; removing them from pluginkit would switch Ember Drive off in FSKit.
LSR=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
for stray in build/EmberDrive.xcarchive/Products/Applications/"Ember Drive.app" build/Build/Products/*/"Ember Drive.app" build/Build/Intermediates.noindex/ArchiveIntermediates/EmberDrive/InstallationBuildProductsLocation/Applications/"Ember Drive.app"; do
  [ -d "$stray" ] || continue
  $LSR -u "$stray" 2>/dev/null || true
done
rm -rf build/EmberDrive.xcarchive build/Build/Products build/Build/Intermediates.noindex/ArchiveIntermediates
echo "Ember Drive built"
