const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pipeline } = require('node:stream/promises');
const { createWriteStream } = require('node:fs');
const { readPdf, convertDocument } = require('../src/windows-documents');
const { KnowledgeBase } = require('../src/knowledge');

function pdfFixture() {
  const content = 'BT /F1 12 Tf 30 150 Td (Ember customer retention playbook) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  let result = '%PDF-1.4\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(result)); result += `${index+1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(result);
  result += 'xref\n0 6\n0000000000 65535 f \n' + offsets.slice(1).map(offset => `${String(offset).padStart(10,'0')} 00000 n \n`).join('');
  return Buffer.from(result + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

test('Windows PDF and DOCX extraction feed searchable knowledge passages', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'ember-documents-'));
  try {
    const docs = path.join(root,'documents'); await fs.mkdir(docs);
    const pdf = path.join(docs,'retention.pdf'); await fs.writeFile(pdf,pdfFixture());
    const docx = path.join(docs,'renewal.docx');
    const zip = new (require('yazl').ZipFile)();
    zip.addBuffer(Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),'[Content_Types].xml');
    zip.addBuffer(Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),'_rels/.rels');
    zip.addBuffer(Buffer.from('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Renewal checklist: confirm the budget owner.</w:t></w:r></w:p></w:body></w:document>'),'word/document.xml');
    zip.end(); await pipeline(zip.outputStream,createWriteStream(docx));
    assert.match(await readPdf(pdf),/customer retention playbook/);
    assert.match(await convertDocument(docx),/confirm the budget owner/);
    const kb = new KnowledgeBase({indexPath:path.join(root,'index.json'),readPdf,convert:convertDocument});
    const status = await kb.index([docs]); assert.equal(status.files,2); assert.deepEqual(kb.data.errors,[]);
    assert.equal(kb.search('customer retention')[0].name,'retention.pdf');
    assert.equal(kb.search('renewal budget owner')[0].name,'renewal.docx');
    await assert.rejects(readPdf(docx));
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test('HTML documents preserve readable content and omit scripts and styles', async () => {
  const text = await convertDocument(path.join(__dirname,'fixtures/windows-knowledge.html'));
  assert.match(text,/Customer follow-up/i);
  assert.match(text,/Confirm timing & budget/);
  assert.match(text,/Schedule renewal/);
  assert.doesNotMatch(text,/HIDDEN_SCRIPT|HIDDEN_STYLE|<p>/);
});
