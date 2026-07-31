import {
  clearLibrary as clearDatabase,
  deleteTrack as deleteTrackFromDatabase,
  getAllTracks,
  getAudioBlob,
  getArtworkBlob,
  getTrack as getTrackFromDatabase,
  putImportedTrack,
  updateTrack,
} from './db.js';
import { parseMp3Metadata } from './id3.js';
import { iterateMp3Files } from './zip-reader.js';
import { formatLibraryDuration, makeId, normalizedSongKey, sha256Hex, titleFromFilename } from './utils.js';

function looksLikeMp3(bytes, start = 0) {
  if (bytes.length < 4) return false;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true;
  const end = Math.min(bytes.length - 1, Math.max(start + 65536, 65536));
  for (let index = Math.max(0, start); index < end; index += 1) {
    if (bytes[index] === 0xff && (bytes[index + 1] & 0xe0) === 0xe0) {
      const versionBits = (bytes[index + 1] >> 3) & 0x03;
      const layerBits = (bytes[index + 1] >> 1) & 0x03;
      const bitrateIndex = (bytes[index + 2] >> 4) & 0x0f;
      const sampleRateIndex = (bytes[index + 2] >> 2) & 0x03;
      if (versionBits !== 1 && layerBits !== 0 && bitrateIndex > 0 && bitrateIndex < 15 && sampleRateIndex < 3) return true;
    }
  }
  return false;
}

function parseMpegHeader(bytes, start = 0) {
  const bitrateV1L3 = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0];
  const bitrateV2L3 = [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,0];
  const rates = {
    3: [44100, 48000, 32000],
    2: [22050, 24000, 16000],
    0: [11025, 12000, 8000],
  };
  const end = Math.min(bytes.length - 4, start + 256 * 1024);
  for (let offset = Math.max(0, start); offset < end; offset += 1) {
    if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) continue;
    const versionBits = (bytes[offset + 1] >> 3) & 3;
    const layerBits = (bytes[offset + 1] >> 1) & 3;
    if (versionBits === 1 || layerBits !== 1) continue;
    const bitrateIndex = (bytes[offset + 2] >> 4) & 15;
    const sampleRateIndex = (bytes[offset + 2] >> 2) & 3;
    if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) continue;
    const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
    const bitrate = (version === 1 ? bitrateV1L3 : bitrateV2L3)[bitrateIndex];
    const sampleRate = rates[versionBits][sampleRateIndex];
    const padding = (bytes[offset + 2] >> 1) & 1;
    const channelMode = (bytes[offset + 3] >> 6) & 3;
    const frameLength = Math.floor((version === 1 ? 144000 : 72000) * bitrate / sampleRate + padding);
    return { offset, version, bitrate, sampleRate, padding, channelMode, frameLength, samplesPerFrame: version === 1 ? 1152 : 576 };
  }
  return null;
}

function readAscii(bytes, offset, length) {
  let value = '';
  for (let i = 0; i < length && offset + i < bytes.length; i += 1) value += String.fromCharCode(bytes[offset + i]);
  return value;
}

