const assert = require("node:assert/strict");
const { app, nativeImage } = require("electron");
const { createTrayImage } = require("../src/tray-icon");

app.whenReady().then(() => {
  const image = createTrayImage(nativeImage);
  assert.equal(image.isEmpty(), false);
  assert.deepEqual(image.getSize(), { width: 22, height: 22 });
  console.log("TRAY_ICON_OK");
  app.quit();
});
