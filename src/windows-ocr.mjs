import { runSystemPowerShell } from './private-storage.mjs';

export const MAX_OCR_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_OCR_IMAGE_PIXELS = 16_000_000;
export const MAX_OCR_IMAGE_DIMENSION = 8192;
export const MAX_OCR_TEXT_LENGTH = 16_000;
const MAX_OCR_OUTPUT_BYTES = 128_000;
const OCR_TIMEOUT_MS = 30_000;
const OCR_BUSY_MESSAGE = 'A screenshot OCR operation is already in progress. Try again when it finishes.';

export class WindowsOcrError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const JPEG_START_OF_FRAME = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegDimensions(bytes) {
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0x00) continue;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xda || offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if (JPEG_START_OF_FRAME.has(marker)) {
      if (length < 7) return null;
      return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
  return null;
}

function dimensionsFor(bytes, mimeType) {
  if (mimeType === 'image/png' && bytes.length >= 24 &&
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR') {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (mimeType === 'image/jpeg' && bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return jpegDimensions(bytes);
  }
  if (mimeType === 'image/bmp' && bytes.length >= 54 && bytes.toString('ascii', 0, 2) === 'BM' &&
      bytes.readUInt32LE(14) >= 40) {
    const width = bytes.readInt32LE(18);
    const height = Math.abs(bytes.readInt32LE(22));
    return { width, height };
  }
  return null;
}

export function decodeWindowsOcrImage(mimeType, imageBase64) {
  const allowedTypes = new Set(['image/png', 'image/jpeg', 'image/bmp']);
  if (!allowedTypes.has(mimeType)) throw new WindowsOcrError(415, 'Choose a PNG, JPEG, or BMP screenshot.');
  const maxEncodedLength = Math.ceil(MAX_OCR_IMAGE_BYTES / 3) * 4;
  if (typeof imageBase64 !== 'string' || imageBase64.length > maxEncodedLength) {
    throw new WindowsOcrError(413, 'Screenshots must be 4 MiB or smaller.');
  }
  const padding = imageBase64.endsWith('==') ? 2 : imageBase64.endsWith('=') ? 1 : 0;
  const estimatedBytes = Math.floor(imageBase64.length / 4) * 3 - padding;
  if (estimatedBytes > MAX_OCR_IMAGE_BYTES) throw new WindowsOcrError(413, 'Screenshots must be 4 MiB or smaller.');
  if (!imageBase64.length || imageBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(imageBase64)) {
    throw new WindowsOcrError(400, 'The selected screenshot data is invalid.');
  }
  const image = Buffer.from(imageBase64, 'base64');
  if (!image.length || image.length > MAX_OCR_IMAGE_BYTES) {
    throw new WindowsOcrError(image.length ? 413 : 400, image.length ? 'Screenshots must be 4 MiB or smaller.' : 'The selected screenshot is empty.');
  }
  if (image.toString('base64') !== imageBase64) {
    image.fill(0);
    throw new WindowsOcrError(400, 'The selected screenshot data is invalid.');
  }

  const dimensions = dimensionsFor(image, mimeType);
  if (!dimensions || !Number.isSafeInteger(dimensions.width) || !Number.isSafeInteger(dimensions.height) ||
      dimensions.width <= 0 || dimensions.height <= 0) {
    image.fill(0);
    throw new WindowsOcrError(400, 'The selected file is not a supported PNG, JPEG, or BMP image.');
  }
  if (dimensions.width > MAX_OCR_IMAGE_DIMENSION || dimensions.height > MAX_OCR_IMAGE_DIMENSION ||
      dimensions.width * dimensions.height > MAX_OCR_IMAGE_PIXELS) {
    image.fill(0);
    throw new WindowsOcrError(413, 'Screenshots may be at most 8,192 pixels per side and 16 megapixels.');
  }
  return image;
}

const POWERSHELL_OCR = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Wait-Operation($operation, [type]$resultType) {
  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } |
    Select-Object -First 1
  if (!$method) { throw 'WinRT async projection unavailable.' }
  $task = $method.MakeGenericMethod($resultType).Invoke($null, @($operation))
  $task.Wait()
  return $task.Result
}