function readUint32BE(bytes, offset) {
  return ((bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0;
}

function estimateMp3Duration(bytes, audioStart = 0) {
  const header = parseMpegHeader(bytes, audioStart);
  if (!header) return 0;
  const sideInfo = header.version === 1
    ? (header.channelMode === 3 ? 17 : 32)
    : (header.channelMode === 3 ? 9 : 17);
  const xingOffset = header.offset + 4 + sideInfo;
  const marker = readAscii(bytes, xingOffset, 4);
  if ((marker === 'Xing' || marker === 'Info') && xingOffset + 12 <= bytes.length) {
    const flags = readUint32BE(bytes, xingOffset + 4);
    if (flags & 0x01) {
      const frameCount = readUint32BE(bytes, xingOffset + 8);
      if (frameCount > 0) return frameCount * header.samplesPerFrame / header.sampleRate;
    }
  }
  const vbriOffset = header.offset + 36;
  if (readAscii(bytes, vbriOffset, 4) === 'VBRI' && vbriOffset + 18 <= bytes.length) {
    const frames = readUint32BE(bytes, vbriOffset + 14);
    if (frames > 0) return frames * header.samplesPerFrame / header.sampleRate;
  }
  const audioBytes = Math.max(0, bytes.length - header.offset);
  return audioBytes * 8 / (header.bitrate * 1000);
}

async function exactAudioDuration(blob, signal, timeoutMs = 16000) {
  if (signal?.aborted) throw new DOMException('Duration scan cancelled.', 'AbortError');
  return new Promise((resolve, reject) => {
    const audio = document.createElement('audio');
    const url = URL.createObjectURL(blob);
    let settled = false;
    let infinityAttempted = false;
    const cleanup = () => {
      clearTimeout(timer);
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(url);
    };
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const read = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        finish(audio.duration);
      } else if (audio.duration === Infinity && !infinityAttempted) {
        infinityAttempted = true;
        audio.currentTime = 1e101;
      }
    };
    const onAbort = () => finish(0, new DOMException('Duration scan cancelled.', 'AbortError'));
    audio.preload = 'metadata';
    audio.addEventListener('loadedmetadata', read);
    audio.addEventListener('durationchange', read);
    audio.addEventListener('timeupdate', () => {
      if (infinityAttempted && Number.isFinite(audio.duration)) {
        audio.currentTime = 0;
        read();
      }
    });
    audio.addEventListener('error', () => finish(0, new Error('The MP3 metadata could not be loaded.')));
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => finish(0, new Error('Duration scan timed out.')), timeoutMs);
    audio.src = url;
    audio.load();
  });
}

async function runPool(items, concurrency, worker, signal, onProgress) {
  let cursor = 0;
  let completed = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      if (signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
      const index = cursor;
      cursor += 1;
      await worker(items[index], index);
      completed += 1;
      onProgress?.(completed, items.length);
    }
  });
  await Promise.all(runners);
}

export class LibraryManager extends EventTarget {
  constructor() {
    super();
    this.tracks = [];
    this.byId = new Map();
    this.hashes = new Set();
    this.loaded = false;
  }

  async load() {
    const tracks = await getAllTracks();
    this.tracks = tracks.map((track) => this.normaliseTrack(track));
    this.reindex();
    this.loaded = true;
    this.emitChange('load');
    return this.tracks;
  }

  normaliseTrack(track) {
    return {
      ...track,
      title: track.title || titleFromFilename(track.filename),
      artist: track.artist || 'Unknown Artist',
      album: track.album || 'Unknown Album',
      duration: Number(track.duration) || 0,
      titleSort: String(track.title || '').toLocaleLowerCase(),
      artistSort: String(track.artist || '').toLocaleLowerCase(),
      albumSort: String(track.album || '').toLocaleLowerCase(),
    };
  }

  reindex() {
    this.byId = new Map(this.tracks.map((track) => [track.id, track]));
    this.hashes = new Set(this.tracks.map((track) => track.hash).filter(Boolean));
  }

  getTrack(id) {
    return this.byId.get(id) || null;
  }

  async getTrackFresh(id) {
    return getTrackFromDatabase(id);
  }

  async getAudioBlob(id) {
    return getAudioBlob(id);
  }

  async getArtworkBlob(id) {
    return getArtworkBlob(id);
  }

  get totalDuration() {
    return this.tracks.reduce((sum, track) => sum + (Number(track.duration) || 0), 0);
  }

  get summary() {
    return {
      count: this.tracks.length,
      duration: this.totalDuration,
      durationLabel: formatLibraryDuration(this.totalDuration),
      bytes: this.tracks.reduce((sum, track) => sum + (Number(track.size) || 0), 0),
    };
  }

