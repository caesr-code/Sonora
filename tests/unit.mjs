import assert from 'node:assert/strict';
import { titleFromFilename, formatTime, sha256Hex, crc32, normalizedSongKey } from '../src/utils.js';
import { parseMp3Metadata, extractEmbeddedLyrics, id3TagLength } from '../src/id3.js';
import { parseCommand, parseTimeSpan, findBestTrack, detectWake, wakeNames, stripGreeting } from '../src/voice-commands.js';

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

// --- embedded lyrics (USLT + SYLT) ---------------------------------------------------------
function rawFrame(id, bodyBytes) {
  const header = new Uint8Array(10);
  header.set(new TextEncoder().encode(id), 0);
  header.set(synchsafe(bodyBytes.length), 4);
  return new Uint8Array([...header, ...bodyBytes]);
}
function buildTag(frameList) {
  const total = frameList.reduce((n, f) => n + f.length, 0);
  const out = new Uint8Array(10 + total);
  out.set([0x49, 0x44, 0x33, 4, 0, 0], 0);
  out.set(synchsafe(total), 6);
  let at = 10;
  for (const f of frameList) { out.set(f, at); at += f.length; }
  return out;
}
const enc = new TextEncoder();
const uslt = rawFrame('USLT', new Uint8Array([3, ...enc.encode('eng'), 0, ...enc.encode('First line\r\nSecond line')]));
const lyricTag = buildTag([frame('TIT2', 'Words'), uslt]);
assert.equal(id3TagLength(lyricTag.subarray(0, 10)), lyricTag.length);
assert.equal(extractEmbeddedLyrics(lyricTag).text, 'First line\nSecond line');
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const sylt = rawFrame('SYLT', new Uint8Array([3, ...enc.encode('eng'), 2, 1, 0, ...enc.encode('Hello'), 0, ...u32(1500), ...enc.encode('World'), 0, ...u32(4200)]));
const synced = extractEmbeddedLyrics(buildTag([sylt])).synced;
assert.deepEqual(synced, [{ start: 1.5, text: 'Hello' }, { start: 4.2, text: 'World' }]);
assert.equal(extractEmbeddedLyrics(tag).text, '');

// --- voice commands ------------------------------------------------------------------------
for (const phrase of ['next', 'play next', 'skip', 'skip this song', 'Skip the song please', 'play the next song', 'next song']) {
  assert.equal(parseCommand(phrase)?.type, 'next', phrase);
}
assert.equal(parseCommand('previous')?.type, 'previous');
assert.equal(parseCommand('go back')?.type, 'previous');
assert.deepEqual(parseCommand('play bohemian rhapsody'), { type: 'playSong', query: 'bohemian rhapsody' });
assert.deepEqual(parseCommand('play Move On'), { type: 'playSong', query: 'move on' });
assert.equal(parseCommand('pause')?.type, 'pause');
assert.equal(parseCommand('resume')?.type, 'resume');
assert.equal(parseCommand('blah blah'), null);
// seeking: seconds by default, minutes and hours when spoken
assert.equal(parseCommand('fast forward 30')?.seconds, 30);
assert.equal(parseCommand('fast forward 30 seconds')?.seconds, 30);
assert.equal(parseCommand('move 2 minutes')?.seconds, 120);
assert.equal(parseCommand('move forward one hour')?.seconds, 3600);
assert.equal(parseCommand('skip 45')?.seconds, 45);
assert.equal(parseCommand('skip ahead a minute and a half')?.seconds, 90);
assert.equal(parseCommand('rewind 15 seconds')?.seconds, -15);
assert.equal(parseCommand('go back 10 seconds')?.seconds, -10);
assert.equal(parseCommand('fast forward')?.seconds, 10);
assert.equal(parseTimeSpan('one minute thirty seconds'), 90);
assert.equal(parseTimeSpan('twenty five'), 25);
assert.equal(parseTimeSpan('hello'), null);

// song matching picks the closest title
const library = [
  { title: 'Bohemian Rhapsody', artist: 'Queen' }, { title: 'Blinding Lights', artist: 'The Weeknd' },
  { title: 'Move On', artist: 'ABBA' }, { title: 'Hey Jude (Remastered 2015)', artist: 'The Beatles' }, { title: 'Billie Jean', artist: 'Michael Jackson' },
];
assert.equal(findBestTrack('bohemian rapsody', library).track.title, 'Bohemian Rhapsody');
assert.equal(findBestTrack('blind lights', library).track.title, 'Blinding Lights');
assert.equal(findBestTrack('billy jean', library).track.title, 'Billie Jean');
assert.equal(findBestTrack('hey jude', library).track.title, 'Hey Jude (Remastered 2015)');
assert.equal(findBestTrack('xylophone zebra', library), null);

// wake phrase: default name, a custom name and loose mis-hearings
const sonora = wakeNames('sonora');
assert.equal(detectWake('hey sonora', sonora).matched, true);
assert.equal(detectWake('hey senora skip this song', sonora).rest, 'skip this song');
assert.equal(detectWake('hey so nora play bohemian rhapsody', sonora).rest, 'play bohemian rhapsody');
assert.equal(detectWake('hello world', sonora).matched, false);
assert.equal(detectWake('i love the sonoran desert', sonora).matched, false);
assert.equal(detectWake('okay jarvis next', wakeNames('jarvis', ['jarvas'])).rest, 'next');
assert.equal(detectWake('hey travis', wakeNames('jarvis')).matched, false);
assert.equal(stripGreeting('hey jarvis'), 'jarvis');

console.log('Unit tests passed.');
