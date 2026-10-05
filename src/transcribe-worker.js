// Runs Whisper speech recognition off the main thread.
// The model is downloaded once from the jsDelivr / Hugging Face CDNs and then cached by the browser.
// Your audio never leaves the device: only the model files are downloaded.

const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';
const MODELS = {
  tiny: 'Xenova/whisper-tiny',
  base: 'Xenova/whisper-base',
};
const SAMPLE_RATE = 16000;
const CHUNK_SECONDS = 30;

let library = null;
let loaded = { key: '', transcriber: null };
let cancelled = false;

async function loadLibrary() {
  if (library) return library;
  post({ type: 'status', message: 'Loading speech engine…' });
  library = await import(TRANSFORMERS_URL);
  library.env.allowLocalModels = false;
  library.env.useBrowserCache = true;
  return library;
}

function post(message) {
  self.postMessage(message);
}

async function getTranscriber(model) {
  const key = model;
  if (loaded.transcriber && loaded.key === key) return loaded.transcriber;
  const { pipeline } = await loadLibrary();
  const files = new Map();
  post({ type: 'status', message: 'Preparing the speech model…', phase: 'model' });
  const transcriber = await pipeline('automatic-speech-recognition', MODELS[model] || MODELS.tiny, {
    dtype: 'q8',
    device: 'wasm',
    progress_callback: (info) => {
      if (info.status === 'progress' && info.file) {
        files.set(info.file, { loaded: info.loaded || 0, total: info.total || 0 });
        let loadedBytes = 0;
        let totalBytes = 0;
        for (const item of files.values()) { loadedBytes += item.loaded; totalBytes += item.total; }
        post({ type: 'download', progress: totalBytes ? loadedBytes / totalBytes : 0, loaded: loadedBytes, total: totalBytes });
      } else if (info.status === 'ready') {
        post({ type: 'status', message: 'Speech model ready', phase: 'model' });
      }
    },
  });
  loaded = { key, transcriber };
  return transcriber;
}

const SOUND_TAG = /^[\[(*♪♫\s-]*(music|musique|música|singing|instrumental|applause|silence|blank_audio|noise|laughter|inaudible|no speech)[\])*♪♫\s-]*$/i;
const ONLY_SYMBOLS = /^[\s♪♫.,!?…-]*$/;

function cleanSegments(segments) {
  const output = [];
  let repeats = 0;
  for (const segment of segments) {
    const text = String(segment.text || '').replace(/\s+/g, ' ').trim();
    if (!text || SOUND_TAG.test(text) || ONLY_SYMBOLS.test(text)) continue;
    const previous = output[output.length - 1];
    if (previous && previous.text.toLowerCase() === text.toLowerCase()) {
      repeats += 1;
      if (repeats >= 2) continue; // Whisper sometimes loops on instrumental passages
    } else {
      repeats = 0;
    }
    output.push({ start: segment.start, end: segment.end, text });
  }
  return output;
}

async function transcribe({ id, audio, model, language }) {
  cancelled = false;
  const transcriber = await getTranscriber(model);
  if (cancelled) return;
  const total = Math.max(1, Math.ceil(audio.length / (SAMPLE_RATE * CHUNK_SECONDS)));
  const all = [];
  post({ type: 'status', message: 'Listening to the song…', phase: 'transcribe' });
  for (let index = 0; index < total; index += 1) {
    if (cancelled) return;
    const startSample = index * SAMPLE_RATE * CHUNK_SECONDS;
    const endSample = Math.min(audio.length, startSample + SAMPLE_RATE * CHUNK_SECONDS);
    const chunk = audio.subarray(startSample, endSample);
    const offset = startSample / SAMPLE_RATE;
    const chunkSeconds = chunk.length / SAMPLE_RATE;
    if (chunkSeconds < 0.5) continue;
    const options = { return_timestamps: true, task: 'transcribe', chunk_length_s: CHUNK_SECONDS };
    if (language && language !== 'auto') options.language = language;
    const result = await transcriber(chunk, options);
    const pieces = Array.isArray(result?.chunks) && result.chunks.length
      ? result.chunks
      : [{ text: result?.text || '', timestamp: [0, chunkSeconds] }];
    for (const piece of pieces) {
      const [from, to] = piece.timestamp || [0, chunkSeconds];
      const start = offset + (Number.isFinite(from) ? from : 0);
      const end = offset + (Number.isFinite(to) ? to : chunkSeconds);
      all.push({ start, end: Math.max(end, start + 0.5), text: piece.text });
    }
    post({ type: 'progress', id, done: index + 1, total, segments: cleanSegments(all) });
  }
  if (!cancelled) post({ type: 'done', id, segments: cleanSegments(all) });
}

self.addEventListener('message', async (event) => {
  const message = event.data || {};
  if (message.type === 'cancel') {
    cancelled = true;
    return;
  }
  if (message.type !== 'transcribe') return;
  try {
    await transcribe(message);
  } catch (error) {
    post({ type: 'error', id: message.id, message: error?.message || String(error) });
  }
});
