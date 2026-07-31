import assert from 'node:assert/strict';
import { titleFromFilename, formatTime, sha256Hex, crc32, normalizedSongKey } from '../src/utils.js';
import { parseMp3Metadata } from '../src/id3.js';

assert.equal(titleFromFilename('Music/Never_Gonna_Give_You_Up.mp3'), 'Never Gonna Give You Up');
assert.equal(formatTime(65.8), '1:05');
assert.equal(normalizedSongKey({ title: 'A', artist: 'B', album: 'C', size: 2 }), 'a|b|c|2');
assert.equal(await sha256Hex(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);

function synchsafe(value) {
  return new Uint8Array([(value >> 21) & 0x7f, (value >> 14) & 0x7f, (value >> 7) & 0x7f, value & 0x7f]);
}
function frame(id, text) {
  const body = new Uint8Array([3, ...new TextEncoder().encode(text)]);
  const header = new Uint8Array(10);
  header.set(new TextEncoder().encode(id), 0);
  header.set(synchsafe(body.length), 4);
  return new Uint8Array([...header, ...body]);
}
const frames = [frame('TIT2', 'Test Song'), frame('TPE1', 'Test Artist'), frame('TALB', 'Test Album')];
const body = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
let offset = 0;
for (const item of frames) { body.set(item, offset); offset += item.length; }
const tag = new Uint8Array(10 + body.length + 4);
tag.set([0x49, 0x44, 0x33, 4, 0, 0], 0);
tag.set(synchsafe(body.length), 6);
tag.set(body, 10);
tag.set([0xff, 0xfb, 0x90, 0x64], 10 + body.length);
const parsed = parseMp3Metadata(tag, 'fallback.mp3');
assert.equal(parsed.title, 'Test Song');
assert.equal(parsed.artist, 'Test Artist');
assert.equal(parsed.album, 'Test Album');

console.log('Unit tests passed.');
