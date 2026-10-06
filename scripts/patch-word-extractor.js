// https://github.com/morungos/node-word-extractor/issues/70
// word-extractor #70: character spacing must not be mistaken for tracked deletion.
// Keep this patch reproducible on npm ci and fail if the pinned source changes.
const fs = require('node:fs');
const path = require('node:path');
const entry = require.resolve('word-extractor');
const packageFile = path.resolve(path.dirname(entry),'../package.json');
if(JSON.parse(fs.readFileSync(packageFile,'utf8')).version !== '1.0.4') throw new Error('Review the Word extraction patch before changing dependency versions.');
const file = path.join(path.dirname(entry),'word-ole-extractor.js');
let source = fs.readFileSync(file,'utf8');
for(const [before,after] of [
  ['const sprmCFRMarkDel = 0x00;', 'const sprmCFRMarkDel = 0x0800;'],
  ['if (ispmd === sprmCFRMarkDel) {', 'if (sprm === sprmCFRMarkDel) {'],
]) {
  if(source.includes(after) && !source.includes(before)) continue;
  if(source.split(before).length !== 2) throw new Error('The Word extraction patch does not match its pinned source.');
  source = source.replace(before,after);
}
fs.writeFileSync(file,source);
