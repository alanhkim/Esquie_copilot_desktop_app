import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createWordTaskSummary } from '../src/word-document.mjs';

test('Word task summary is an inert OOXML package with preserved text and whitespace', async t => {
  if (process.platform !== 'win32') return t.skip('Independent ZIP/XML validation uses the Windows .NET reader.');
  const root = await mkdtemp(join(tmpdir(), 'esquie-word-test-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const path = join(root, 'synthetic-task-summary.docx');
  const instructionLikeText = `A <w:hyperlink> & "quoted" owner's note \u{1f642} \u{1d11e}`;
  const bytes = createWordTaskSummary([{
    id: 'synthetic-task', title: 'Synthetic task\r\nSecond\rThird\nFourth\tColumn', status: 'next',
    dueDate: '2026-11-12', details: instructionLikeText
  }]);
  assert.equal(bytes.readUInt32LE(0), 0x04034b50);
  await writeFile(path, bytes, { mode: 0o600 });

  const escapedPath = path.replaceAll("'", "''");
  const script = `
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead('${escapedPath}')
try {
  $expected = @('[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/_rels/document.xml.rels')
  $names = @($archive.Entries | ForEach-Object FullName | Sort-Object)
  if (($names -join '|') -ne (($expected | Sort-Object) -join '|')) { throw 'Unexpected DOCX package parts.' }
  $xmlParts = @{}
  foreach ($entry in $archive.Entries) {
    $stream = $entry.Open()
    try {
      $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::UTF8)
      try {
        $xml = [System.Xml.XmlDocument]::new()
        $xml.XmlResolver = $null
        $xml.LoadXml($reader.ReadToEnd())
        $xmlParts[$entry.FullName] = $xml
      } finally { $reader.Dispose() }
    } finally { $stream.Dispose() }
  }
  $document = $xmlParts['word/document.xml']
  $namespace = [System.Xml.XmlNamespaceManager]::new($document.NameTable)
  $namespace.AddNamespace('w', 'http://schemas.openxmlformats.org/wordprocessingml/2006/main')
  $margins = $document.SelectSingleNode('/w:document/w:body/w:sectPr/w:pgMar', $namespace)
  $expectedMargins = @{ top = '1440'; right = '1440'; bottom = '1440'; left = '1440'; header = '720'; footer = '720'; gutter = '0' }
  foreach ($name in $expectedMargins.Keys) {
    if ($margins.GetAttribute($name, $namespace.LookupNamespace('w')) -ne $expectedMargins[$name]) { throw "Required page margin is missing or incorrect: $name" }
  }
  $text = (@($document.SelectNodes('//w:t', $namespace) | ForEach-Object InnerText) -join '')
  if (-not $text.Contains('Local task summary') -or -not $text.Contains('A <w:hyperlink> & "quoted" owner''s note')) { throw 'Document text was missing or XML escaping failed.' }
  if (-not $text.Contains([char]::ConvertFromUtf32(0x1f642)) -or -not $text.Contains([char]::ConvertFromUtf32(0x1d11e))) { throw 'Supplementary Unicode was not preserved.' }
  $task = $document.SelectSingleNode('//w:p[w:r/w:t="Synthetic task"]', $namespace)
  $visible = [System.Text.StringBuilder]::new()
  foreach ($node in $task.SelectNodes('w:r/*', $namespace)) {
    switch ($node.LocalName) {
      't' {
        if ($node.InnerText.Contains("\`r") -or $node.InnerText.Contains("\`n") -or $node.InnerText.Contains("\`t")) { throw 'Task whitespace remained raw text.' }
        [void]$visible.Append($node.InnerText)
      }
      'br' { [void]$visible.Append("\`n") }
      'tab' { [void]$visible.Append("\`t") }
    }
  }
  if ($visible.ToString() -ne "Synthetic task\`nSecond\`nThird\`nFourth\`tColumn [next] - due 2026-11-12") { throw 'Visible task line breaks or tabs were not preserved.' }
  if ($document.SelectNodes('//w:hyperlink', $namespace).Count -ne 0) { throw 'Untrusted text became a hyperlink.' }
  if ($xmlParts['word/_rels/document.xml.rels'].DocumentElement.SelectNodes('*[@TargetMode="External"]').Count -ne 0) { throw 'Unexpected external relationship.' }
} finally { $archive.Dispose() }
`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'pipe' });
});

test('Word generator rejects invalid XML characters and caps the package size', () => {
  assert.throws(() => createWordTaskSummary([{ title: 'Invalid \u0001', status: 'next' }]), /XML 1\.0-invalid/);
  assert.throws(() => createWordTaskSummary([{ title: `Unpaired \ud800`, status: 'next' }]), /unpaired surrogates/);
  assert.throws(() => createWordTaskSummary([{ title: 'Large', status: 'next', details: 'x'.repeat(1_100_000) }]), /size limit/);
});