$result = @{ status = 'failed' }
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $encoded = [Console]::In.ReadToEnd()
  if ($encoded.Length -gt 5592408) {
    $result = @{ status = 'image-too-large' }
  } else {
    $bytes = [Convert]::FromBase64String($encoded)
    if ($bytes.Length -gt 4194304) {
      $result = @{ status = 'image-too-large' }
    } else {
      $stream = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage, ContentType=WindowsRuntime]::new()
      $writer = [Windows.Storage.Streams.DataWriter, Windows.Storage.Streams, ContentType=WindowsRuntime]::new($stream)
      $writer.WriteBytes($bytes)
      [void](Wait-Operation ($writer.StoreAsync()) ([uint32]))
      $writer.DetachStream() | Out-Null
      $stream.Seek(0)
      $decoderType = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]
      $decoder = Wait-Operation ($decoderType::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime])
      $width = [uint64]$decoder.PixelWidth
      $height = [uint64]$decoder.PixelHeight
      if ($width -gt 8192 -or $height -gt 8192 -or ($width * $height) -gt 16000000) {
        $result = @{ status = 'image-too-large' }
      } else {
        $engine = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]::TryCreateFromUserProfileLanguages()
        if (!$engine) {
          $result = @{ status = 'unavailable' }
        } else {
          $bitmap = Wait-Operation ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType=WindowsRuntime])
          $recognized = Wait-Operation ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType=WindowsRuntime])
          $text = $recognized.Text.Trim()
          if ($text.Length -gt 16000) { $result = @{ status = 'text-too-long' } }
          elseif (!$text) { $result = @{ status = 'no-text' } }
          else { $result = @{ status = 'ok'; text = $text } }
        }
      }
    }
  }
} catch {
  $result = @{ status = 'failed' }
}
[Console]::Out.WriteLine('OCR_RESULT:' + (ConvertTo-Json -InputObject $result -Compress -Depth 3))
`;
async function recognizeWithPowerShell(image, { signal, execute, platform }) {
  if (platform !== 'win32') {
    throw new WindowsOcrError(503, 'On-device Windows OCR is unavailable here. Paste workshop text instead.');
  }
  if (signal?.aborted) throw new WindowsOcrError(503, 'OCR was cancelled; no outcomes were changed.');

  let stdout;
  try {
    ({ stdout } = await execute(POWERSHELL_OCR, {}, {
      input: image.toString('base64'),
      timeoutMs: OCR_TIMEOUT_MS,
      maxBuffer: MAX_OCR_OUTPUT_BYTES,
      signal,
      includeTemp: false
    }));
  } catch (error) {
    if (signal?.aborted) throw new WindowsOcrError(503, 'OCR was cancelled; no outcomes were changed.');
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw new WindowsOcrError(422, 'Windows OCR returned too much text to review. Crop the screenshot and retry.');
    }
    if (error.code === 'ETIMEDOUT' ||
        (error.code === null && error.signal === 'SIGTERM' && error.killed === true)) {
      throw new WindowsOcrError(504, 'Windows OCR timed out. No outcomes were changed.');
    }
    if (error.code === 'ENOENT' || error.message?.includes('system PowerShell installation')) {
      throw new WindowsOcrError(503, 'Windows OCR could not start on this device. Paste workshop text instead.');
    }
    throw new WindowsOcrError(422, 'Windows OCR could not process this screenshot. No outcomes were changed.');
  }

  const marker = stdout.split(/\r?\n/).reverse().find(line => line.startsWith('OCR_RESULT:'));
  if (!marker) throw new WindowsOcrError(503, 'Windows OCR is unavailable or could not process this screenshot. Paste workshop text instead.');
  let payload;
  try { payload = JSON.parse(marker.slice('OCR_RESULT:'.length)); }
  catch { throw new WindowsOcrError(500, 'Windows OCR returned an unreadable result. No outcomes were changed.'); }
  if (payload.status === 'ok' && typeof payload.text === 'string' && payload.text.length <= MAX_OCR_TEXT_LENGTH) {
    return payload.text;
  }
  if (payload.status === 'unavailable') {
    throw new WindowsOcrError(503, 'Windows OCR or a supported local language pack is unavailable. Paste workshop text instead.');
  }
  if (payload.status === 'image-too-large') {
    throw new WindowsOcrError(413, 'Screenshots may be at most 8,192 pixels per side and 16 megapixels.');
  }
  if (payload.status === 'text-too-long') {
    throw new WindowsOcrError(413, 'OCR text exceeds the 16,000-character import limit. Crop the screenshot and retry.');
  }
  if (payload.status === 'no-text') throw new WindowsOcrError(422, 'No readable text was found. No outcomes were changed.');
  throw new WindowsOcrError(422, 'Windows OCR could not process this screenshot. No outcomes were changed.');
}

export function recognizeWindowsScreenshot(image, options = {}) {
  return recognizeWithPowerShell(image, {
    signal: options.signal,
    execute: options.execute || runSystemPowerShell,
    platform: options.platform || process.platform
  });
}

export function createWindowsOcrService({ execute = runSystemPowerShell, platform = process.platform } = {}) {
  let active = null;
  let closed = false;

  return {
    reserve() {
      if (closed) throw new WindowsOcrError(503, 'The local OCR service is shutting down.');
      if (active) throw new WindowsOcrError(429, OCR_BUSY_MESSAGE);
      const operation = { controller: new AbortController(), promise: null, released: false };
      active = operation;

      return {
        run(image, { signal } = {}) {
          if (operation.released) throw new WindowsOcrError(503, 'This OCR request is no longer active.');
          if (operation.promise) throw new WindowsOcrError(409, 'This OCR request has already started.');
          const abort = () => operation.controller.abort();
          if (signal?.aborted) abort();
          else signal?.addEventListener('abort', abort, { once: true });
          operation.promise = recognizeWindowsScreenshot(image, {
            signal: operation.controller.signal,
            execute,
            platform
          }).finally(() => signal?.removeEventListener('abort', abort));
          return operation.promise;
        },
        async release() {
          operation.released = true;
          if (operation.promise) await operation.promise.catch(() => {});
          if (active === operation) active = null;
        }
      };
    },
    async close() {
      closed = true;
      const operation = active;
      if (!operation) return;
      operation.controller.abort();
      if (operation.promise) await operation.promise.catch(() => {});
      operation.released = true;
      if (active === operation) active = null;
    }
  };
}
