import { clearMetaPrefix, getMeta, setMeta } from './db.js';
import { extractEmbeddedLyrics, id3TagLength } from './id3.js';

const KEY = (id) => `transcript:${id}`;
const SAMPLE_RATE = 16000;
const IDLE_TERMINATE_MS = 90_000;

async function decodeToMono16k(blob, signal) {
  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
  const OfflineClass = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!AudioContextClass || !OfflineClass) throw new Error('This browser cannot decode audio for transcription.');
  const context = new AudioContextClass();
  try {
    const buffer = await blob.arrayBuffer();
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const decoded = await context.decodeAudioData(buffer.slice(0));
    const length = Math.max(1, Math.ceil(decoded.duration * SAMPLE_RATE));
    const offline = new OfflineClass(1, length, SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0).slice();
  } finally {
    context.close?.().catch?.(() => {});
  }
}

/** Splits unsynchronised lyrics text into display lines (no timing). */
function linesFromText(text) {
  return text.split('\n').map((line) => line.trim()).filter((line, index, all) => line || (index > 0 && all[index - 1])).map((line) => ({ text: line }));
}

export class TranscriptManager extends EventTarget {
  constructor({ settings, getAudioBlob }) {
    super();
    this.settings = settings;
    this.getAudioBlob = getAudioBlob;
    this.worker = null;
    this.job = null;
    this.idleTimer = null;
  }

  get busyId() {
    return this.job?.id || null;
  }

  async get(id) {
    try {
      return await getMeta(KEY(id), null);
    } catch {
      return null;
    }
  }

  async save(id, transcript) {
    await setMeta(KEY(id), transcript);
    this.dispatchEvent(new CustomEvent('saved', { detail: { id, transcript } }));
  }

  async remove(id) {
    await setMeta(KEY(id), null);
    this.dispatchEvent(new CustomEvent('saved', { detail: { id, transcript: null } }));
  }

  async clearAll() {
    this.cancel();
    await clearMetaPrefix('transcript:');
    this.dispatchEvent(new CustomEvent('saved', { detail: { id: null, transcript: null } }));
  }

  /** Looks for lyrics stored in the MP3 file itself. Returns a transcript object or null. */
  async readEmbeddedLyrics(id) {
    const blob = await this.getAudioBlob(id);
    if (!blob) return null;
    const header = new Uint8Array(await blob.slice(0, 10).arrayBuffer());
    const length = id3TagLength(header);
    if (!length) return null;
    const bytes = new Uint8Array(await blob.slice(0, Math.min(length, 8 * 1024 * 1024)).arrayBuffer());
    const { text, synced } = extractEmbeddedLyrics(bytes);
    if (synced?.length) {
      const segments = synced.map((line, index) => ({ start: line.start, end: synced[index + 1]?.start ?? line.start + 4, text: line.text }));
      return { source: 'lyrics', synced: true, segments, createdAt: Date.now() };
    }
    if (text) return { source: 'lyrics', synced: false, segments: linesFromText(text), createdAt: Date.now() };
    return null;
  }

  async useEmbeddedLyrics(id) {
    const transcript = await this.readEmbeddedLyrics(id);
    if (transcript) await this.save(id, transcript);
    return transcript;
  }

  ensureWorker() {
    clearTimeout(this.idleTimer);
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./transcribe-worker.js', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (event) => this.handleWorkerMessage(event.data || {}));
    worker.addEventListener('error', (event) => {
      event.preventDefault?.();
      this.failJob(new Error('The transcription engine could not start. Check your connection for the first-time model download.'));
      this.terminateWorker();
    });
    this.worker = worker;
    return worker;
  }

  terminateWorker() {
    clearTimeout(this.idleTimer);
    this.worker?.terminate();
    this.worker = null;
  }

  scheduleIdleTerminate() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { if (!this.job) this.terminateWorker(); }, IDLE_TERMINATE_MS);
  }

  emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }

  handleWorkerMessage(message) {
    const job = this.job;
    if (!job) return;
    if (message.type === 'status') {
      this.emit('progress', { id: job.id, phase: message.phase || job.phase, message: message.message, fraction: job.fraction });
      if (message.phase) job.phase = message.phase;
    } else if (message.type === 'download') {
      this.emit('progress', { id: job.id, phase: 'model', message: `Downloading speech model (${Math.round((message.progress || 0) * 100)}%)`, fraction: message.progress || 0 });
    } else if (message.type === 'progress') {
      job.fraction = message.done / message.total;
      this.emit('progress', { id: job.id, phase: 'transcribe', message: `Transcribing… ${Math.round(job.fraction * 100)}%`, fraction: job.fraction, segments: message.segments });
    } else if (message.type === 'done') {
      this.finishJob(message.segments || []);
    } else if (message.type === 'error') {
      this.failJob(new Error(message.message || 'Transcription failed.'));
    }
  }

  async finishJob(segments) {
    const job = this.job;
    if (!job) return;
    this.job = null;
    const transcript = {
      source: 'whisper',
      synced: true,
      model: job.model,
      language: job.language,
      segments,
      createdAt: Date.now(),
    };
    try {
      await this.save(job.id, transcript);
    } catch (error) {
      job.reject(error);
      return;
    }
    this.scheduleIdleTerminate();
    job.resolve(transcript);
    this.emit('done', { id: job.id, transcript });
  }

  failJob(error) {
    const job = this.job;
    if (!job) return;
    this.job = null;
    this.scheduleIdleTerminate();
    job.reject(error);
    this.emit('failed', { id: job.id, message: error.message });
  }

  cancel() {
    const job = this.job;
    if (!job) return;
    this.job = null;
    job.controller.abort();
    this.worker?.postMessage({ type: 'cancel' });
    // Terminating is the only way to stop an in-flight inference; the model reloads from cache next time.
    this.terminateWorker();
    job.reject(new DOMException('Transcription cancelled.', 'AbortError'));
    this.emit('cancelled', { id: job.id });
  }

  async transcribe(id) {
    if (this.job) {
      if (this.job.id === id) return this.job.promise;
      throw new Error('Another song is already being transcribed.');
    }
    const controller = new AbortController();
    const job = {
      id,
      controller,
      phase: 'decode',
      fraction: 0,
      model: this.settings.get('transcribeModel'),
      language: this.settings.get('transcribeLanguage'),
    };
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    job.promise.catch(() => {});
    this.job = job;
    this.emit('progress', { id, phase: 'decode', message: 'Preparing audio…', fraction: 0 });
    try {
      const blob = await this.getAudioBlob(id);
      if (!blob) throw new Error('The stored audio for this song is missing.');
      const audio = await decodeToMono16k(blob, controller.signal);
      if (this.job !== job) return job.promise;
      const worker = this.ensureWorker();
      worker.postMessage({ type: 'transcribe', id, audio, model: job.model, language: job.language }, [audio.buffer]);
    } catch (error) {
      if (this.job === job) this.failJob(error);
    }
    return job.promise;
  }
}
