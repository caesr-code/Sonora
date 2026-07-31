import { clamp } from './utils.js';

function waitForEvent(target, success, failure = 'error', timeout = 15000) {
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      target.removeEventListener(success, onSuccess);
      target.removeEventListener(failure, onFailure);
    };
    const onSuccess = () => { cleanup(); resolve(); };
    const onFailure = () => { cleanup(); reject(new Error('The audio file could not be loaded.')); };
    target.addEventListener(success, onSuccess, { once: true });
    target.addEventListener(failure, onFailure, { once: true });
    timer = setTimeout(() => { cleanup(); reject(new Error('The audio file took too long to load.')); }, timeout);
  });
}

function shuffled(items) {
  const output = [...items];
  for (let index = output.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [output[index], output[swap]] = [output[swap], output[index]];
  }
  return output;
}

export class AudioEngine extends EventTarget {
  constructor({ primary, standby, settings, getTrack, getAudioBlob, getArtworkUrl, updateDuration }) {
    super();
    this.primary = primary;
    this.standby = standby;
    this.active = primary;
    this.preloader = standby;
    this.settings = settings;
    this.getTrack = getTrack;
    this.getAudioBlob = getAudioBlob;
    this.getArtworkUrl = getArtworkUrl;
    this.updateDuration = updateDuration;
    this.currentId = null;
    this.queue = [];
    this.baseQueue = [];
    this.queueIndex = -1;
    this.shuffle = false;
    this.repeat = 'off';
    this.isLoading = false;
    this.preloadedId = null;
    this.urls = new Map();
    this.frame = null;
    this.lastPositionUpdate = 0;
    this.pendingLoadToken = 0;
    this.wasPlayingBeforeHide = false;
    this.userPaused = false;
    this.attachAudio(this.primary);
    this.attachAudio(this.standby);
    const initialVolume = settings.get('defaultVolume');
    this.volume = clamp(initialVolume, 0, 1);
    this.muted = false;
    this.applyVolume();
    this.bindSettings();
    this.configureMediaSession();
    this.bindHostShortcuts();
    document.addEventListener('visibilitychange', () => this.handleVisibility());
  }

  attachAudio(audio) {
    audio.playsInline = true;
    audio.preload = 'metadata';
    audio.addEventListener('play', () => {
      if (audio !== this.active) return;
      this.userPaused = false;
      this.startFrameLoop();
      this.updatePlaybackState();
      this.emitState();
    });
    audio.addEventListener('pause', () => {
      if (audio !== this.active) return;
      this.stopFrameLoop();
      this.updatePlaybackState();
      this.emitState();
    });
    audio.addEventListener('ended', () => {
      if (audio === this.active) this.handleEnded();
    });
    audio.addEventListener('loadedmetadata', () => {
      if (audio !== this.active) return;
      const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
      this.dispatchEvent(new CustomEvent('durationchange', { detail: { id: this.currentId, duration } }));
      if (duration > 0 && this.currentId) this.updateDuration?.(this.currentId, duration);
      this.updatePositionState(true);
    });
    audio.addEventListener('durationchange', () => {
      if (audio === this.active) this.updatePositionState(true);
    });
    audio.addEventListener('volumechange', () => {
      if (audio !== this.active) return;
      this.dispatchEvent(new CustomEvent('volumechange', { detail: { volume: this.volume, muted: this.muted } }));
    });
    audio.addEventListener('waiting', () => {
      if (audio === this.active) this.dispatchEvent(new CustomEvent('buffering', { detail: { buffering: true } }));
    });
    audio.addEventListener('playing', () => {
      if (audio === this.active) this.dispatchEvent(new CustomEvent('buffering', { detail: { buffering: false } }));
    });
    audio.addEventListener('error', () => {
      if (audio !== this.active) return;
      const mediaError = audio.error;
      const message = mediaError?.code === 3
        ? 'This MP3 could not be decoded.'
        : mediaError?.code === 2
          ? 'The audio data could not be read.'
          : 'This song could not be played.';
      this.dispatchEvent(new CustomEvent('error', { detail: { id: this.currentId, message } }));
    });
  }

  bindSettings() {
    this.settings.addEventListener('change', (event) => {
      const { key, value } = event.detail;
      if (key === 'defaultVolume' && !this.currentId) this.setVolume(value);
      if (key === 'mediaSession') this.configureMediaSession();
    });
  }

