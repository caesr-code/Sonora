// Verifies queue behaviour (loop, sort order, shuffle laps) with stubbed browser globals.
import assert from 'node:assert/strict';

class FakeAudio extends EventTarget {
  constructor() { super(); this.paused = true; this.currentTime = 0; this.duration = 100; this.readyState = 4; this.volume = 1; this.muted = false; this.src = ''; }
  load() {}
  pause() { this.paused = true; }
  async play() { this.paused = false; }
  removeAttribute() { this.src = ''; }
  setAttribute() {}
}
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
globalThis.URL.createObjectURL = () => `blob:${Math.random()}`;
globalThis.URL.revokeObjectURL = () => {};
globalThis.MediaMetadata = class {};

const { AudioEngine } = await import('../src/audio-engine.js');
const settings = Object.assign(new EventTarget(), { get: (key) => ({ defaultVolume: 0.8, mediaSession: false })[key] });
const ids = ['a', 'b', 'c', 'd', 'e'];
const engine = new AudioEngine({
  primary: new FakeAudio(), standby: new FakeAudio(), settings,
  getTrack: async (id) => ({ id, title: id, artist: 'x', album: 'y' }),
  getAudioBlob: async () => new Blob(['x']),
  getArtworkUrl: async () => null,
  updateDuration: () => {},
});

// 1. Ordered playback loops forever in library order.
await engine.setQueue(ids, 'a', { autoplay: true });
const order = [engine.currentId];
for (let i = 0; i < 11; i += 1) { await engine.next(true); order.push(engine.currentId); }
assert.deepEqual(order, ['a','b','c','d','e','a','b','c','d','e','a','b'], 'ordered queue must loop');

// 2. Previous from the first song wraps to the last.
await engine.setQueue(ids, 'a', { autoplay: true });
await engine.previous();
assert.equal(engine.currentId, 'e');

// 3. Shuffle: every lap plays each song exactly once, in a new order, with no repeat at lap boundaries.
await engine.setQueue(ids, 'a', { autoplay: true });
engine.toggleShuffle(true);
assert.equal(engine.queue.length, 5);
assert.equal(engine.currentId, 'a');
const played = [engine.currentId];
for (let i = 0; i < 14; i += 1) { await engine.next(true); played.push(engine.currentId); }
for (let lap = 0; lap < 3; lap += 1) {
  const chunk = played.slice(lap * 5, lap * 5 + 5);
  assert.deepEqual([...chunk].sort(), ids, `lap ${lap} must contain every song once: ${chunk}`);
}
for (let i = 1; i < played.length; i += 1) assert.notEqual(played[i], played[i - 1], 'a song must not repeat back to back');
const laps = [0, 1, 2].map((lap) => played.slice(lap * 5, lap * 5 + 5).join(''));
assert.ok(new Set(laps).size > 1, `laps should be reshuffled: ${laps}`);

// 4. Turning shuffle off restores the sort order and keeps the current song.
engine.toggleShuffle(false);
assert.deepEqual(engine.queue, ids);
assert.equal(engine.queue[engine.queueIndex], engine.currentId);

// 5. shuffleAll starts a random queue with shuffle switched on.
await engine.shuffleAll(ids);
assert.equal(engine.shuffle, true);
assert.deepEqual([...engine.queue].sort(), ids);

// 6. Changing the sort order re-orders the queue without interrupting playback (shuffle off).
engine.toggleShuffle(false);
const playing = engine.currentId;
engine.syncLibraryOrder(['e', 'd', 'c', 'b', 'a']);
assert.deepEqual(engine.queue, ['e', 'd', 'c', 'b', 'a']);
assert.equal(engine.currentId, playing);
assert.equal(engine.queue[engine.queueIndex], playing);

// 7. Repeat-one keeps the song on natural end but manual next still moves on.
await engine.setQueue(ids, 'c', { autoplay: true });
engine.cycleRepeat();
assert.equal(engine.repeat, 'one');
await engine.next(false);
assert.equal(engine.currentId, 'c');
await engine.next(true);
assert.equal(engine.currentId, 'd');

// 8. Ducking lowers the element volume but not the saved volume.
engine.cycleRepeat();
engine.setVolume(0.5);
engine.setDuck(0.2);
assert.equal(engine.volume, 0.5);
assert.ok(Math.abs(engine.active.volume - 0.1) < 1e-9);
engine.setDuck(1);
assert.equal(engine.active.volume, 0.5);

console.log('Engine queue tests passed.');
process.exit(0);
