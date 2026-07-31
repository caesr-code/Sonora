import { crc32 } from './utils.js';

const signatures = {
  eocd: 0x06054b50,
  zip64Locator: 0x07064b50,
  zip64Eocd: 0x06064b50,
  central: 0x02014b50,
  local: 0x04034b50,
};

const utf8 = new TextDecoder('utf-8', { fatal: false });
const latin1 = new TextDecoder('latin1');

function abortError() {
  return new DOMException('Import cancelled.', 'AbortError');
}

function ensureNotAborted(signal) {
  if (signal?.aborted) throw abortError();
}

async function readBytes(blob, start = 0, end = blob.size) {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

function getUint64(view, offset) {
  if (typeof view.getBigUint64 === 'function') {
    const value = view.getBigUint64(offset, true);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('This ZIP archive is too large for this browser.');
    return Number(value);
  }
  const low = view.getUint32(offset, true);
  const high = view.getUint32(offset + 4, true);
  const value = high * 0x100000000 + low;
  if (!Number.isSafeInteger(value)) throw new Error('This ZIP archive is too large for this browser.');
  return value;
}

function findSignatureBackwards(bytes, signature) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = bytes.length - 4; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === signature) return offset;
  }
  return -1;
}

function parseExtraFields(extra) {
  const fields = new Map();
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const id = view.getUint16(offset, true);
    const size = view.getUint16(offset + 2, true);
    const start = offset + 4;
    const end = Math.min(extra.length, start + size);
    fields.set(id, extra.subarray(start, end));
    offset = start + size;
  }
  return fields;
}

function decodeName(nameBytes, flags, extraFields) {
  const unicodePath = extraFields.get(0x7075);
  if (unicodePath?.length > 5 && unicodePath[0] === 1) {
    const candidate = utf8.decode(unicodePath.subarray(5));
    if (candidate) return candidate;
  }
  if (flags & 0x0800) return utf8.decode(nameBytes);
  return latin1.decode(nameBytes);
}

function applyZip64Values(entry, extraFields) {
  const data = extraFields.get(0x0001);
  if (!data) return entry;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;
  const next = () => {
    if (offset + 8 > data.length) throw new Error('Invalid ZIP64 metadata.');
    const value = getUint64(view, offset);
    offset += 8;
    return value;
  };
  if (entry.uncompressedSize === 0xffffffff) entry.uncompressedSize = next();
  if (entry.compressedSize === 0xffffffff) entry.compressedSize = next();
  if (entry.localHeaderOffset === 0xffffffff) entry.localHeaderOffset = next();
  return entry;
}

async function locateCentralDirectory(file, signal) {
  ensureNotAborted(signal);
  const tailSize = Math.min(file.size, 1024 * 128);
  const tailStart = file.size - tailSize;
  const tail = await readBytes(file, tailStart, file.size);
  const eocdIndex = findSignatureBackwards(tail, signatures.eocd);
  if (eocdIndex < 0) throw new Error('This file does not contain a valid ZIP directory.');
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let totalEntries = view.getUint16(eocdIndex + 10, true);
  let centralSize = view.getUint32(eocdIndex + 12, true);
  let centralOffset = view.getUint32(eocdIndex + 16, true);

  const needsZip64 = totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff;
  if (needsZip64) {
    const locatorIndex = eocdIndex - 20;
    if (locatorIndex < 0 || view.getUint32(locatorIndex, true) !== signatures.zip64Locator) {
      throw new Error('ZIP64 information is missing or damaged.');
    }
    const zip64Offset = getUint64(view, locatorIndex + 8);
    const header = await readBytes(file, zip64Offset, Math.min(file.size, zip64Offset + 80));
    const zip64View = new DataView(header.buffer, header.byteOffset, header.byteLength);
    if (zip64View.getUint32(0, true) !== signatures.zip64Eocd) throw new Error('Invalid ZIP64 directory.');
    totalEntries = getUint64(zip64View, 32);
    centralSize = getUint64(zip64View, 40);
    centralOffset = getUint64(zip64View, 48);
  }
  if (centralOffset < 0 || centralSize < 0 || centralOffset + centralSize > file.size) throw new Error('The ZIP directory points outside the archive.');
  return { totalEntries, centralSize, centralOffset };
}

