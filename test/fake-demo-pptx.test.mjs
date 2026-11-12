import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { test } from 'node:test';
import { createFakeDemoPptx } from '../src/fake-demo-pptx.mjs';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readZip(buffer) {
  const entries = new Map();
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const flags = buffer.readUInt16LE(offset + 6);
    const method = buffer.readUInt16LE(offset + 8);
    const dosDate = buffer.readUInt16LE(offset + 12);
    const crc = buffer.readUInt32LE(offset + 14);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const size = buffer.readUInt32LE(offset + 22);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buffer.toString('utf8', nameStart, nameStart + nameLength);
    const compressedStart = nameStart + nameLength + extraLength;
    const compressed = buffer.subarray(compressedStart, compressedStart + compressedSize);
    assert.equal(flags, 0, 'package entries do not use descriptors, encryption or other flags');
    assert.equal(method, 8, 'OOXML entries use only built-in DEFLATE compression');
    assert.equal(dosDate, 0x0021, 'ZIP entries use a valid deterministic DOS date');
    assert.equal(entries.has(name), false, 'package part names are unique');
    const content = inflateRawSync(compressed);
    assert.equal(content.length, size, `${name} has its declared uncompressed length`);
    assert.equal(crc32(content), crc, `${name} passes ZIP CRC validation`);
    entries.set(name, content.toString('utf8'));
    offset = compressedStart + compressedSize;
  }
  assert.equal(buffer.readUInt32LE(offset), 0x02014b50, 'central directory follows the package parts');
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= offset, 'end-of-central-directory record exists');
  assert.equal(buffer.readUInt16LE(end + 10), entries.size, 'central-directory count matches local entries');
  return entries;
}

function relationshipOwner(name) {
  if (name === '_rels/.rels') return '';
  return name.replace('/_rels/', '/').replace(/\.rels$/, '').replace(/\/[^/]+$/, '');
}

