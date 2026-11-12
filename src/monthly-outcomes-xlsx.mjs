import { crc32 } from 'node:zlib';

export const MAX_MONTHLY_OUTCOMES_XLSX_BYTES = 1024 * 1024;
const MAX_ROWS = 1000;
const MAX_CELL_CHARACTERS = 32_767;
const XLSX_PACKAGE_OVERHEAD = 16_384;
const XML_LIMIT = MAX_MONTHLY_OUTCOMES_XLSX_BYTES - XLSX_PACKAGE_OVERHEAD;

const columns = [
  'Category', 'Date', 'Account', 'Workshop', 'Title', 'Status',
  'Notes', 'Source URL (not fetched)', 'Owner-provided provenance'
];

function xmlText(value) {
  const text = typeof value === 'string' ? value : '';
  if (text.length > MAX_CELL_CHARACTERS) throw new Error('An outcome field exceeds the supported Excel cell size.');
  let escaped = '';
  for (let index = 0; index < text.length;) {
    const character = String.fromCodePoint(text.codePointAt(index));
    const point = character.codePointAt(0);
    if (!(point === 0x9 || point === 0xA || point === 0xD ||
        (point >= 0x20 && point <= 0xD7FF) ||
        (point >= 0xE000 && point <= 0xFFFD) ||
        (point >= 0x10000 && point <= 0x10FFFF))) {
      throw new Error('An outcome field contains a character that cannot be represented in an Excel workbook.');
    }
    escaped += character === '_' && /^_x[0-9a-fA-F]{4}_/.test(text.slice(index, index + 7)) ? '_x005F_' :
      character === '&' ? '&amp;' :
      character === '<' ? '&lt;' :
        character === '>' ? '&gt;' :
          character === '"' ? '&quot;' :
            character === "'" ? '&apos;' :
              character === '\r' ? '_x000D_' : character;
    index += character.length;
  }
  return escaped;
}

function columnName(number) {
  let result = '';
  while (number > 0) {
    number--;
    result = String.fromCharCode(65 + (number % 26)) + result;
    number = Math.floor(number / 26);
  }
  return result;
}

function worksheetXml(records) {
  const chunks = [];
  let bytes = 0;
  const append = value => {
    bytes += Buffer.byteLength(value);
    if (bytes > XML_LIMIT) throw new Error('The workbook exceeds the supported 1 MiB local export limit.');
    chunks.push(value);
  };
  const row = (index, values) => {
    append(`<row r="${index}">`);
    values.forEach((value, column) => {
      const reference = `${columnName(column + 1)}${index}`;
      const escaped = xmlText(value);
      const style = index === 5 ? ' s="1"' : '';
      append(`<c r="${reference}"${style} t="inlineStr"><is><t xml:space="preserve">${escaped}</t></is></c>`);
    });
    append('</row>');
  };

  append('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  append('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">');
  append(`<dimension ref="A1:I${records.length + 5}"/>`);
  append('<sheetViews><sheetView workbookViewId="0"><pane ySplit="5" topLeftCell="A6" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>');
  append('<cols>');
  [15, 14, 24, 28, 38, 18, 42, 42, 38].forEach((width, index) =>
    append(`<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`));
  append('</cols><sheetData>');
  row(1, ['Monthly Outcomes - local owner-entered records']);
  row(2, ['Partial local export. Reporting metrics, charts, pivots, and live source data are not included.']);
  row(3, ['Source URLs are inert text; they were not fetched or verified. All cell values are stored as literal text.']);
  row(4, ['']);
  row(5, columns);
  records.forEach((record, index) => {
    const workshop = record.workshopImport === undefined ? {} : record.workshopImport;
    row(index + 6, [
      record.category,
      record.date || '',
      workshop.account || '',
      workshop.workshop || '',
      record.title,
      workshop.status || '',
      record.note || '',
      record.sourceUrl || '',
      record.provenance || ''
    ]);
  });
  append('</sheetData>');
  if (records.length) append(`<autoFilter ref="A5:I${records.length + 5}"/>`);
  append('</worksheet>');
  return Buffer.from(chunks.join(''));
}

function zip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const filename = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const checksum = crc32(data) >>> 0;
    const localHeader = Buffer.alloc(30 + filename.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(33, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(filename.length, 26);
    localHeader.writeUInt16LE(0, 28);
    filename.copy(localHeader, 30);
    local.push(localHeader, data);

    const centralHeader = Buffer.alloc(46 + filename.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(33, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(filename.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    filename.copy(centralHeader, 46);
    central.push(centralHeader);
    offset += localHeader.length + data.length;
  }
  const centralDirectory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  const result = Buffer.concat([...local, centralDirectory, end]);
  if (result.length > MAX_MONTHLY_OUTCOMES_XLSX_BYTES) {
    throw new Error('The workbook exceeds the supported 1 MiB local export limit.');
  }
  return result;
}

export function createMonthlyOutcomesWorkbook(records) {
  if (!Array.isArray(records) || records.length > MAX_ROWS) {
    throw new Error('The workbook supports at most 1,000 local outcome and engagement records.');
  }
  for (const record of records) {
    if (!record || !['outcome', 'engagement'].includes(record.category) ||
        typeof record.title !== 'string' || typeof record.note !== 'string' && record.note !== undefined ||
        typeof record.date !== 'string' && record.date !== undefined ||
        typeof record.sourceUrl !== 'string' && record.sourceUrl !== undefined ||
        typeof record.provenance !== 'string' && record.provenance !== undefined) {
      throw new Error('A local outcome record is invalid; the workbook was not created.');
    }
    if (record.workshopImport !== undefined &&
        (!record.workshopImport || typeof record.workshopImport !== 'object' || Array.isArray(record.workshopImport) ||
          ['account', 'workshop', 'status'].some(field =>
            record.workshopImport[field] !== undefined && typeof record.workshopImport[field] !== 'string'))) {
      throw new Error('A local workshop record is invalid; the workbook was not created.');
    }
  }
  const sheet = worksheetXml(records);
  return zip([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Monthly Outcomes" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
    ['xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="10"/><name val="Arial"/><family val="2"/></font><font><b/><sz val="10"/><name val="Arial"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'],
    ['xl/worksheets/sheet1.xml', sheet]
  ]);
}
