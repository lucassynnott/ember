const TEXT = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';
const OFFICE = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0';
const LIMIT = 30 * 1024 * 1024;

function contentXml(file) {
  return new Promise((resolve, reject) => {
    require('yauzl').open(file, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true; zip.close();
        if (error) reject(error); else resolve(value);
      };
      zip.once('error', error => finish(error));
      zip.once('end', () => finish(new Error('ODT document has no content.xml.')));
      zip.on('entry', entry => {
        if (entry.fileName !== 'content.xml') return zip.readEntry();
        if (entry.uncompressedSize > LIMIT) return finish(new Error('ODT document exceeds the text size limit.'));
        zip.openReadStream(entry, (error, stream) => {
          if (error) return finish(error);
          const chunks = []; let size = 0;
          stream.on('data', bytes => {
            size += bytes.length;
            if (size > LIMIT) { stream.destroy(); finish(new Error('ODT document exceeds the text size limit.')); }
            else chunks.push(bytes);
          });
          stream.once('error', error => finish(error));
          stream.once('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));
        });
      });
      zip.readEntry();
    });
  });
}

async function readOdt(file) {
  const xml = await contentXml(file);
  const parser = require('sax').parser(true, { xmlns: true });
  const parts = []; const stack = [];
  let inBody = false, skipped = 0, size = 0;
  const append = text => {
    size += text.length;
    if (size > LIMIT) throw new Error('ODT document exceeds the text size limit.');
    parts.push(text);
  };
  parser.ondoctype = () => { throw new Error('ODT document declarations are unsupported.'); };
  parser.onopentag = node => {
    if (stack.length >= 256) throw new Error('ODT document nesting exceeds the limit.');
    const skip = (node.uri === OFFICE && ['annotation','scripts'].includes(node.local)) || (node.uri === TEXT && ['tracked-changes','script'].includes(node.local));
    stack.push({node,skip}); if (skip) skipped++;
    if (node.uri === OFFICE && node.local === 'text') inBody = true;
    if (!inBody || skipped || node.uri !== TEXT) return;
    if (node.local === 's') {
      const count = Object.values(node.attributes).find(a => a.uri === TEXT && a.local === 'c')?.value || '1';
      if (!/^\d+$/.test(count) || Number(count) > LIMIT) throw new Error('Invalid ODT space count.');
      append(' '.repeat(Number(count)));
    } else if (node.local === 'tab') append('\t');
    else if (node.local === 'line-break') append('\n');
  };
  parser.ontext = text => { if (inBody && !skipped) append(text); };
  parser.oncdata = parser.ontext;
  parser.onclosetag = () => {
    const {node,skip} = stack.pop();
    if (inBody && !skipped && node.uri === TEXT && ['p','h'].includes(node.local)) append('\n');
    if (node.uri === OFFICE && node.local === 'text') inBody = false;
    if (skip) skipped--;
  };
  parser.write(xml).close();
  return parts.join('').trim();
}
module.exports = { readOdt };
