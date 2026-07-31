import { titleFromFilename } from './utils.js';

const latin1 = new TextDecoder('latin1');
const utf8 = new TextDecoder('utf-8', { fatal: false });

function synchsafe32(bytes, offset) {
  return ((bytes[offset] & 0x7f) << 21)
    | ((bytes[offset + 1] & 0x7f) << 14)
    | ((bytes[offset + 2] & 0x7f) << 7)
    | (bytes[offset + 3] & 0x7f);
}

function uint24(bytes, offset) {
  return (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2];
}

function uint32(bytes, offset) {
  return ((bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0;
}

function stripUnsynchronisation(bytes) {
  const output = new Uint8Array(bytes.length);
  let write = 0;
  for (let read = 0; read < bytes.length; read += 1) {
    output[write++] = bytes[read];
    if (bytes[read] === 0xff && bytes[read + 1] === 0x00) read += 1;
  }
  return output.subarray(0, write);
}

function trimText(value) {
  return String(value || '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
}

function decodeUtf16(bytes, bigEndian = false) {
  if (!bytes.length) return '';
  let start = 0;
  let endian = bigEndian ? 'utf-16be' : 'utf-16le';
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    endian = 'utf-16be';
    start = 2;
  } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    endian = 'utf-16le';
    start = 2;
  }
  try {
    return new TextDecoder(endian, { fatal: false }).decode(bytes.subarray(start));
  } catch {
    const chars = [];
    for (let i = start; i + 1 < bytes.length; i += 2) {
      const code = endian === 'utf-16be' ? (bytes[i] << 8) | bytes[i + 1] : bytes[i] | (bytes[i + 1] << 8);
      chars.push(String.fromCharCode(code));
    }
    return chars.join('');
  }
}

function decodeTextPayload(payload) {
  if (!payload?.length) return '';
  const encoding = payload[0];
  const bytes = payload.subarray(1);
  let value = '';
  if (encoding === 0) value = latin1.decode(bytes);
  else if (encoding === 1) value = decodeUtf16(bytes);
  else if (encoding === 2) value = decodeUtf16(bytes, true);
  else value = utf8.decode(bytes);
  return trimText(value.split('\u0000')[0]);
}

function terminatorLength(encoding) {
  return encoding === 1 || encoding === 2 ? 2 : 1;
}

function findTerminator(bytes, start, encoding) {
  const step = terminatorLength(encoding);
  if (step === 1) {
    for (let i = start; i < bytes.length; i += 1) if (bytes[i] === 0) return i;
  } else {
    for (let i = start; i + 1 < bytes.length; i += 2) if (bytes[i] === 0 && bytes[i + 1] === 0) return i;
  }
  return bytes.length;
}

function parseApic(payload, version) {
  if (!payload?.length) return null;
  const encoding = payload[0];
  let cursor = 1;
  let mime = '';
  if (version === 2) {
    const format = latin1.decode(payload.subarray(cursor, cursor + 3)).toLowerCase();
    cursor += 3;
    mime = format === 'png' ? 'image/png' : format === 'jpg' || format === 'jpeg' ? 'image/jpeg' : `image/${format}`;
  } else {
    const mimeEnd = findTerminator(payload, cursor, 0);
    mime = latin1.decode(payload.subarray(cursor, mimeEnd)).trim().toLowerCase();
    cursor = mimeEnd + 1;
  }
  if (cursor >= payload.length) return null;
  const pictureType = payload[cursor];
  cursor += 1;
  const descriptionEnd = findTerminator(payload, cursor, encoding);
  cursor = Math.min(payload.length, descriptionEnd + terminatorLength(encoding));
  const imageBytes = payload.subarray(cursor);
  if (imageBytes.length < 16 || imageBytes.length > 25 * 1024 * 1024) return null;
  if (!mime || mime === 'image/') {
    if (imageBytes[0] === 0xff && imageBytes[1] === 0xd8) mime = 'image/jpeg';
    else if (imageBytes[0] === 0x89 && imageBytes[1] === 0x50) mime = 'image/png';
    else if (imageBytes[0] === 0x47 && imageBytes[1] === 0x49) mime = 'image/gif';
    else mime = 'application/octet-stream';
  }
  return { mime, pictureType, bytes: imageBytes.slice() };
}

function parseComment(payload) {
  if (!payload?.length || payload.length < 5) return '';
  const encoding = payload[0];
  let cursor = 4;
  const descriptionEnd = findTerminator(payload, cursor, encoding);
  cursor = descriptionEnd + terminatorLength(encoding);
  if (cursor >= payload.length) return '';
  const wrapped = new Uint8Array(payload.length - cursor + 1);
  wrapped[0] = encoding;
  wrapped.set(payload.subarray(cursor), 1);
  return decodeTextPayload(wrapped);
}

function parseId3v2(input) {
  if (input.length < 10 || input[0] !== 0x49 || input[1] !== 0x44 || input[2] !== 0x33) return null;
  const version = input[3];
  if (![2, 3, 4].includes(version)) return null;
  const flags = input[5];
  const tagSize = synchsafe32(input, 6);
  const tagEnd = Math.min(input.length, 10 + tagSize);
  let tag = input.subarray(10, tagEnd);
  if (flags & 0x80) tag = stripUnsynchronisation(tag);
  let cursor = 0;
  if ((flags & 0x40) && version >= 3 && tag.length >= 4) {
    const extendedSize = version === 4 ? synchsafe32(tag, 0) : uint32(tag, 0);
    cursor = version === 3 ? Math.min(tag.length, extendedSize + 4) : Math.min(tag.length, extendedSize);
  }
  const data = {};
  const pictures = [];
  while (cursor < tag.length) {
    let frameId;
    let frameSize;
    let headerSize;
    let frameFlags = 0;
    if (version === 2) {
      if (cursor + 6 > tag.length) break;
      frameId = latin1.decode(tag.subarray(cursor, cursor + 3));
      frameSize = uint24(tag, cursor + 3);
      headerSize = 6;
    } else {
      if (cursor + 10 > tag.length) break;
      frameId = latin1.decode(tag.subarray(cursor, cursor + 4));
      frameSize = version === 4 ? synchsafe32(tag, cursor + 4) : uint32(tag, cursor + 4);
      frameFlags = (tag[cursor + 8] << 8) | tag[cursor + 9];
      headerSize = 10;
    }
    if (!frameId.trim() || /^\x00+$/.test(frameId) || frameSize <= 0) break;
    const frameStart = cursor + headerSize;
    const frameEnd = frameStart + frameSize;
    if (frameEnd > tag.length) break;
    let payload = tag.subarray(frameStart, frameEnd);
    const compressed = version === 3 ? Boolean(frameFlags & 0x0080) : Boolean(frameFlags & 0x0008);
    const encrypted = version === 3 ? Boolean(frameFlags & 0x0040) : Boolean(frameFlags & 0x0004);
    const unsynchronised = version === 4 && Boolean(frameFlags & 0x0002);
    if (unsynchronised) payload = stripUnsynchronisation(payload);
    if (!compressed && !encrypted) {
      const mapped = {
        TIT2: 'title', TT2: 'title', TPE1: 'artist', TP1: 'artist', TALB: 'album', TAL: 'album',
        TPE2: 'albumArtist', TP2: 'albumArtist', TCOM: 'composer', TCM: 'composer',
        TRCK: 'trackNumber', TRK: 'trackNumber', TPOS: 'discNumber', TPA: 'discNumber',
        TDRC: 'year', TYER: 'year', TYE: 'year', TCON: 'genre', TCO: 'genre',
      }[frameId];
      if (mapped && data[mapped] == null) data[mapped] = decodeTextPayload(payload);
      else if ((frameId === 'APIC' || frameId === 'PIC') && pictures.length < 4) {
        const picture = parseApic(payload, version);
        if (picture) pictures.push(picture);
      } else if ((frameId === 'COMM' || frameId === 'COM') && !data.comment) data.comment = parseComment(payload);
    }
    cursor = frameEnd;
  }
  const picture = pictures.find((item) => item.pictureType === 3) || pictures[0] || null;
  return { ...data, picture, tagEnd };
}

function parseId3v1(bytes) {
  if (bytes.length < 128) return null;
  const offset = bytes.length - 128;
  if (latin1.decode(bytes.subarray(offset, offset + 3)) !== 'TAG') return null;
  const field = (start, length) => trimText(latin1.decode(bytes.subarray(offset + start, offset + start + length)));
  return {
    title: field(3, 30),
    artist: field(33, 30),
    album: field(63, 30),
    year: field(93, 4),
    comment: field(97, 30),
  };
}

export function parseMp3Metadata(bytes, filename = '') {
  const v2 = parseId3v2(bytes) || {};
  const v1 = parseId3v1(bytes) || {};
  const title = v2.title || v1.title || titleFromFilename(filename);
  const artist = v2.artist || v1.artist || 'Unknown Artist';
  const album = v2.album || v1.album || 'Unknown Album';
  const artworkBlob = v2.picture ? new Blob([v2.picture.bytes], { type: v2.picture.mime }) : null;
  return {
    title,
    artist,
    album,
    albumArtist: v2.albumArtist || '',
    composer: v2.composer || '',
    genre: v2.genre || '',
    year: v2.year || v1.year || '',
    trackNumber: v2.trackNumber || '',
    discNumber: v2.discNumber || '',
    comment: v2.comment || v1.comment || '',
    artworkBlob,
    hasArtwork: Boolean(artworkBlob),
    audioStart: v2.tagEnd || 0,
  };
}