  filtered({ query = '', sort = 'added-desc' } = {}) {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
    const source = tokens.length
      ? this.tracks.filter((track) => {
        const haystack = `${track.title}\n${track.artist}\n${track.album}\n${track.filename}`.toLocaleLowerCase();
        return tokens.every((token) => haystack.includes(token));
      })
      : [...this.tracks];
    const compareText = (a, b, key) => a[key].localeCompare(b[key], undefined, { numeric: true, sensitivity: 'base' });
    source.sort((a, b) => {
      if (sort === 'title-asc') return compareText(a, b, 'title');
      if (sort === 'artist-asc') return compareText(a, b, 'artist') || compareText(a, b, 'title');
      if (sort === 'album-asc') return compareText(a, b, 'album') || compareText(a, b, 'trackNumber');
      if (sort === 'duration-desc') return (b.duration || 0) - (a.duration || 0) || compareText(a, b, 'title');
      return (b.addedAt || 0) - (a.addedAt || 0);
    });
    return source;
  }

  async importZip(file, { signal, onProgress } = {}) {
    const lowerName = String(file?.name || '').toLowerCase();
    if (!file || (!lowerName.endsWith('.zip') && file.type && !/zip/i.test(file.type))) {
      throw new Error('Choose a ZIP archive containing MP3 files.');
    }
    const report = {
      imported: 0,
      duplicates: 0,
      corrupt: 0,
      failed: 0,
      ignored: 0,
      errors: [],
      ids: [],
    };
    let found = 0;
    let processed = 0;
    const durationCandidates = [];
    const progress = (detail) => {
      if (detail.phase === 'found') found = detail.total;
      if (detail.phase === 'extract') processed = detail.current;
      onProgress?.({ ...detail, found, processed, imported: report.imported, duplicates: report.duplicates, corrupt: report.corrupt });
    };

    for await (const entry of iterateMp3Files(file, { signal, onProgress: progress })) {
      if (signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
      if (entry.error || !entry.bytes) {
        report.failed += 1;
        report.errors.push({ file: entry.name, message: entry.error?.message || 'The file could not be extracted.' });
        continue;
      }
      const bytes = entry.bytes;
      let metadata;
      try {
        metadata = parseMp3Metadata(bytes, entry.name);
      } catch (error) {
        metadata = {
          title: titleFromFilename(entry.name), artist: 'Unknown Artist', album: 'Unknown Album', artworkBlob: null,
          hasArtwork: false, audioStart: 0,
        };
        report.errors.push({ file: entry.name, message: `Metadata could not be read: ${error.message}` });
      }
      if (!looksLikeMp3(bytes, metadata.audioStart)) {
        report.corrupt += 1;
        report.errors.push({ file: entry.name, message: 'The file does not contain recognisable MP3 audio.' });
        continue;
      }
      let hash;
      try {
        hash = await sha256Hex(bytes);
      } catch (error) {
        report.failed += 1;
        report.errors.push({ file: entry.name, message: `Duplicate check failed: ${error.message}` });
        continue;
      }
      if (this.hashes.has(hash)) {
        report.duplicates += 1;
        continue;
      }
      const id = makeId();
      const estimatedDuration = estimateMp3Duration(bytes, metadata.audioStart);
      const now = Date.now();
      const track = this.normaliseTrack({
        id,
        hash,
        filename: entry.name.split('/').pop(),
        sourcePath: entry.name,
        title: metadata.title || titleFromFilename(entry.name),
        artist: metadata.artist || 'Unknown Artist',
        album: metadata.album || 'Unknown Album',
        albumArtist: metadata.albumArtist || '',
        composer: metadata.composer || '',
        genre: metadata.genre || '',
        year: metadata.year || '',
        trackNumber: metadata.trackNumber || '',
        discNumber: metadata.discNumber || '',
        duration: Number.isFinite(estimatedDuration) ? estimatedDuration : 0,
        durationExact: false,
        size: bytes.length,
        mimeType: 'audio/mpeg',
        hasArtwork: Boolean(metadata.artworkBlob),
        addedAt: now + report.imported,
        updatedAt: now,
        normalizedKey: normalizedSongKey({ ...metadata, size: bytes.length }),
      });
      try {
        const audioBlob = new Blob([bytes], { type: 'audio/mpeg' });
        await putImportedTrack(track, audioBlob, metadata.artworkBlob);
        this.tracks.push(track);
        this.byId.set(track.id, track);
        this.hashes.add(hash);
        report.imported += 1;
        report.ids.push(id);
        durationCandidates.push(id);
        this.dispatchEvent(new CustomEvent('trackadded', { detail: { track, report: { ...report } } }));
      } catch (error) {
        if (error?.name === 'ConstraintError') report.duplicates += 1;
        else {
          report.failed += 1;
          report.errors.push({ file: entry.name, message: error.message || 'The song could not be stored.' });
        }
      }
      processed += 1;
      onProgress?.({ phase: 'import', current: processed, total: Math.max(found, processed), found, processed, imported: report.imported, duplicates: report.duplicates, corrupt: report.corrupt, name: entry.name });
    }

    if (found === 0 && report.failed === 0) throw new Error('No MP3 files were found in this ZIP archive.');
    this.emitChange('import-metadata');

    if (durationCandidates.length) {
      const concurrency = matchMedia('(pointer: coarse)').matches ? 2 : 4;
      await runPool(durationCandidates, concurrency, async (id) => {
        if (signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
        await this.resolveDuration(id, signal);
      }, signal, (current, total) => {
        onProgress?.({ phase: 'duration', current, total, imported: report.imported, duplicates: report.duplicates, corrupt: report.corrupt });
      });
    }

    this.emitChange('import-complete');
    return report;
  }

  async resolveDuration(id, signal) {
    const track = this.getTrack(id);
    if (!track || track.durationExact) return track?.duration || 0;
    const blob = await getAudioBlob(id);
    if (!blob) return track.duration || 0;
    let duration = 0;
    try {
      duration = await exactAudioDuration(blob, signal);
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      duration = track.duration || 0;
    }
    if (duration > 0) await this.updateDuration(id, duration, true);
    return duration;
  }

  async updateDuration(id, duration, exact = true) {
    const track = this.getTrack(id);
    if (!track || !Number.isFinite(duration) || duration <= 0) return;
    if (track.durationExact && Math.abs(track.duration - duration) < 0.25) return;
    const updated = this.normaliseTrack({ ...track, duration, durationExact: exact, updatedAt: Date.now() });
    this.byId.set(id, updated);
    const index = this.tracks.findIndex((item) => item.id === id);
    if (index >= 0) this.tracks[index] = updated;
    await updateTrack(updated);
    this.dispatchEvent(new CustomEvent('trackupdated', { detail: { track: updated } }));
  }

  async removeTrack(id) {
    const track = this.getTrack(id);
    if (!track) return;
    await deleteTrackFromDatabase(id);
    this.tracks = this.tracks.filter((item) => item.id !== id);
    this.byId.delete(id);
    if (track.hash) this.hashes.delete(track.hash);
    this.emitChange('remove');
  }

  async clear() {
    await clearDatabase();
    this.tracks = [];
    this.byId.clear();
    this.hashes.clear();
    this.emitChange('clear');
  }

  exportIndex(queueSnapshot = null) {
    return {
      application: 'Sonora',
      version: 2,
      exportedAt: new Date().toISOString(),
      note: 'This index contains metadata only. It does not contain MP3 audio or album artwork.',
      summary: this.summary,
      tracks: this.tracks.map(({ hash, normalizedKey, titleSort, artistSort, albumSort, ...track }) => track),
      playback: queueSnapshot,
    };
  }

  emitChange(reason) {
    this.dispatchEvent(new CustomEvent('change', { detail: { reason, tracks: this.tracks, summary: this.summary } }));
  }
}
