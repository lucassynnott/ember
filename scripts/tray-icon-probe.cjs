const assert = require("node:assert/strict");
const fs = require("node:fs");
const { app, nativeImage } = require("electron");
const { idleTrayImage, recordingTrayFrames } = require("../src/tray-icon");

app.whenReady().then(() => {
  const idle = idleTrayImage(nativeImage);
  assert.equal(idle.isEmpty(), false);
  assert.equal(idle.isTemplateImage(), true);
  assert.deepEqual(idle.getSize(), { width: 20, height: 22 });
  const frames = recordingTrayFrames(nativeImage, { dark: true });
  assert.equal(frames.length, 12);
  assert.deepEqual(frames[0].getSize(), { width: 34, height: 22 });
  // Optional: write previews for a visual check.
  const out = process.argv[2];
  if (out) {
    fs.writeFileSync(`${out}/tray-idle.png`, idle.toPNG({ scaleFactor: 2 }));
    for (const [name, dark] of [["dark", true], ["light", false]]) {
      const set = recordingTrayFrames(nativeImage, { dark });
      fs.writeFileSync(`${out}/tray-rec-${name}-0.png`, set[0].toPNG({ scaleFactor: 2 }));
      fs.writeFileSync(`${out}/tray-rec-${name}-6.png`, set[6].toPNG({ scaleFactor: 2 }));
    }
  }
  console.log("TRAY_ICON_OK");
  app.quit();
});