  bindHostShortcuts() {
    globalThis.sonoraHost?.onShortcut?.((action) => {
      if (action === 'play-pause') this.toggle();
      else if (action === 'next') this.next(true);
      else if (action === 'previous') this.previous();
      else if (action === 'seek-forward') this.seekBy(10);
      else if (action === 'seek-backward') this.seekBy(-10);
      else if (action === 'shuffle') this.toggleShuffle();
      else if (action === 'repeat') this.cycleRepeat();
      else if (action === 'mute') this.toggleMute();
    });
  }

  configureMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const enabled = this.settings.get('mediaSession');
    const set = (action, handler) => {
      try { navigator.mediaSession.setActionHandler(action, enabled ? handler : null); } catch { /* unsupported action */ }
    };
    set('play', () => this.play());
    set('pause', () => { this.userPaused = true; this.pause(); });
    set('previoustrack', () => this.previous());
    set('nexttrack', () => this.next(true));
    set('seekbackward', (details) => this.seekBy(-(details.seekOffset || 10)));
    set('seekforward', (details) => this.seekBy(details.seekOffset || 10));
    set('seekto', (details) => {
      if (!Number.isFinite(details.seekTime)) return;
      if (details.fastSeek && 'fastSeek' in this.active) this.active.fastSeek(details.seekTime);
      else this.seek(details.seekTime);
    });
    set('stop', () => { this.pause(); this.seek(0); });
  }

  async setQueue(ids, startId = ids[0] || null, { autoplay = true, preserveShuffle = true } = {}) {
    const unique = [...new Set(ids.filter(Boolean))];
    this.baseQueue = unique;
    this.queue = preserveShuffle && this.shuffle ? this.makeShuffledQueue(unique, startId) : [...unique];
    this.queueIndex = Math.max(0, this.queue.indexOf(startId));
    const id = this.queue[this.queueIndex] || null;
    this.emitQueue();
    if (id) await this.load(id, { autoplay });
  }

  makeShuffledQueue(ids, currentId = this.currentId) {
    if (!currentId || !ids.includes(currentId)) return shuffled(ids);
    return [currentId, ...shuffled(ids.filter((id) => id !== currentId))];
  }

  async load(id, { autoplay = false, position = 0, usePreloaded = true } = {}) {
    if (!id) return;
    if (id === this.currentId && this.active.src) {
      if (Number.isFinite(position) && position > 0) this.seek(position);
      if (autoplay) await this.play();
      return;
    }
    const token = ++this.pendingLoadToken;
    this.isLoading = true;
    this.dispatchEvent(new CustomEvent('loading', { detail: { id, loading: true } }));
    try {
      if (usePreloaded && id === this.preloadedId && this.preloader.readyState >= 1) {
        await this.activatePreloaded(id, { autoplay, position });
        return;
      }
      const track = await this.getTrack(id);
      if (!track) throw new Error('The selected song is no longer in your library.');
      const blob = await this.getAudioBlob(id);
      if (!blob) throw new Error('The stored audio for this song is missing.');
      if (token !== this.pendingLoadToken) return;
      this.active.pause();
      this.clearElement(this.active, this.currentId);
      const url = URL.createObjectURL(blob);
      this.urls.set(id, url);
      this.active.src = url;
      this.active.load();
      this.currentId = id;
      this.queueIndex = this.queue.indexOf(id);
      if (this.queueIndex < 0) {
        this.baseQueue = [id];
        this.queue = [id];
        this.queueIndex = 0;
      }
      this.dispatchEvent(new CustomEvent('trackchange', { detail: { id, track } }));
      this.emitQueue();
      this.updateMediaMetadata(track);
      if (this.active.readyState < 1) await waitForEvent(this.active, 'loadedmetadata');
      if (Number.isFinite(position) && position > 0) this.seek(position);
      if (autoplay) await this.play();
      this.preloadNext();
    } catch (error) {
      if (token === this.pendingLoadToken) this.dispatchEvent(new CustomEvent('error', { detail: { id, message: error.message || 'The song could not be loaded.' } }));
      throw error;
    } finally {
      if (token === this.pendingLoadToken) {
        this.isLoading = false;
        this.dispatchEvent(new CustomEvent('loading', { detail: { id, loading: false } }));
      }
    }
  }

  async activatePreloaded(id, { autoplay = true, position = 0 } = {}) {
    const oldActive = this.active;
    const oldId = this.currentId;
    this.active = this.preloader;
    this.preloader = oldActive;
    this.currentId = id;
    this.preloadedId = null;
    this.queueIndex = this.queue.indexOf(id);
    this.applyVolume();
    const track = await this.getTrack(id);
    this.dispatchEvent(new CustomEvent('trackchange', { detail: { id, track } }));
    this.emitQueue();
    this.updateMediaMetadata(track);
    if (position > 0) this.seek(position);
    if (autoplay) await this.play();
    this.clearElement(this.preloader, oldId);
    this.preloadNext();
  }

  clearElement(element, id) {
    element.pause();
    element.removeAttribute('src');
    element.load();
    if (id && this.urls.has(id)) {
      const url = this.urls.get(id);
      setTimeout(() => URL.revokeObjectURL(url), 500);
      this.urls.delete(id);
    }
  }

  async play() {
    if (!this.currentId) {
      if (this.queue.length) await this.load(this.queue[Math.max(0, this.queueIndex)], { autoplay: true });
      return;
    }
    try {
      await this.active.play();
    } catch (error) {
      const message = error?.name === 'NotAllowedError'
        ? 'Tap Play once to allow audio on this device.'
        : 'Playback could not start.';
      this.dispatchEvent(new CustomEvent('error', { detail: { id: this.currentId, message } }));
    }
  }

  pause() {
    this.active.pause();
  }

  toggle() {
    if (this.active.paused) return this.play();
    this.userPaused = true;
    this.pause();
  }

  seek(seconds) {
    if (!Number.isFinite(seconds) || !this.currentId) return;
    const duration = Number.isFinite(this.active.duration) ? this.active.duration : Infinity;
    this.active.currentTime = clamp(seconds, 0, duration);
    this.emitTime();
    this.updatePositionState(true);
  }

  seekFraction(fraction) {
    if (!Number.isFinite(this.active.duration) || this.active.duration <= 0) return;
    this.seek(this.active.duration * clamp(fraction, 0, 1));
  }

  seekBy(delta) {
    this.seek((this.active.currentTime || 0) + delta);
  }

  async previous() {
    if (this.active.currentTime > 4) {
      this.seek(0);
      return;
    }
    if (!this.queue.length) return;
    let index = this.queueIndex - 1;
    if (index < 0) index = this.repeat === 'all' ? this.queue.length - 1 : 0;
    await this.load(this.queue[index], { autoplay: true });
  }

  nextId({ manual = false } = {}) {
    if (!this.queue.length) return null;
    if (this.repeat === 'one' && !manual) return this.currentId;
    const nextIndex = this.queueIndex + 1;
    if (nextIndex < this.queue.length) return this.queue[nextIndex];
    if (this.repeat === 'all') return this.queue[0];
    return null;
  }

  async next(manual = false) {
    const id = this.nextId({ manual });
    if (!id) {
      this.pause();
      this.seek(0);
      this.dispatchEvent(new CustomEvent('queueended'));
      return;
    }
    if (id === this.currentId) {
      this.seek(0);
      await this.play();
      return;
    }
    await this.load(id, { autoplay: true, usePreloaded: true });
  }

  async handleEnded() {
    await this.next(false);
  }

  async preloadNext() {
    const id = this.nextId({ manual: true });
    if (!id || id === this.currentId) {
      this.clearElement(this.preloader, this.preloadedId);
      this.preloadedId = null;
      return;
    }
    if (id === this.preloadedId && this.preloader.src) return;
    try {
      this.clearElement(this.preloader, this.preloadedId);
      const blob = await this.getAudioBlob(id);
      if (!blob || id === this.currentId) return;
      const url = URL.createObjectURL(blob);
      this.urls.set(id, url);
      this.preloadedId = id;
      this.preloader.src = url;
      this.preloader.preload = 'auto';
      this.preloader.load();
      this.applyVolume();
    } catch {
      this.preloadedId = null;
    }
  }

  toggleShuffle(force) {
    this.shuffle = typeof force === 'boolean' ? force : !this.shuffle;
    if (this.shuffle) {
      this.queue = this.makeShuffledQueue(this.baseQueue.length ? this.baseQueue : this.queue, this.currentId);
      this.queueIndex = this.currentId ? this.queue.indexOf(this.currentId) : 0;
    } else {
      const source = this.baseQueue.length ? [...this.baseQueue] : [...this.queue];
      this.queue = source;
      this.queueIndex = this.currentId ? this.queue.indexOf(this.currentId) : 0;
      if (this.queueIndex < 0 && this.currentId) {
        this.queue.unshift(this.currentId);
        this.queueIndex = 0;
      }
    }
    this.emitQueue();
    this.preloadNext();
    this.dispatchEvent(new CustomEvent('modechange', { detail: { shuffle: this.shuffle, repeat: this.repeat } }));
    return this.shuffle;
  }

  cycleRepeat() {
    this.repeat = this.repeat === 'off' ? 'all' : this.repeat === 'all' ? 'one' : 'off';
    this.dispatchEvent(new CustomEvent('modechange', { detail: { shuffle: this.shuffle, repeat: this.repeat } }));
    this.preloadNext();
    return this.repeat;
  }

  setVolume(value) {
    this.volume = clamp(Number(value), 0, 1);
    if (this.volume > 0 && this.muted) this.muted = false;
    this.applyVolume();
    this.dispatchEvent(new CustomEvent('volumechange', { detail: { volume: this.volume, muted: this.muted } }));
  }

  toggleMute(force) {
    this.muted = typeof force === 'boolean' ? force : !this.muted;
    this.applyVolume();
    this.dispatchEvent(new CustomEvent('volumechange', { detail: { volume: this.volume, muted: this.muted } }));
    return this.muted;
  }

  applyVolume() {
    for (const audio of [this.primary, this.standby]) {
      audio.volume = this.volume;
      audio.muted = this.muted;
    }
  }

  reorderUpcoming(fromIndex, toIndex) {
    const upcomingStart = Math.max(0, this.queueIndex + 1);
    const from = upcomingStart + fromIndex;
    const to = upcomingStart + toIndex;
    if (from < upcomingStart || from >= this.queue.length || to < upcomingStart || to >= this.queue.length) return;
    const [item] = this.queue.splice(from, 1);
    this.queue.splice(to, 0, item);
    this.baseQueue = [...this.queue];
    this.emitQueue();
    this.preloadNext();
  }

  addToQueue(id, { next = false } = {}) {
    if (!id) return;
    if (!this.currentId) {
      this.baseQueue = [id];
      this.queue = [id];
      this.queueIndex = 0;
      this.load(id, { autoplay: false });
      return;
    }
    const insertion = next ? this.queueIndex + 1 : this.queue.length;
    this.queue.splice(insertion, 0, id);
    this.baseQueue = [...this.queue];
    this.emitQueue();
    this.preloadNext();
  }

  removeUpcoming(upcomingIndex) {
    const index = this.queueIndex + 1 + upcomingIndex;
    if (index <= this.queueIndex || index >= this.queue.length) return;
    this.queue.splice(index, 1);
    this.baseQueue = [...this.queue];
    this.emitQueue();
    this.preloadNext();
  }

  clearUpcoming() {
    if (this.queueIndex >= 0) this.queue = this.queue.slice(0, this.queueIndex + 1);
    else this.queue = [];
    this.baseQueue = [...this.queue];
    this.emitQueue();
    this.preloadNext();
  }

  emitQueue() {
    this.dispatchEvent(new CustomEvent('queuechange', {
      detail: {
        queue: [...this.queue],
        baseQueue: [...this.baseQueue],
        currentIndex: this.queueIndex,
        currentId: this.currentId,
        upcoming: this.queue.slice(this.queueIndex + 1),
      },
    }));
  }

  emitState() {
    this.dispatchEvent(new CustomEvent('statechange', {
      detail: {
        playing: !this.active.paused,
        paused: this.active.paused,
        currentId: this.currentId,
        loading: this.isLoading,
      },
    }));
  }

  emitTime() {
    const currentTime = Number.isFinite(this.active.currentTime) ? this.active.currentTime : 0;
    const duration = Number.isFinite(this.active.duration) ? this.active.duration : 0;
    this.dispatchEvent(new CustomEvent('timeupdate', { detail: { currentTime, duration, progress: duration > 0 ? currentTime / duration : 0 } }));
  }

  startFrameLoop() {
    this.stopFrameLoop();
    const tick = () => {
      this.emitTime();
      const now = performance.now();
      if (now - this.lastPositionUpdate > 900) {
        this.updatePositionState();
        this.lastPositionUpdate = now;
      }
      if (!this.active.paused) this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  stopFrameLoop() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.emitTime();
  }

  async updateMediaMetadata(track) {
    if (!track || !('mediaSession' in navigator) || !this.settings.get('mediaSession')) return;
    let artwork = [];
    try {
      const url = track.hasArtwork ? await this.getArtworkUrl(track.id) : null;
      if (url) artwork = [{ src: url, sizes: '512x512', type: 'image/jpeg' }];
    } catch { /* artwork is optional */ }
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist || 'Unknown Artist',
        album: track.album || 'Unknown Album',
        artwork,
      });
    } catch { /* unsupported metadata shape */ }
  }

  updatePlaybackState() {
    if ('mediaSession' in navigator && this.settings.get('mediaSession')) {
      try { navigator.mediaSession.playbackState = this.active.paused ? 'paused' : 'playing'; } catch { /* no-op */ }
    }
    globalThis.sonoraHost?.setPlaybackState?.({
      playing: !this.active.paused,
      title: this.currentId ? this.getTrack(this.currentId)?.title : '',
    });
  }

  updatePositionState(force = false) {
    if (!('mediaSession' in navigator) || !this.settings.get('mediaSession') || !navigator.mediaSession.setPositionState) return;
    const duration = this.active.duration;
    const position = this.active.currentTime;
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(position)) return;
    if (!force && document.visibilityState === 'hidden' && this.active.paused) return;
    try {
      navigator.mediaSession.setPositionState({ duration, position: clamp(position, 0, duration), playbackRate: this.active.playbackRate || 1 });
    } catch { /* state can reject during source changes */ }
  }

  handleVisibility() {
    if (document.visibilityState === 'hidden') {
      this.wasPlayingBeforeHide = !this.active.paused;
      if (!this.settings.get('backgroundPlayback') && this.wasPlayingBeforeHide) this.pause();
    } else if (!this.settings.get('backgroundPlayback') && this.wasPlayingBeforeHide && !this.userPaused) {
      this.play();
    }
  }

  snapshot() {
    return {
      currentId: this.currentId,
      currentTime: this.active.currentTime || 0,
      queue: [...this.queue],
      baseQueue: [...this.baseQueue],
      queueIndex: this.queueIndex,
      shuffle: this.shuffle,
      repeat: this.repeat,
      volume: this.volume,
      muted: this.muted,
      playing: !this.active.paused,
    };
  }

  async restore(snapshot) {
    if (!snapshot) return;
    this.shuffle = Boolean(snapshot.shuffle);
    this.repeat = ['off', 'all', 'one'].includes(snapshot.repeat) ? snapshot.repeat : 'off';
    this.volume = clamp(Number(snapshot.volume ?? this.settings.get('defaultVolume')), 0, 1);
    this.muted = Boolean(snapshot.muted);
    this.baseQueue = Array.isArray(snapshot.baseQueue) ? snapshot.baseQueue : Array.isArray(snapshot.queue) ? snapshot.queue : [];
    this.queue = Array.isArray(snapshot.queue) ? snapshot.queue : [...this.baseQueue];
    this.queueIndex = Number.isInteger(snapshot.queueIndex) ? snapshot.queueIndex : this.queue.indexOf(snapshot.currentId);
    this.applyVolume();
    this.emitQueue();
    this.dispatchEvent(new CustomEvent('modechange', { detail: { shuffle: this.shuffle, repeat: this.repeat } }));
    if (snapshot.currentId && this.queue.includes(snapshot.currentId)) {
      await this.load(snapshot.currentId, { autoplay: false, position: snapshot.currentTime || 0 });
    }
  }

  destroy() {
    this.stopFrameLoop();
    for (const [id, url] of this.urls) {
      URL.revokeObjectURL(url);
      this.urls.delete(id);
    }
    this.primary.pause();
    this.standby.pause();
  }
}
