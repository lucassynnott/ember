const path = require('node:path');
const assert = require('node:assert/strict');
const { readPdf, convertDocument } = require('../src/windows-documents');
(async () => {
  const fixture = extension => path.join(__dirname, `../test/fixtures/windows-knowledge.${extension}`);
  assert.match(await readPdf(fixture('pdf')), /customer retention playbook/);
  assert.match(await convertDocument(fixture('doc')), /Confirm timing & budget/);
  assert.match(await convertDocument(fixture('docx')), /confirm the budget owner/);
  assert.match(await convertDocument(fixture('odt')), /Café renewal/);
  const html = await convertDocument(fixture('html'));
  assert.match(html, /Confirm timing & budget/);
  assert.doesNotMatch(html, /HIDDEN_SCRIPT|HIDDEN_STYLE/);
  assert.match(await convertDocument(fixture('rtf'), { nativeHelper: path.resolve('native/windows/bin/meeting-notes-hotkey.exe') }), /Café budget owner/);
  console.log(JSON.stringify({ windowsDocuments: 'passed', pdf: true, docx: true, legacyDoc: true, odt: true, html: true, rtfUnicode: true }));
})().catch(error => { console.error(error); process.exitCode = 1; });
