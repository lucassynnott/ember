function createTrayImage(nativeImage) {
  const scaleFactor = 2;
  const logicalSize = 22;
  const width = logicalSize * scaleFactor;
  const height = logicalSize * scaleFactor;
  const pixels = Buffer.alloc(width * height * 4);

  const setLogicalPixel = (logicalX, logicalY) => {
    for (let yOffset = 0; yOffset < scaleFactor; yOffset += 1) {
      for (let xOffset = 0; xOffset < scaleFactor; xOffset += 1) {
        const x = logicalX * scaleFactor + xOffset;
        const y = logicalY * scaleFactor + yOffset;
        const offset = (y * width + x) * 4;
        pixels[offset] = 0;
        pixels[offset + 1] = 0;
        pixels[offset + 2] = 0;
        pixels[offset + 3] = 255;
      }
    }
  };

  for (let y = 3; y <= 12; y += 1) {
    const left = y === 3 || y === 12 ? 9 : 8;
    const right = y === 3 || y === 12 ? 12 : 13;
    for (let x = left; x <= right; x += 1) setLogicalPixel(x, y);
  }

  for (let y = 9; y <= 13; y += 1) {
    setLogicalPixel(5, y);
    setLogicalPixel(6, y);
    setLogicalPixel(15, y);
    setLogicalPixel(16, y);
  }
  for (let x = 6; x <= 15; x += 1) setLogicalPixel(x, 14);
  for (let x = 8; x <= 13; x += 1) setLogicalPixel(x, 15);
  for (let y = 15; y <= 18; y += 1) {
    setLogicalPixel(10, y);
    setLogicalPixel(11, y);
  }
  for (let x = 7; x <= 14; x += 1) setLogicalPixel(x, 19);

  const image = nativeImage.createFromBitmap(pixels, { width, height, scaleFactor });
  image.setTemplateImage(true);
  return image;
}

module.exports = { createTrayImage };
