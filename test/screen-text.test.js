const test = require("node:test");
const assert = require("node:assert/strict");
const { captureResult, joinLines } = require("../src/screen-text");

const line = (text, y, { x = 60, w = 960, h = 52 } = {}) => ({ text, x, y, w, h });

test("joins wrapped lines into paragraphs and keeps real breaks", () => {
  const lines = [
    line("Q3 pricing review with Priya Shah and Sam Okafor.", 52, { w: 968 }),
    line("The new Team tier starts at 49 per seat and the", 115, { w: 898 }),
    line("annual discount moves to 15 percent from October.", 173, { w: 976 }),
    line("Next step: Dana sends the updated deck by Friday.", 307, { w: 967 }),
  ];
  assert.equal(
    joinLines(lines),
    "Q3 pricing review with Priya Shah and Sam Okafor. The new Team tier starts at 49 per seat and the annual discount moves to 15 percent from October.\n\nNext step: Dana sends the updated deck by Friday.",
  );
  assert.equal(joinLines(lines, { keepLineBreaks: true }).split("\n").length, 4);
});

test("keeps list items, short closing lines and hyphenated words right", () => {
  assert.equal(joinLines([line("Agenda:", 0, { w: 200 }), line("• Pricing", 60, { w: 300 }), line("• Hiring", 120, { w: 300 })]), "Agenda:\n• Pricing\n• Hiring");
  assert.equal(joinLines([line("The onboard-", 0), line("ing flow is done.", 58)]), "The onboarding flow is done.");
  assert.equal(joinLines([line("This one is a long line of text that wraps", 0), line("and ends here.", 58, { w: 300 }), line("A new paragraph.", 116)]), "This one is a long line of text that wraps and ends here.\nA new paragraph.");
});

test("a QR code's link wins over the text around it", () => {
  assert.deepEqual(captureResult({ lines: [line("Scan to book", 0)], codes: [{ kind: "qr", payload: "https://example.com/pricing" }] }).text, "https://example.com/pricing");
  assert.equal(captureResult({ lines: [], codes: [{ kind: "qr", payload: "https://example.com" }] }).kind, "link");
  assert.equal(captureResult({ lines: [line("https://example.com/a", 0)], codes: [] }).kind, "link");
  assert.equal(captureResult({ lines: [], codes: [] }), null);
  assert.equal(captureResult({ lines: [], codes: [{ kind: "barcode", payload: "5012345678900" }] }).kind, "barcode");
});

test('injected area capture reads the saved image through offline OCR and removes it', async () => {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const os = require('node:os');
  const { ScreenText } = require('../src/screen-text');
  const { WindowsOcr } = require('../src/windows-ocr');
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(),'ember-grab-pipeline-'));
  const ocr = new WindowsOcr();
  let captured;
  const reader = new ScreenText({tempDir,capture:async file=>{captured=file;await fs.copyFile(path.join(__dirname,'fixtures/windows-ocr.png'),file);},read:args=>ocr.read(args[1])});
  try {
    const result = await reader.capture({keepLineBreaks:true});
    assert.match(result.result.text,/Ember Windows screen text/);
    assert.match(result.result.text,/Private image reading/);
    assert.equal(result.lines,2);
    assert.equal(reader.busy,false);
    await assert.rejects(fs.stat(captured),{code:'ENOENT'});
  } finally {await ocr.close();await fs.rm(tempDir,{recursive:true,force:true});}
});

test('cancelled and failed native area captures leave no image and release the busy state', async () => {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const os = require('node:os');
  const { ScreenText } = require('../src/screen-text');
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(),'ember-grab-cancel-'));
  let fail=false;
  const reader=new ScreenText({tempDir,capture:async()=>{if(fail)throw new Error('Windows capture failed');},read:()=>{throw new Error('Cancelled capture must not run OCR');}});
  try {
    assert.equal(await reader.capture(),null);
    assert.equal(reader.busy,false);
    fail=true;
    await assert.rejects(reader.capture(),/Windows capture failed/);
    assert.equal(reader.busy,false);
    assert.deepEqual(await fs.readdir(tempDir),[]);
  } finally {await fs.rm(tempDir,{recursive:true,force:true});}
});
