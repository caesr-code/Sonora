import { formatTime } from './utils.js';

const $ = (id) => document.getElementById(id);

/** Transcript panel under the Now Playing controls, with synced highlighting and click-to-seek. */
export class TranscriptUI {
  constructor({ manager, engine, settings, ui }) {
    this.manager = manager;
    this.engine = engine;
    this.settings = settings;
    this.ui = ui;
    this.card = $('transcriptCard');
    this.body = $('transcriptBody');
    this.sourceLabel = $('transcriptSource');
    this.runButton = $('transcriptRunButton');
    this.runLabel = $('transcriptRunLabel');
    this.cancelButton = $('transcriptCancelButton');
    this.lyricsButton = $('transcriptLyricsButton');
    this.copyButton = $('transcriptCopyButton');
    this.progress = $('transcriptProgress');
    this.progressFill = $('transcriptProgressFill');
    this.progressText = $('transcriptProgressText');
    this.trackId = null;
    this.transcript = null;
    this.hasFileLyrics = false;
    this.activeIndex = -1;
    this.lineElements = [];
    this.userScrollUntil = 0;
    this.renderToken = 0;
    this.bindSettings();
    this.bind();
  }

  bindSettings() {
    const auto = $('transcribeAutoSetting');
    const model = $('transcribeModelSetting');
    const language = $('transcribeLanguageSetting');
    const sync = () => {
      auto.checked = this.settings.get('transcribeAuto');
      model.value = this.settings.get('transcribeModel');
      language.value = this.settings.get('transcribeLanguage');
    };
    sync();
    auto.addEventListener('change', () => this.settings.set('transcribeAuto', auto.checked));
    model.addEventListener('change', () => this.settings.set('transcribeModel', model.value));
    language.addEventListener('change', () => this.settings.set('transcribeLanguage', language.value));
    this.settings.addEventListener('change', sync);
    $('clearTranscriptsButton').addEventListener('click', async () => {
      const ok = await this.ui.confirm('Delete all transcripts?', 'Saved transcripts and lyrics copies are removed from this device. Your songs are not affected.', 'Delete transcripts');
      if (!ok) return;
      await this.manager.clearAll();
      this.ui.toast('Transcripts deleted', 'You can transcribe songs again any time.');
      if (this.trackId) this.showTrack(this.trackId);
    });
  }

  bind() {
    this.runButton.addEventListener('click', () => this.run());
    this.cancelButton.addEventListener('click', () => this.manager.cancel());
    this.lyricsButton.addEventListener('click', async () => {
      if (!this.trackId) return;
      const found = await this.manager.useEmbeddedLyrics(this.trackId);
      if (!found) this.ui.toast('No lyrics in this file', 'Choose Transcribe to generate them instead.');
    });
    this.copyButton.addEventListener('click', async () => {
      const text = (this.transcript?.segments || []).map((segment) => segment.text).join('\n');
      await navigator.clipboard?.writeText(text).catch(() => {});
      this.ui.toast('Transcript copied', 'The text is on your clipboard.', 'success', 2800);
    });
    this.body.addEventListener('click', (event) => {
      const line = event.target.closest('button.tl-line');
      if (!line) return;
      this.engine.seek(Number(line.dataset.start));
      if (this.engine.active.paused) this.engine.play();
    });
    for (const eventName of ['wheel', 'touchmove']) {
      this.body.addEventListener(eventName, () => { this.userScrollUntil = Date.now() + 4000; }, { passive: true });
    }

    this.engine.addEventListener('trackchange', (event) => this.showTrack(event.detail.id));
    this.engine.addEventListener('timeupdate', (event) => this.sync(event.detail.currentTime));

    this.manager.addEventListener('progress', (event) => this.onProgress(event.detail));
    this.manager.addEventListener('saved', (event) => {
      if (event.detail.id === this.trackId) this.setTranscript(event.detail.transcript);
    });
    this.manager.addEventListener('done', (event) => {
      if (event.detail.id === this.trackId) this.ui.toast('Transcript ready', 'Lines highlight as the song plays. Tap a line to jump to it.', 'success', 4200);
      this.updateControls();
    });
    this.manager.addEventListener('failed', (event) => {
      this.ui.toast('Transcription failed', event.detail.message, 'error', 8000);
      this.updateControls();
    });
    this.manager.addEventListener('cancelled', () => { this.progress.hidden = true; this.updateControls(); });
    this.settings.addEventListener('change', () => this.updateControls());
  }

  async showTrack(id) {
    if (!id) return;
    const token = ++this.renderToken;
    this.trackId = id;
    this.transcript = null;
    this.activeIndex = -1;
    this.renderTranscript();
    const [saved, fileLyrics] = await Promise.all([
      this.manager.get(id),
      this.manager.readEmbeddedLyrics(id).catch(() => null),
    ]);
    if (token !== this.renderToken) return;
    this.hasFileLyrics = Boolean(fileLyrics);
    if (saved?.segments?.length || saved?.source) {
      this.setTranscript(saved);
    } else if (fileLyrics) {
      // Lyrics that already exist in the MP3 are shown straight away, and saved so they work offline.
      await this.manager.save(id, fileLyrics).catch(() => {});
      if (token === this.renderToken) this.setTranscript(fileLyrics);
    } else {
      this.setTranscript(null);
      if (this.settings.get('transcribeAuto') && !this.manager.busyId) this.run({ automatic: true });
    }
  }