export async function readZipDirectory(file, { signal, onProgress } = {}) {
  if (!(file instanceof Blob) || !file.size) throw new Error('Choose a non-empty ZIP archive.');
  ensureNotAborted(signal);
  const info = await locateCentralDirectory(file, signal);
  if (info.centralSize > 256 * 1024 * 1024) throw new Error('This ZIP directory is unusually large and cannot be read safely.');
  const bytes = await readBytes(file, info.centralOffset, info.centralOffset + info.centralSize);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = [];
  let offset = 0;
  let seen = 0;
  while (offset + 46 <= bytes.length && seen < info.totalEntries) {
    ensureNotAborted(signal);
    if (view.getUint32(offset, true) !== signatures.central) throw new Error('The ZIP file directory is corrupt.');
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const crc = view.getUint32(offset + 16, true);
    let compressedSize = view.getUint32(offset + 20, true);
    let uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    let localHeaderOffset = view.getUint32(offset + 42, true);
    const recordEnd = offset + 46 + nameLength + extraLength + commentLength;
    if (recordEnd > bytes.length) throw new Error('A ZIP directory entry is incomplete.');
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const extraBytes = bytes.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength);
    const extraFields = parseExtraFields(extraBytes);
    const entry = applyZip64Values({ flags, method, crc, compressedSize, uncompressedSize, localHeaderOffset }, extraFields);
    compressedSize = entry.compressedSize;
    uncompressedSize = entry.uncompressedSize;
    localHeaderOffset = entry.localHeaderOffset;
    const name = decodeName(nameBytes, flags, extraFields).replace(/\\/g, '/');
    const isDirectory = name.endsWith('/');
    entries.push({ name, flags, method, crc, compressedSize, uncompressedSize, localHeaderOffset, isDirectory });
    offset = recordEnd;
    seen += 1;
    if (seen % 200 === 0) {
      onProgress?.({ phase: 'scan', current: seen, total: info.totalEntries });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  onProgress?.({ phase: 'scan', current: seen, total: info.totalEntries });
  return entries;
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== 'undefined') {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  throw new Error('This browser cannot decompress ZIP files directly.');
}

export async function extractZipEntry(file, entry, { signal, validateCrc = true } = {}) {
  ensureNotAborted(signal);
  if (entry.flags & 0x0001) throw new Error(`“${entry.name}” is encrypted and cannot be imported.`);
  if (entry.uncompressedSize > 1.5 * 1024 * 1024 * 1024) throw new Error(`“${entry.name}” is too large to import safely.`);
  const header = await readBytes(file, entry.localHeaderOffset, entry.localHeaderOffset + 30);
  if (header.length < 30) throw new Error(`“${entry.name}” has an incomplete local header.`);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (view.getUint32(0, true) !== signatures.local) throw new Error(`“${entry.name}” has an invalid local header.`);
  const nameLength = view.getUint16(26, true);
  const extraLength = view.getUint16(28, true);
  const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > file.size) throw new Error(`“${entry.name}” extends beyond the ZIP archive.`);
  const compressed = await readBytes(file, dataStart, dataEnd);
  ensureNotAborted(signal);
  let output;
  if (entry.method === 0) output = compressed;
  else if (entry.method === 8) output = await inflateRaw(compressed);
  else throw new Error(`“${entry.name}” uses an unsupported ZIP compression method (${entry.method}).`);
  ensureNotAborted(signal);
  if (entry.uncompressedSize !== 0xffffffff && output.length !== entry.uncompressedSize) {
    throw new Error(`“${entry.name}” did not extract to the expected size.`);
  }
  if (validateCrc && crc32(output) !== entry.crc) throw new Error(`“${entry.name}” failed its integrity check.`);
  return output;
}

export async function* iterateMp3Files(file, { signal, onProgress } = {}) {
  let entries;
  try {
    entries = await readZipDirectory(file, { signal, onProgress });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    if (!globalThis.JSZip) throw error;
    yield* iterateWithJsZip(file, { signal, onProgress, originalError: error });
    return;
  }
  const mp3Entries = entries.filter((entry) => !entry.isDirectory && entry.name.toLowerCase().endsWith('.mp3') && !entry.name.startsWith('__MACOSX/'));
  onProgress?.({ phase: 'found', current: 0, total: mp3Entries.length });
  for (let index = 0; index < mp3Entries.length; index += 1) {
    ensureNotAborted(signal);
    const entry = mp3Entries[index];
    try {
      const bytes = await extractZipEntry(file, entry, { signal });
      yield { name: entry.name, bytes, size: bytes.length, error: null };
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      yield { name: entry.name, bytes: null, size: 0, error };
    }
    onProgress?.({ phase: 'extract', current: index + 1, total: mp3Entries.length, name: entry.name });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function* iterateWithJsZip(file, { signal, onProgress, originalError } = {}) {
  ensureNotAborted(signal);
  let zip;
  try {
    zip = await globalThis.JSZip.loadAsync(file, { checkCRC32: true, createFolders: false });
  } catch {
    throw originalError || new Error('The selected file is not a valid ZIP archive.');
  }
  const files = Object.values(zip.files).filter((entry) => !entry.dir && entry.name.toLowerCase().endsWith('.mp3') && !entry.name.startsWith('__MACOSX/'));
  onProgress?.({ phase: 'found', current: 0, total: files.length });
  for (let index = 0; index < files.length; index += 1) {
    ensureNotAborted(signal);
    const entry = files[index];
    try {
      const bytes = await entry.async('uint8array');
      yield { name: entry.name, bytes, size: bytes.length, error: null };
    } catch (error) {
      yield { name: entry.name, bytes: null, size: 0, error };
    }
    onProgress?.({ phase: 'extract', current: index + 1, total: files.length, name: entry.name });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
