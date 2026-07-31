import { SettingsStore } from './settings.js';
import { LibraryManager } from './library-manager.js';
import { ArtworkCache } from './artwork.js';
import { WaveformRenderer } from './waveform.js';
import { AudioEngine } from './audio-engine.js';
import { AppUI } from './ui.js';
import { getMeta, setMeta } from './db.js';
import { debounce } from './utils.js';

const PLAYBACK_META_KEY = 'playback-state-v2';

function cleanSnapshot(snapshot, library) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const validIds = new Set(library.tracks.map((track) => track.id));
  const queue = Array.isArray(snapshot.queue) ? snapshot.queue.filter((id) => validIds.has(id)) : [];
  const baseQueue = Array.isArray(snapshot.baseQueue)
    ? snapshot.baseQueue.filter((id) => validIds.has(id))
    : [...queue];
  const currentId = validIds.has(snapshot.currentId) ? snapshot.currentId : queue[0] || null;
  const currentIndex = currentId ? queue.indexOf(currentId) : -1;
  return {
    ...snapshot,
    queue,
    baseQueue,
    currentId,
    queueIndex: currentIndex,
    playing: false,
  };
}

async function boot() {
  const settings = new SettingsStore();
  const library = new LibraryManager();
  const artwork = new ArtworkCache();
  const waveform = new WaveformRenderer(document.getElementById('waveformCanvas'), settings);
  const engine = new AudioEngine({
    primary: document.getElementById('audioPrimary'),
    standby: document.getElementById('audioStandby'),
    settings,
    getTrack: (id) => library.getTrack(id),
    getAudioBlob: (id) => library.getAudioBlob(id),
    getArtworkUrl: (id) => artwork.getUrl(id),
    updateDuration: (id, duration) => library.updateDuration(id, duration, true),
  });
  const ui = new AppUI({ library, engine, settings, artwork, waveform });

  let importController = null;
  let saving = false;

  const savePlayback = debounce(async () => {
    if (saving) return;
    saving = true;
    try {
      await setMeta(PLAYBACK_META_KEY, engine.snapshot());
    } catch (error) {
      console.warn('Could not save playback state:', error);
    } finally {
      saving = false;
    }
  }, 350);

  for (const eventName of ['trackchange', 'queuechange', 'modechange', 'volumechange', 'statechange']) {
    engine.addEventListener(eventName, savePlayback);
  }
  engine.addEventListener('timeupdate', debounce(savePlayback, 2500));
  ui.addEventListener('saveplayback', savePlayback);

  ui.addEventListener('importfile', async (event) => {
    if (importController) return;
    importController = new AbortController();
    try {
      if (navigator.storage?.persist) navigator.storage.persist().catch(() => false);
      const report = await library.importZip(event.detail.file, {
        signal: importController.signal,
        onProgress: (detail) => ui.updateImportProgress(detail),
      });
      ui.finishImport(report);
      savePlayback();
    } catch (error) {
      ui.finishImport(null, error);
    } finally {
      importController = null;
    }
  });

  ui.addEventListener('cancelimport', () => importController?.abort());

  ui.addEventListener('clearlibrary', async () => {
    importController?.abort();
    engine.pause();
    engine.destroy();
    artwork.clear();
    waveform.destroy();
    await library.clear();
    await setMeta(PLAYBACK_META_KEY, null).catch(() => {});
    location.reload();
  });

  window.addEventListener('pagehide', () => {
    setMeta(PLAYBACK_META_KEY, engine.snapshot()).catch(() => {});
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') setMeta(PLAYBACK_META_KEY, engine.snapshot()).catch(() => {});
  });

  window.addEventListener('unhandledrejection', (event) => {
    console.error(event.reason);
    const message = event.reason?.message || 'Something unexpected happened.';
    ui.toast('Sonora encountered a problem', message, 'error', 7000);
  });
  window.addEventListener('error', (event) => {
    console.error(event.error || event.message);
  });

  await library.load();

  try {
    const stored = cleanSnapshot(await getMeta(PLAYBACK_META_KEY, null), library);
    if (stored?.currentId) await engine.restore(stored);
  } catch (error) {
    console.warn('Could not restore playback state:', error);
  }

  ui.ready();

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('./service-worker.js').catch((error) => {
      console.warn('Offline support could not be enabled:', error);
    });
  }

  globalThis.sonora = { settings, library, artwork, waveform, engine, ui };
}

boot().catch((error) => {
  console.error(error);
  const app = document.getElementById('app');
  if (app) app.setAttribute('aria-busy', 'false');
  const overlay = document.getElementById('importOverlay');
  if (overlay) overlay.hidden = true;
  const region = document.getElementById('toastRegion');
  if (region) {
    const toast = document.createElement('div');
    toast.className = 'toast error';
    toast.innerHTML = '<span class="toast-copy"><strong>Sonora could not start</strong><small></small></span>';
    toast.querySelector('small').textContent = error?.message || 'Reload the page and try again.';
    region.append(toast);
  }
});
