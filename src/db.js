const DB_NAME = 'sonora-library';
const DB_VERSION = 3;
let dbPromise;

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Database request failed.'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Database transaction failed.'));
    transaction.onabort = () => reject(transaction.error || new Error('Database transaction was cancelled.'));
  });
}

export function openDatabase() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('tracks')) {
        const tracks = db.createObjectStore('tracks', { keyPath: 'id' });
        tracks.createIndex('hash', 'hash', { unique: true });
        tracks.createIndex('addedAt', 'addedAt');
        tracks.createIndex('titleSort', 'titleSort');
        tracks.createIndex('artistSort', 'artistSort');
        tracks.createIndex('albumSort', 'albumSort');
      }
      if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('artwork')) db.createObjectStore('artwork', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('waveforms')) db.createObjectStore('waveforms', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error || new Error('Could not open Sonora storage.'));
    request.onblocked = () => reject(new Error('Sonora storage is open in another older tab. Close it and try again.'));
  });
  return dbPromise;
}

export async function getAllTracks() {
  const db = await openDatabase();
  const tx = db.transaction('tracks', 'readonly');
  const result = await requestToPromise(tx.objectStore('tracks').getAll());
  await transactionDone(tx);
  return result;
}

export async function getTrack(id) {
  const db = await openDatabase();
  const tx = db.transaction('tracks', 'readonly');
  const result = await requestToPromise(tx.objectStore('tracks').get(id));
  await transactionDone(tx);
  return result;
}

export async function getTrackByHash(hash) {
  const db = await openDatabase();
  const tx = db.transaction('tracks', 'readonly');
  const result = await requestToPromise(tx.objectStore('tracks').index('hash').get(hash));
  await transactionDone(tx);
  return result;
}

export async function putImportedTrack(track, audioBlob, artworkBlob = null) {
  const db = await openDatabase();
  const stores = artworkBlob ? ['tracks', 'audio', 'artwork'] : ['tracks', 'audio'];
  const tx = db.transaction(stores, 'readwrite', { durability: 'relaxed' });
  tx.objectStore('tracks').put(track);
  tx.objectStore('audio').put({ id: track.id, blob: audioBlob });
  if (artworkBlob) tx.objectStore('artwork').put({ id: track.id, blob: artworkBlob });
  await transactionDone(tx);
}

export async function updateTrack(track) {
  const db = await openDatabase();
  const tx = db.transaction('tracks', 'readwrite', { durability: 'relaxed' });
  tx.objectStore('tracks').put(track);
  await transactionDone(tx);
}

export async function updateTrackFields(id, fields) {
  const track = await getTrack(id);
  if (!track) return null;
  const updated = { ...track, ...fields, updatedAt: Date.now() };
  await updateTrack(updated);
  return updated;
}

export async function getAudioBlob(id) {
  const db = await openDatabase();
  const tx = db.transaction('audio', 'readonly');
  const result = await requestToPromise(tx.objectStore('audio').get(id));
  await transactionDone(tx);
  return result?.blob || null;
}

export async function getArtworkBlob(id) {
  const db = await openDatabase();
  const tx = db.transaction('artwork', 'readonly');
  const result = await requestToPromise(tx.objectStore('artwork').get(id));
  await transactionDone(tx);
  return result?.blob || null;
}

export async function putArtworkBlob(id, blob) {
  const db = await openDatabase();
  const tx = db.transaction('artwork', 'readwrite', { durability: 'relaxed' });
  tx.objectStore('artwork').put({ id, blob });
  await transactionDone(tx);
}

export async function getWaveform(id) {
  const db = await openDatabase();
  const tx = db.transaction('waveforms', 'readonly');
  const result = await requestToPromise(tx.objectStore('waveforms').get(id));
  await transactionDone(tx);
  if (!result?.samples) return null;
  return result.samples instanceof Uint16Array ? result.samples : new Uint16Array(result.samples);
}

export async function putWaveform(id, samples) {
  const db = await openDatabase();
  const tx = db.transaction('waveforms', 'readwrite', { durability: 'relaxed' });
  tx.objectStore('waveforms').put({ id, samples: samples instanceof Uint16Array ? samples : new Uint16Array(samples), generatedAt: Date.now() });
  await transactionDone(tx);
}

export async function deleteTrack(id) {
  const db = await openDatabase();
  const tx = db.transaction(['tracks', 'audio', 'artwork', 'waveforms'], 'readwrite');
  for (const storeName of ['tracks', 'audio', 'artwork', 'waveforms']) tx.objectStore(storeName).delete(id);
  await transactionDone(tx);
}

export async function clearLibrary() {
  const db = await openDatabase();
  const tx = db.transaction(['tracks', 'audio', 'artwork', 'waveforms', 'meta'], 'readwrite');
  for (const storeName of ['tracks', 'audio', 'artwork', 'waveforms', 'meta']) tx.objectStore(storeName).clear();
  await transactionDone(tx);
}

export async function getMeta(key, fallback = null) {
  const db = await openDatabase();
  const tx = db.transaction('meta', 'readonly');
  const result = await requestToPromise(tx.objectStore('meta').get(key));
  await transactionDone(tx);
  return result ? result.value : fallback;
}

export async function setMeta(key, value) {
  const db = await openDatabase();
  const tx = db.transaction('meta', 'readwrite', { durability: 'relaxed' });
  tx.objectStore('meta').put({ key, value, updatedAt: Date.now() });
  await transactionDone(tx);
}

export async function getDatabaseCounts() {
  const db = await openDatabase();
  const tx = db.transaction(['tracks', 'audio', 'artwork', 'waveforms'], 'readonly');
  const entries = await Promise.all(['tracks', 'audio', 'artwork', 'waveforms'].map(async (name) => [name, await requestToPromise(tx.objectStore(name).count())]));
  await transactionDone(tx);
  return Object.fromEntries(entries);
}
