const formats = new Set(['markdown', 'docx', 'pptx', 'xlsx']);

export function documentFormat(document) {
  const format = document?.format || 'markdown';
  if (!formats.has(format) || (document?.kind === 'monthly-outcomes-xlsx' && format !== 'xlsx') ||
      (format === 'xlsx' && document?.kind !== undefined && document.kind !== 'monthly-outcomes-xlsx')) {
    throw new Error('Unsupported or invalid local document format.');
  }
  return format;
}

export function documentFileName(document) {
  const format = documentFormat(document);
  const expected = format === 'xlsx'
    ? `monthly-outcomes-${document.id}.xlsx`
    : `${document.id}.${format === 'markdown' ? 'md' : format}`;
  if (document.fileName !== undefined && document.fileName !== expected) {
    throw new Error('Invalid local document filename.');
  }
  return expected;
}