  setTranscript(transcript) {
    this.transcript = transcript;
    this.activeIndex = -1;
    this.renderTranscript();
    this.updateControls();
    this.sync(this.engine.active.currentTime || 0);
  }

  renderTranscript(partial = null) {
    const segments = partial || this.transcript?.segments || [];
    this.body.replaceChildren();
    this.lineElements = [];
    if (!segments.length) {
      const empty = document.createElement('p');
      empty.className = 'transcript-empty';
      if (this.manager.busyId === this.trackId) empty.textContent = 'Transcribing… lines appear here as they are recognised.';
      else if (this.transcript && !segments.length) empty.textContent = 'No lyrics were detected. This song may be instrumental, or the vocals were too quiet to recognise.';
      else empty.textContent = 'Choose Transcribe to turn the vocals into text. Everything is processed on this device.';
      this.body.append(empty);
      return;
    }
    const synced = partial ? true : this.transcript?.synced !== false;
    const fragment = document.createDocumentFragment();
    segments.forEach((segment) => {
      if (!segment.text) {
        const gap = document.createElement('div');
        gap.className = 'tl-gap';
        fragment.append(gap);
        return;
      }
      const line = document.createElement(synced ? 'button' : 'div');
      line.className = `tl-line${synced ? '' : ' plain'}`;
      if (synced) {
        line.type = 'button';
        line.dataset.start = String(segment.start);
        line.dataset.end = String(segment.end);
        const time = document.createElement('time');
        time.textContent = formatTime(segment.start);
        line.append(time);
      }
      const text = document.createElement('span');
      text.textContent = segment.text;
      line.append(text);
      fragment.append(line);
      if (synced) this.lineElements.push({ element: line, start: segment.start, end: segment.end });
    });
    this.body.append(fragment);
  }

  sync(currentTime) {
    if (!this.lineElements.length || !this.transcript?.synced) return;
    let index = -1;
    for (let i = 0; i < this.lineElements.length; i += 1) {
      if (this.lineElements[i].start <= currentTime + 0.15) index = i;
      else break;
    }
    if (index === this.activeIndex) return;
    this.activeIndex = index;
    this.lineElements.forEach((item, i) => {
      item.element.classList.toggle('active', i === index);
      item.element.classList.toggle('past', i < index);
    });
    if (index >= 0 && Date.now() > this.userScrollUntil) {
      const element = this.lineElements[index].element;
      const target = element.offsetTop - this.body.clientHeight / 2 + element.clientHeight / 2;
      this.body.scrollTo({ top: Math.max(0, target) });
    }
  }

  onProgress({ id, message, fraction, segments, phase }) {
    if (id !== this.trackId) {
      this.progress.hidden = true;
      return;
    }
    this.progress.hidden = false;
    this.progressText.textContent = message;
    this.progressFill.style.width = `${Math.round(Math.max(0.03, fraction || 0) * 100)}%`;
    if (segments && phase === 'transcribe') this.renderTranscript(segments);
    this.updateControls();
  }

  updateControls() {
    const busy = this.manager.busyId;
    const busyHere = busy && busy === this.trackId;
    const has = Boolean(this.transcript?.segments?.length);
    this.runButton.hidden = Boolean(busyHere);
    this.cancelButton.hidden = !busyHere;
    this.runButton.disabled = Boolean(busy && !busyHere) || !this.trackId;
    this.runLabel.textContent = has ? 'Re-transcribe' : 'Transcribe';
    this.copyButton.hidden = !has;
    this.lyricsButton.hidden = !(this.hasFileLyrics && this.transcript?.source === 'whisper');
    if (!busyHere) this.progress.hidden = true;
    let source = 'Not transcribed yet';
    if (busyHere) source = 'Working on this song…';
    else if (busy) source = 'Another song is being transcribed';
    else if (this.transcript?.source === 'lyrics') source = this.transcript.synced ? 'Synced lyrics from the file' : 'Lyrics from the file';
    else if (this.transcript?.source === 'whisper') source = `Transcribed on this device · Whisper ${this.transcript.model === 'base' ? 'Base' : 'Tiny'}`;
    this.sourceLabel.textContent = source;
  }

  async run({ automatic = false } = {}) {
    if (!this.trackId || this.manager.busyId) return;
    const id = this.trackId;
    this.progress.hidden = false;
    this.progressFill.style.width = '3%';
    this.progressText.textContent = 'Preparing audio…';
    const job = this.manager.transcribe(id);
    this.renderTranscript([]);
    this.updateControls();
    try {
      await job;
    } catch (error) {
      if (error?.name === 'AbortError') {
        if (id === this.trackId) this.setTranscript(await this.manager.get(id));
        return;
      }
      if (!automatic) console.warn(error);
      if (id === this.trackId) this.setTranscript(await this.manager.get(id));
    }
  }
}