test('fixed demo PowerPoint is a deterministic self-contained OOXML package with fictional speaker notes', () => {
  const bytes = createFakeDemoPptx();
  assert.deepEqual(bytes, createFakeDemoPptx());
  assert.ok(bytes.length < 200_000);
  const entries = readZip(bytes);
  const expected = [
    '[Content_Types].xml', '_rels/.rels', 'ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels',
    'ppt/slideMasters/slideMaster1.xml', 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    'ppt/slideLayouts/slideLayout1.xml', 'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
    'ppt/slides/slide1.xml', 'ppt/slides/_rels/slide1.xml.rels',
    'ppt/notesMasters/notesMaster1.xml', 'ppt/notesMasters/_rels/notesMaster1.xml.rels',
    'ppt/notesSlides/notesSlide1.xml', 'ppt/notesSlides/_rels/notesSlide1.xml.rels', 'ppt/theme/theme1.xml'
  ];
  assert.deepEqual([...entries.keys()].sort(), expected.sort());
  const presentation = entries.get('ppt/presentation.xml');
  const slideSize = /<p:sldSz\b([^>]*)\/>/.exec(presentation)?.[1];
  assert.ok(slideSize, 'presentation declares a slide size');
  assert.equal(/\bcx="([^"]+)"/.exec(slideSize)?.[1], '12192000');
  assert.equal(/\bcy="([^"]+)"/.exec(slideSize)?.[1], '6858000');
  assert.equal(/\btype="([^"]+)"/.exec(slideSize)?.[1], 'screen16x9', '16:9 dimensions use the schema-valid ST_SlideSizeType value');
  const presentationOrder = ['sldMasterIdLst', 'notesMasterIdLst', 'sldIdLst', 'sldSz']
    .map(name => presentation.indexOf(`<p:${name}`));
  assert.ok(presentationOrder.every((position, index) => position >= 0 && (index === 0 || presentationOrder[index - 1] < position)),
    'notes master list appears in presentation schema order');
  const notesMasterReference = /<p:notesMasterId\b[^>]*r:id="([^"]+)"/.exec(presentation)?.[1];
  assert.equal(notesMasterReference, 'rId3');
  assert.match(entries.get('ppt/_rels/presentation.xml.rels'),
    /<Relationship Id="rId3" Type="[^"]+\/notesMaster" Target="notesMasters\/notesMaster1\.xml"\/>/);
  const master = entries.get('ppt/slideMasters/slideMaster1.xml');
  const layoutId = /<p:sldLayoutId\b([^>]*)\/>/.exec(master)?.[1];
  assert.ok(layoutId, 'slide master references its layout');
  const layoutNumber = Number(/\bid="([^"]+)"/.exec(layoutId)?.[1]);
  assert.ok(Number.isSafeInteger(layoutNumber) && layoutNumber >= 2147483648, 'layout identifier satisfies ST_SlideLayoutId minimum');
  const layoutRelationship = /\br:id="([^"]+)"/.exec(layoutId)?.[1];
  assert.equal(layoutRelationship, 'rId1');
  assert.match(entries.get('ppt/slideMasters/_rels/slideMaster1.xml.rels'), /<Relationship Id="rId1" Type="[^"]+\/slideLayout" Target="\.\.\/slideLayouts\/slideLayout1\.xml"\/>/);
  const theme = entries.get('ppt/theme/theme1.xml');
  for (const collectionName of ['majorFont', 'minorFont']) {
    const collection = new RegExp(`<a:${collectionName}>(.*?)</a:${collectionName}>`).exec(theme)?.[1];
    assert.ok(collection, `${collectionName} collection exists`);
    assert.match(collection, /^<a:latin\b[^>]*\/><a:ea\b[^>]*\/><a:cs\b[^>]*\/>$/, `${collectionName} has latin, ea, cs in schema order`);
  }
  const notesMaster = entries.get('ppt/notesMasters/notesMaster1.xml');
  const notesMasterBody = /<p:sp>(?:(?!<\/p:sp>).)*?<p:cNvPr\b[^>]*id="([^"]+)"[^>]*\/>(?:(?!<\/p:sp>).)*?<p:ph type="body" idx="([^"]+)"\/>(?:(?!<\/p:sp>).)*?<p:spPr><a:xfrm><a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/><\/a:xfrm><\/p:spPr>(?:(?!<\/p:sp>).)*?<\/p:sp>/s.exec(notesMaster);
  assert.ok(notesMasterBody, 'notes master body placeholder has explicit geometry');
  assert.equal(notesMasterBody[2], '1');
  const [, , , x, y, width, height] = notesMasterBody;
  const notesSize = /<p:notesSz\b[^>]*cx="(\d+)" cy="(\d+)"/.exec(presentation);
  assert.ok(notesSize, 'presentation declares notes dimensions');
  const [notesWidth, notesHeight] = notesSize.slice(1).map(Number);
  const [left, top, bodyWidth, bodyHeight] = [x, y, width, height].map(Number);
  assert.ok(left > 0 && top > 0 && bodyWidth > 0 && bodyHeight > 0);
  assert.ok(left + bodyWidth <= notesWidth && top + bodyHeight <= notesHeight, 'notes geometry fits within notesSz');
  const notesSlide = entries.get('ppt/notesSlides/notesSlide1.xml');
  assert.match(notesSlide, /<p:cNvPr\b[^>]*name="Speaker Notes"[^>]*\/>.*?<p:ph type="body" idx="1"\/>/);
  assert.match(notesMasterBody[0], /<p:ph type="body" idx="1"\/>/, 'notes master body placeholder identity matches the notes slide');
  assert.match(entries.get('ppt/slides/slide1.xml'), /Example North \| north@example\.invalid/);
  assert.match(entries.get('ppt/notesSlides/notesSlide1.xml'), /Fictional facilitator notes/);
  assert.match(entries.get('ppt/notesSlides/notesSlide1.xml'), /Do not enter real information/);
  assert.doesNotMatch([...entries.values()].join('\n'), /customer|credential|secret|task source/i);

  for (const [name, content] of entries) {
    assert.match(content, /^<\?xml/);
    assert.doesNotMatch(content, /TargetMode="External"|<a:hlink(?:Click|Hover)\b|<p:oleObj|vbaProject|activeX|macroEnabled/i);
    if (!name.endsWith('.rels')) continue;
    for (const relationship of content.matchAll(/<Relationship\b([^>]*)\/>/g)) {
      const attributes = relationship[1];
      const type = /\bType="([^"]+)"/.exec(attributes)?.[1];
      const target = /\bTarget="([^"]+)"/.exec(attributes)?.[1];
      assert.match(type || '', /\/(?:officeDocument|slideMaster|slide|notesMaster|theme|slideLayout|notesSlide)$/);
      assert.ok(target, `${name} relationship has a target`);
      assert.doesNotMatch(target, /^(?:[a-z][a-z0-9+.-]*:|\/|\\\\)/i, 'relationships are package-local, never network or absolute');
      const targetPath = `${relationshipOwner(name)}/${target}`.split('/');
      const resolved = [];
      for (const segment of targetPath) {
        if (!segment || segment === '.') continue;
        if (segment === '..') resolved.pop();
        else resolved.push(segment);
      }
      assert.ok(entries.has(resolved.join('/')), `${name} resolves internally to ${target}`);
    }
  }
  assert.ok([...entries.keys()].every(name => !/^(?:ppt\/(?:media|embeddings|activeX)\/|ppt\/vbaProject)/i.test(name)));
});
