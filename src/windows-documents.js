const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { pathToFileURL } = require('node:url');

async function readPdf(file) {
  // ESM workers need physical paths when shipped inside Electron's ASAR.
  const modulePath = require.resolve('pdfjs-dist/legacy/build/pdf.mjs').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  const pdf = await import(pathToFileURL(modulePath).href);
  const task = pdf.getDocument({ data: new Uint8Array(await fs.readFile(file)), isEvalSupported: false, useSystemFonts: false, standardFontDataUrl: path.resolve(path.dirname(modulePath), "../../standard_fonts").replaceAll("\\", "/") + "/" });
  try {
    const document = await task.promise;
    const pages = [];
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      pages.push(content.items.map(item => typeof item.str === 'string' ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim());
      page.cleanup();
    }
    return pages.join('\n\n');
  } finally {
    await task.destroy();
  }
}

async function convertDocument(file, { nativeHelper } = {}) {
  const extension = path.extname(file).toLowerCase();
  if (extension === ".odt") return require("./windows-odt").readOdt(file);
  if (extension === ".html" || extension === ".htm") {
    return require("html-to-text").convert(await fs.readFile(file, "utf8"), { wordwrap: false, limits: { maxInputLength: 30 * 1024 * 1024 }, selectors: [{ selector: "script", format: "skip" }, { selector: "style", format: "skip" }, { selector: "img", format: "skip" }] });
  }
  if (extension === ".rtf") {
    if (!nativeHelper) throw new Error("The Windows RTF reader is unavailable.");
    const { stdout } = await execFile(nativeHelper, ["extract-rtf", "--file", file], { encoding: "utf8", timeout: 30000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    return stdout;
  }
  if (path.extname(file).toLowerCase() === '.docx') {
    const result = await require('mammoth').extractRawText({ path: file }, { externalFileAccess: false });
    return result.value;
  }
  throw new Error(`Windows document reading does not yet support ${path.extname(file)}. Save this document as DOCX, PDF or plain text.`);
}
module.exports = { readPdf, convertDocument };
