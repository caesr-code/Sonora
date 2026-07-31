import { accentOptions } from './settings.js';
import { hydrateIcons, setIcon, svgIcon } from './icons.js';
import { VirtualList } from './virtual-list.js';
import { dominantColorFromImage, placeholderGradient } from './artwork.js';
import { formatBytes, formatLibraryDuration, formatTime, isEditableTarget, safeFileName, downloadBlob, debounce, clamp } from './utils.js';
import { getOrCreateWaveform } from './waveform.js';

const $ = (id) => document.getElementById(id);

export class AppUI extends EventTarget {
  constructor({ library, engine, settings, artwork, waveform }) {
    super();
    this.library = library;
    this.engine = engine;
    this.settings = settings;
    this.artwork = artwork;
    this.waveform = waveform;
    this.currentView = 'library';
    this.query = '';
    this.sort = settings.get('sort');
    this.filteredTracks = [];
    this.waveformAbort = null;
    this.importRequired = false;
    this.rowMenu = null;
    this.dragSource = null;
    this.touchDrag = null;
    this.currentTrack = null;
    this.bindElements();
    hydrateIcons();
    this.virtualList = new VirtualList({
      container: this.libraryList,
      spacer: this.librarySpacer,
      rows: this.libraryRows,
      renderItem: (track, index) => this.createSongRow(track, index),
      getRowHeight: () => window.innerWidth <= 600 ? 70 : 76,
    });
    this.buildAccentPicker();
    this.bindNavigation();
    this.bindLibraryControls();
    this.bindPlayerControls();
    this.bindQueueControls();
    this.bindSettingsControls();
    this.bindImportControls();
    this.bindKeyboard();
    this.bindArtworkGestures();
    this.bindEngine();
    this.bindLibrary();
    this.syncSettingsUI();
    this.setView(settings.get('lastView') || 'library', { animate: false });
  }

  bindElements() {
    const ids = [
      'app','viewTitle','viewSubtitle','mainNav','bottomNav','searchBox','searchInput','themeQuickButton','libraryList','librarySpacer','libraryRows','libraryEmpty','songCount','libraryDuration','sortSelect','playAllButton','importMoreButton','storageMeter','storageText','storageFill','queueBadge','playerTitle','playerArtist','playerAlbum','playingStatus','playingStatusDot','heroArtwork','heroArtworkImage','artworkGlow','waveformLoading','waveformCanvas','currentTime','remainingTime','fullDuration','shuffleButton','previousButton','playPauseButton','nextButton','repeatButton','repeatOneBadge','muteButton','volumeSlider','volumeValue','queueNowPlaying','queueList','queueEmpty','upNextCount','saveQueueButton','clearQueueButton','miniPlayer','miniTrackButton','miniArtwork','miniArtworkImage','miniTitle','miniArtist','miniPreviousButton','miniPlayPauseButton','miniNextButton','miniProgressFill','miniQueueButton','miniMuteButton','importOverlay','closeImportButton','dropZone','zipInput','importProgressOverlay','progressTitle','progressMessage','progressFill','progressPercent','progressCounts','cancelImportButton','confirmOverlay','confirmTitle','confirmMessage','confirmCancel','confirmAccept','shortcutsOverlay','closeShortcutsButton','keyboardHelpButton','toastRegion','themeSetting','accentPicker','animationSetting','reducedMotionSetting','waveformSetting','defaultVolumeSetting','defaultVolumeValue','backgroundSetting','mediaSessionSetting','highContrastSetting','textSizeSetting','requestPersistenceButton','persistenceStatus','shareAddress','copyShareButton','exportLibraryButton','clearLibraryButton'
    ];
    for (const id of ids) this[id] = $(id);
  }

  bindNavigation() {
    const navigate = (event) => {
      const button = event.target.closest('[data-view]');
      if (button) this.setView(button.dataset.view);
    };
    this.mainNav.addEventListener('click', navigate);
    this.bottomNav.addEventListener('click', navigate);
    this.miniTrackButton.addEventListener('click', () => this.setView('player'));
    this.miniQueueButton.addEventListener('click', () => this.setView('queue'));
    $('brandButton').addEventListener('click', () => this.setView('library'));
  }

  setView(view, { animate = true } = {}) {
    if (!['library', 'player', 'queue', 'settings'].includes(view)) return;
    this.currentView = view;
    this.settings.set('lastView', view, { silent: true });
    document.querySelectorAll('.view').forEach((section) => section.classList.toggle('active', section.dataset.view === view));
    document.querySelectorAll('[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
    const copy = {
      library: ['Library', 'Your imported music'],
      player: ['Now Playing', this.currentTrack ? `${this.currentTrack.artist} · ${this.currentTrack.album}` : 'Choose something to play'],
      queue: ['Queue', 'Your current playback order'],
      settings: ['Settings', 'Appearance, playback and storage'],
    }[view];
    this.viewTitle.textContent = copy[0];
    this.viewSubtitle.textContent = copy[1];
    this.searchBox.hidden = view !== 'library';
    if (!animate) {
      const section = document.querySelector(`.view[data-view="${view}"]`);
      section?.style.setProperty('animation', 'none');
      requestAnimationFrame(() => section?.style.removeProperty('animation'));
    }
    if (view === 'queue') this.renderQueue();
    if (view === 'settings') this.refreshStorageInfo();
  }

  bindLibraryControls() {
    const applyFilter = debounce(() => {
      this.query = this.searchInput.value;
      this.renderLibrary();
    }, 110);
    this.searchInput.addEventListener('input', applyFilter);
    this.sortSelect.value = this.sort;
    this.sortSelect.addEventListener('change', () => {
      this.sort = this.sortSelect.value;
      this.settings.set('sort', this.sort);
      this.renderLibrary();
    });
    this.playAllButton.addEventListener('click', async () => {
      if (!this.filteredTracks.length) return this.showImport({ required: !this.library.tracks.length });
      await this.engine.setQueue(this.filteredTracks.map((track) => track.id), this.filteredTracks[0].id, { autoplay: true });
      this.setView('player');
    });
    this.libraryList.addEventListener('keydown', (event) => {
      if (!this.filteredTracks.length) return;
      const current = this.filteredTracks.findIndex((track) => track.id === this.engine.currentId);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const next = clamp((current < 0 ? 0 : current) + (event.key === 'ArrowDown' ? 1 : -1), 0, this.filteredTracks.length - 1);
        const track = this.filteredTracks[next];
        this.virtualList.setSelected(track.id);
        this.virtualList.scrollToId(track.id);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const selected = this.libraryRows.querySelector('[aria-selected="true"]')?.dataset.id || this.engine.currentId || this.filteredTracks[0].id;
        this.playTrack(selected);
      }
    });
    document.addEventListener('click', (event) => {
      if (this.rowMenu && !this.rowMenu.contains(event.target) && !event.target.closest('.row-menu')) this.closeRowMenu();
    });
  }

  renderLibrary({ preserveScroll = true } = {}) {
    this.filteredTracks = this.library.filtered({ query: this.query, sort: this.sort });
    const summary = this.library.summary;
    this.songCount.textContent = `${summary.count.toLocaleString()} song${summary.count === 1 ? '' : 's'}`;
    this.libraryDuration.textContent = formatLibraryDuration(summary.duration);
    this.libraryEmpty.hidden = this.filteredTracks.length > 0;
    this.libraryList.hidden = this.filteredTracks.length === 0;
    this.virtualList.setItems(this.filteredTracks, { preserveScroll });
    this.virtualList.setSelected(this.engine.currentId);
    this.playAllButton.disabled = this.filteredTracks.length === 0;
    this.updateStorageMeter();
  }

  createSongRow(track, index) {
    const row = document.createElement('div');
    row.className = 'song-row';
    row.dataset.id = track.id;
    row.setAttribute('role', 'option');
    row.tabIndex = -1;
    const playing = track.id === this.engine.currentId;
    row.innerHTML = `
      <div class="song-artwork" style="background:${placeholderGradient(track.id)}">
        <img alt="" hidden loading="lazy">
        ${playing ? '<span class="playing-bars" aria-hidden="true"><span></span><span></span><span></span></span>' : ''}
      </div>
      <div class="song-main"><strong></strong><small></small></div>
      <div class="song-meta-cell artist-cell"><strong></strong><small>Artist</small></div>
      <div class="song-meta-cell album-cell"><strong></strong><small>Album</small></div>
      <div class="song-duration"></div>
      <button class="icon-button small row-menu" aria-label="More song options">${svgIcon('more')}</button>`;
    row.querySelector('.row-menu').setAttribute('aria-label', `More options for ${track.title}`);
    const [title, subtitle] = row.querySelector('.song-main').children;
    title.textContent = track.title;
    subtitle.textContent = playing ? (this.engine.active.paused ? 'Paused' : 'Now playing') : track.album;
    row.querySelector('.artist-cell strong').textContent = track.artist;
    row.querySelector('.album-cell strong').textContent = track.album;
    row.querySelector('.song-duration').textContent = track.duration ? formatTime(track.duration) : '—:—';
    const image = row.querySelector('img');
    this.artwork.applyToImage(image, track);
    row.addEventListener('click', (event) => {
      if (event.target.closest('.row-menu')) return;
      this.playTrack(track.id);
    });
    row.querySelector('.row-menu').addEventListener('click', (event) => {
      event.stopPropagation();
      this.openRowMenu(track, event.currentTarget);
    });
    return row;
  }

  async playTrack(id) {
    const ids = this.filteredTracks.length ? this.filteredTracks.map((track) => track.id) : this.library.tracks.map((track) => track.id);
    await this.engine.setQueue(ids, id, { autoplay: true });
    this.setView('player');
  }

  openRowMenu(track, anchor) {
    this.closeRowMenu();
    const menu = document.createElement('div');
    menu.className = 'row-menu-menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = `
      <button data-action="play">${svgIcon('play')}Play now</button>
      <button data-action="next">${svgIcon('addQueue')}Play next</button>
      <button data-action="queue">${svgIcon('queue')}Add to queue</button>
      <button data-action="remove" class="danger-text">${svgIcon('trash')}Remove from library</button>`;
    document.body.append(menu);
    const rect = anchor.getBoundingClientRect();
    const left = Math.min(window.innerWidth - 205, Math.max(8, rect.right - 190));
    const top = Math.min(window.innerHeight - 190, rect.bottom + 5);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-action]');
      if (!button) return;
      const action = button.dataset.action;
      this.closeRowMenu();
      if (action === 'play') this.playTrack(track.id);
      else if (action === 'next') { this.engine.addToQueue(track.id, { next: true }); this.toast('Added next', track.title); }
      else if (action === 'queue') { this.engine.addToQueue(track.id); this.toast('Added to queue', track.title); }
      else if (action === 'remove') {
        const ok = await this.confirm('Remove this song?', `“${track.title}” will be removed from Sonora on this device.`, 'Remove song');
        if (ok) {
          if (this.engine.currentId === track.id) await this.engine.next(true);
          await this.library.removeTrack(track.id);
          this.toast('Song removed', track.title);
        }
      }
    });
    this.rowMenu = menu;
  }

  closeRowMenu() {
    this.rowMenu?.remove();
    this.rowMenu = null;
  }

  bindPlayerControls() {
    this.playPauseButton.addEventListener('click', (event) => {
      this.ripple(event);
      this.engine.toggle();
    });
    this.previousButton.addEventListener('click', () => this.engine.previous());
    this.nextButton.addEventListener('click', () => this.engine.next(true));
    this.shuffleButton.addEventListener('click', () => this.engine.toggleShuffle());
    this.repeatButton.addEventListener('click', () => this.engine.cycleRepeat());
    this.muteButton.addEventListener('click', () => this.engine.toggleMute());
    this.volumeSlider.addEventListener('input', () => this.engine.setVolume(this.volumeSlider.value));
    this.miniPlayPauseButton.addEventListener('click', () => this.engine.toggle());
    this.miniPreviousButton.addEventListener('click', () => this.engine.previous());
    this.miniNextButton.addEventListener('click', () => this.engine.next(true));
    this.miniMuteButton.addEventListener('click', () => this.engine.toggleMute());
    this.waveform.addEventListener('seekfraction', (event) => this.engine.seekFraction(event.detail.fraction));
  }

  ripple(event) {
    const button = event.currentTarget;
    const ripple = button.querySelector('.ripple');
    if (!ripple) return;
    const rect = button.getBoundingClientRect();
    ripple.style.left = `${event.clientX - rect.left - 5}px`;
    ripple.style.top = `${event.clientY - rect.top - 5}px`;
    button.classList.remove('rippling');
    void button.offsetWidth;
    button.classList.add('rippling');
  }

  bindEngine() {
    this.engine.addEventListener('trackchange', (event) => this.updateCurrentTrack(event.detail.track));
    this.engine.addEventListener('statechange', (event) => this.updatePlaybackState(event.detail));
    this.engine.addEventListener('timeupdate', (event) => this.updateTime(event.detail));
    this.engine.addEventListener('volumechange', (event) => this.updateVolume(event.detail));
    this.engine.addEventListener('modechange', (event) => this.updateModes(event.detail));
    this.engine.addEventListener('queuechange', () => {
      this.renderQueue();
      this.queueBadge.hidden = this.engine.queue.length === 0;
      this.queueBadge.textContent = String(Math.max(0, this.engine.queue.length - this.engine.queueIndex - 1));
    });
    this.engine.addEventListener('loading', (event) => {
      if (event.detail.loading) this.playingStatus.textContent = 'Loading song';
    });
    this.engine.addEventListener('buffering', (event) => {
      if (event.detail.buffering) this.playingStatus.textContent = 'Buffering';
      else if (this.currentTrack) this.playingStatus.textContent = this.engine.active.paused ? 'Paused' : 'Now playing';
    });
    this.engine.addEventListener('error', (event) => this.toast('Playback problem', event.detail.message, 'error', 6500));
  }

  async updateCurrentTrack(track) {
    if (!track) return;
    this.currentTrack = track;
    this.playerTitle.textContent = track.title;
    this.playerArtist.textContent = track.artist;
    this.playerAlbum.textContent = track.album;
    this.miniTitle.textContent = track.title;
    this.miniArtist.textContent = track.artist;
    this.playingStatus.textContent = this.engine.active.paused ? 'Ready to play' : 'Now playing';
    this.heroArtwork.style.background = placeholderGradient(track.id);
    this.miniArtwork.style.background = placeholderGradient(track.id);
    this.heroArtwork.classList.add('placeholder');
    this.miniArtwork.classList.add('placeholder');
    const heroLoaded = await this.artwork.applyToImage(this.heroArtworkImage, track);
    await this.artwork.applyToImage(this.miniArtworkImage, track);
    this.heroArtwork.classList.toggle('placeholder', !heroLoaded);
    this.miniArtwork.classList.toggle('placeholder', this.miniArtworkImage.hidden);
    if (heroLoaded) {
      const colour = await dominantColorFromImage(this.heroArtworkImage);
      if (colour) this.artworkGlow.style.background = colour;
    } else {
      this.artworkGlow.style.background = this.settings.get('accent');
    }
    this.miniPlayer.hidden = false;
    document.body.classList.add('has-mini-player');
    this.virtualList.setSelected(track.id);
    this.renderLibrary({ preserveScroll: true });
    this.renderQueue();
    this.loadWaveform(track);
    if (this.currentView === 'player') this.viewSubtitle.textContent = `${track.artist} · ${track.album}`;
  }

  async loadWaveform(track) {
    this.waveformAbort?.abort();
    const controller = new AbortController();
    this.waveformAbort = controller;
    this.waveform.setSamples(null);
    this.waveformLoading.hidden = false;
    try {
      const blob = await this.library.getAudioBlob(track.id);
      const samples = await getOrCreateWaveform(track.id, blob, { signal: controller.signal, points: 960 });
      if (!controller.signal.aborted && this.currentTrack?.id === track.id) this.waveform.setSamples(samples);
    } catch (error) {
      if (error?.name !== 'AbortError') this.toast('Waveform unavailable', 'Playback still works, but this MP3 could not be analysed.', 'error');
    } finally {
      if (!controller.signal.aborted && this.currentTrack?.id === track.id) this.waveformLoading.hidden = true;
    }
  }

  updatePlaybackState({ playing }) {
    const icon = playing ? 'pause' : 'play';
    setIcon(this.playPauseButton, icon);
    this.playPauseButton.append(Object.assign(document.createElement('span'), { className: 'ripple' }));
    setIcon(this.miniPlayPauseButton, icon);
    this.playPauseButton.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    this.miniPlayPauseButton.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    this.playingStatus.textContent = this.currentTrack ? (playing ? 'Now playing' : 'Paused') : 'Nothing playing';
    this.playingStatusDot.classList.toggle('playing', playing);
    this.virtualList.lastRange = '';
    this.virtualList.render();
    this.renderQueue();
  }

  updateTime({ currentTime, duration, progress }) {
    this.currentTime.textContent = formatTime(currentTime);
    this.remainingTime.textContent = `−${formatTime(Math.max(0, duration - currentTime))}`;
    this.fullDuration.textContent = `Duration ${formatTime(duration)}`;
    this.waveform.setProgress(progress);
    this.miniProgressFill.style.width = `${clamp(progress * 100, 0, 100)}%`;
  }

  updateVolume({ volume, muted }) {
    const effective = muted ? 0 : volume;
    this.volumeSlider.value = String(volume);
    this.volumeSlider.style.setProperty('--range-value', `${volume * 100}%`);
    this.volumeValue.textContent = muted ? 'Muted' : `${Math.round(volume * 100)}%`;
    const icon = muted || effective === 0 ? 'mute' : effective < .45 ? 'volumeLow' : 'volume';
    setIcon(this.muteButton, icon);
    setIcon(this.miniMuteButton, icon);
  }

  updateModes({ shuffle, repeat }) {
    this.shuffleButton.classList.toggle('active', shuffle);
    this.shuffleButton.setAttribute('aria-pressed', String(shuffle));
    this.shuffleButton.setAttribute('aria-label', shuffle ? 'Shuffle on' : 'Shuffle off');
    this.repeatButton.classList.toggle('active', repeat !== 'off');
    this.repeatButton.setAttribute('aria-pressed', String(repeat !== 'off'));
    this.repeatButton.setAttribute('aria-label', repeat === 'one' ? 'Repeat one' : repeat === 'all' ? 'Repeat all' : 'Repeat off');
    this.repeatOneBadge.hidden = repeat !== 'one';
  }

  bindQueueControls() {
    this.clearQueueButton.addEventListener('click', async () => {
      if (!this.engine.snapshot().upcoming?.length && this.engine.queue.length <= this.engine.queueIndex + 1) return;
      const ok = await this.confirm('Clear upcoming songs?', 'The current song will keep playing, but everything after it will be removed from the queue.', 'Clear upcoming');
      if (ok) this.engine.clearUpcoming();
    });
    this.saveQueueButton.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('saveplayback'));
      this.toast('Queue saved', 'This playback order will be restored next time Sonora opens.');
    });
  }

  renderQueue() {
    const current = this.engine.currentId ? this.library.getTrack(this.engine.currentId) : null;
    if (current) {
      const playing = !this.engine.active.paused;
      this.queueNowPlaying.innerHTML = `
        <div class="queue-current">
          <div class="song-artwork" style="background:${placeholderGradient(current.id)}"><img alt="" hidden></div>
          <div><div class="eyebrow">${playing ? 'NOW PLAYING' : 'PAUSED'}</div><strong></strong><small></small></div>
          <span class="song-duration">${formatTime(this.engine.active.currentTime)} / ${formatTime(this.engine.active.duration || current.duration)}</span>
        </div>`;
      this.queueNowPlaying.querySelector('strong').textContent = current.title;
      this.queueNowPlaying.querySelector('small').textContent = `${current.artist} · ${current.album}`;
      this.artwork.applyToImage(this.queueNowPlaying.querySelector('img'), current);
    } else {
      this.queueNowPlaying.replaceChildren();
    }
    const upcomingIds = this.engine.queue.slice(this.engine.queueIndex + 1);
    this.upNextCount.textContent = `${upcomingIds.length} song${upcomingIds.length === 1 ? '' : 's'}`;
    this.queueEmpty.hidden = upcomingIds.length > 0;
    this.queueList.hidden = upcomingIds.length === 0;
    const fragment = document.createDocumentFragment();
    upcomingIds.forEach((id, index) => {
      const track = this.library.getTrack(id);
      if (!track) return;
      const item = document.createElement('div');
      item.className = 'queue-item';
      item.draggable = true;
      item.dataset.index = String(index);
      item.dataset.id = id;
      item.setAttribute('role', 'listitem');
      item.innerHTML = `
        <button class="drag-handle icon-button small" aria-label="Drag ${track.title} to reorder">${svgIcon('drag')}</button>
        <div class="song-artwork" style="background:${placeholderGradient(track.id)}"><img alt="" hidden></div>
        <div class="song-main"><strong></strong><small></small></div>
        <span class="queue-index">${index + 1}</span>
        <button class="icon-button small remove-queue" aria-label="Remove ${track.title} from queue">${svgIcon('close')}</button>`;
      item.querySelector('.song-main strong').textContent = track.title;
      item.querySelector('.song-main small').textContent = `${track.artist} · ${formatTime(track.duration)}`;
      this.artwork.applyToImage(item.querySelector('img'), track);
      item.querySelector('.song-main').addEventListener('click', () => this.engine.load(id, { autoplay: true }));
      item.querySelector('.remove-queue').addEventListener('click', () => this.engine.removeUpcoming(index));
      item.addEventListener('dragstart', (event) => {
        this.dragSource = index;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', String(index));
        requestAnimationFrame(() => item.classList.add('dragging'));
      });
      item.addEventListener('dragover', (event) => {
        event.preventDefault();
        item.classList.add('drag-over');
      });
      item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
      item.addEventListener('drop', (event) => {
        event.preventDefault();
        const from = Number(event.dataTransfer.getData('text/plain'));
        item.classList.remove('drag-over');
        if (Number.isInteger(from) && from !== index) this.engine.reorderUpcoming(from, index);
      });
      item.addEventListener('dragend', () => {
        this.dragSource = null;
        item.classList.remove('dragging');
        this.queueList.querySelectorAll('.drag-over').forEach((node) => node.classList.remove('drag-over'));
      });
      this.bindTouchQueueDrag(item, item.querySelector('.drag-handle'), index);
      fragment.append(item);
    });
    this.queueList.replaceChildren(fragment);
  }

  bindTouchQueueDrag(item, handle, index) {
    handle.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse') return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      const rect = item.getBoundingClientRect();
      const ghost = item.cloneNode(true);
      ghost.style.position = 'fixed';
      ghost.style.left = `${rect.left}px`;
      ghost.style.top = `${rect.top}px`;
      ghost.style.width = `${rect.width}px`;
      ghost.style.zIndex = '500';
      ghost.style.pointerEvents = 'none';
      ghost.style.opacity = '.92';
      ghost.style.boxShadow = '0 18px 50px rgba(0,0,0,.35)';
      document.body.append(ghost);
      item.classList.add('dragging');
      this.touchDrag = { from: index, to: index, ghost, offsetY: event.clientY - rect.top, pointerId: event.pointerId };
    });
    handle.addEventListener('pointermove', (event) => {
      if (!this.touchDrag || this.touchDrag.pointerId !== event.pointerId) return;
      event.preventDefault();
      this.touchDrag.ghost.style.top = `${event.clientY - this.touchDrag.offsetY}px`;
      this.touchDrag.ghost.style.left = `${event.clientX - this.touchDrag.ghost.offsetWidth / 2}px`;
      this.touchDrag.ghost.hidden = true;
      const under = document.elementFromPoint(event.clientX, event.clientY)?.closest('.queue-item');
      this.touchDrag.ghost.hidden = false;
      this.queueList.querySelectorAll('.drag-over').forEach((node) => node.classList.remove('drag-over'));
      if (under) {
        under.classList.add('drag-over');
        this.touchDrag.to = Number(under.dataset.index);
      }
    });
    const finish = (event) => {
      if (!this.touchDrag || this.touchDrag.pointerId !== event.pointerId) return;
      const { from, to, ghost } = this.touchDrag;
      ghost.remove();
      item.classList.remove('dragging');
      this.queueList.querySelectorAll('.drag-over').forEach((node) => node.classList.remove('drag-over'));
      this.touchDrag = null;
      if (from !== to) this.engine.reorderUpcoming(from, to);
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  }

  bindSettingsControls() {
    const set = (element, key, value = () => element.value) => element.addEventListener('change', () => this.settings.set(key, value()));
    set(this.themeSetting, 'theme');
    set(this.animationSetting, 'animation');
    set(this.reducedMotionSetting, 'reducedMotion', () => this.reducedMotionSetting.checked);
    set(this.waveformSetting, 'waveform');
    this.defaultVolumeSetting.addEventListener('input', () => {
      const value = Number(this.defaultVolumeSetting.value);
      this.settings.set('defaultVolume', value);
      this.defaultVolumeValue.textContent = `${Math.round(value * 100)}%`;
      this.defaultVolumeSetting.style.setProperty('--range-value', `${value * 100}%`);
    });
    set(this.backgroundSetting, 'backgroundPlayback', () => this.backgroundSetting.checked);
    set(this.mediaSessionSetting, 'mediaSession', () => this.mediaSessionSetting.checked);
    set(this.highContrastSetting, 'highContrast', () => this.highContrastSetting.checked);
    set(this.textSizeSetting, 'textSize');
    this.themeQuickButton.addEventListener('click', () => {
      const theme = this.settings.cycleTheme();
      this.syncSettingsUI();
      this.toast('Appearance changed', theme === 'system' ? 'Following your system appearance' : `${theme[0].toUpperCase()}${theme.slice(1)} mode`);
    });
    this.keyboardHelpButton.addEventListener('click', () => { this.shortcutsOverlay.hidden = false; });
    this.closeShortcutsButton.addEventListener('click', () => { this.shortcutsOverlay.hidden = true; });
    this.shortcutsOverlay.addEventListener('click', (event) => { if (event.target === this.shortcutsOverlay) this.shortcutsOverlay.hidden = true; });
    this.requestPersistenceButton.addEventListener('click', () => this.requestPersistence());
    this.copyShareButton.addEventListener('click', async () => {
      const url = this.copyShareButton.dataset.url;
      if (!url) return;
      await navigator.clipboard.writeText(url).catch(() => {});
      this.toast('Address copied', 'Open it in Safari on an iPad connected to the same Wi-Fi.');
    });
    this.exportLibraryButton.addEventListener('click', () => {
      const data = this.library.exportIndex(this.engine.snapshot());
      downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), safeFileName(`Sonora Library ${new Date().toISOString().slice(0,10)}.json`));
      this.toast('Library index exported', 'The JSON contains metadata only, not your MP3 files.');
    });
    this.clearLibraryButton.addEventListener('click', async () => {
      const ok = await this.confirm('Remove every imported song?', 'This permanently clears the music, artwork, waveforms and queue stored by Sonora on this device. Your original ZIP is not affected.', 'Remove all music');
      if (ok) this.dispatchEvent(new CustomEvent('clearlibrary'));
    });
    this.settings.addEventListener('change', () => this.syncSettingsUI());
  }

  buildAccentPicker() {
    const fragment = document.createDocumentFragment();
    accentOptions.forEach((option) => {
      const button = document.createElement('button');
      button.className = 'accent-swatch';
      button.type = 'button';
      button.style.background = option.value;
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-label', option.name);
      button.setAttribute('aria-checked', String(this.settings.get('accent') === option.value));
      button.addEventListener('click', () => this.settings.set('accent', option.value));
      fragment.append(button);
    });
    this.accentPicker.replaceChildren(fragment);
  }

  syncSettingsUI() {
    this.themeSetting.value = this.settings.get('theme');
    this.animationSetting.value = this.settings.get('animation');
    this.reducedMotionSetting.checked = this.settings.get('reducedMotion');
    this.waveformSetting.value = this.settings.get('waveform');
    this.defaultVolumeSetting.value = String(this.settings.get('defaultVolume'));
    this.defaultVolumeValue.textContent = `${Math.round(this.settings.get('defaultVolume') * 100)}%`;
    this.defaultVolumeSetting.style.setProperty('--range-value', `${this.settings.get('defaultVolume') * 100}%`);
    this.backgroundSetting.checked = this.settings.get('backgroundPlayback');
    this.mediaSessionSetting.checked = this.settings.get('mediaSession');
    this.highContrastSetting.checked = this.settings.get('highContrast');
    this.textSizeSetting.value = this.settings.get('textSize');
    this.accentPicker.querySelectorAll('.accent-swatch').forEach((button, index) => button.setAttribute('aria-checked', String(accentOptions[index].value === this.settings.get('accent'))));
    this.waveform.draw();
  }

  bindImportControls() {
    const choose = () => this.zipInput.click();
    this.dropZone.addEventListener('click', choose);
    this.importMoreButton.addEventListener('click', () => this.showImport({ required: false }));
    document.querySelectorAll('[data-action="import"]').forEach((button) => button.addEventListener('click', () => this.showImport({ required: !this.library.tracks.length })));
    this.zipInput.addEventListener('change', () => {
      const file = this.zipInput.files?.[0];
      this.zipInput.value = '';
      if (file) this.submitImport(file);
    });
    for (const eventName of ['dragenter', 'dragover']) {
      this.dropZone.addEventListener(eventName, (event) => { event.preventDefault(); this.dropZone.classList.add('drag-over'); });
    }
    for (const eventName of ['dragleave', 'drop']) {
      this.dropZone.addEventListener(eventName, (event) => { event.preventDefault(); this.dropZone.classList.remove('drag-over'); });
    }
    this.dropZone.addEventListener('drop', (event) => {
      const file = [...event.dataTransfer.files].find((item) => item.name.toLowerCase().endsWith('.zip'));
      if (file) this.submitImport(file);
      else this.toast('ZIP archive required', 'Drop one .zip file containing MP3 songs.', 'error');
    });
    document.addEventListener('dragover', (event) => event.preventDefault());
    document.addEventListener('drop', (event) => {
      if (!this.importOverlay.hidden) return;
      event.preventDefault();
      const file = [...event.dataTransfer.files].find((item) => item.name.toLowerCase().endsWith('.zip'));
      if (file) { this.showImport({ required: false }); this.submitImport(file); }
    });
    this.closeImportButton.addEventListener('click', () => {
      if (!this.importRequired) this.importOverlay.hidden = true;
    });
    this.importOverlay.addEventListener('click', (event) => {
      if (event.target === this.importOverlay && !this.importRequired) this.importOverlay.hidden = true;
    });
    this.cancelImportButton.addEventListener('click', () => this.dispatchEvent(new CustomEvent('cancelimport')));
  }

  showImport({ required = false } = {}) {
    this.importRequired = required;
    this.closeImportButton.hidden = required;
    this.importOverlay.hidden = false;
  }

  submitImport(file) {
    this.importOverlay.hidden = true;
    this.importProgressOverlay.hidden = false;
    this.updateImportProgress({ phase: 'scan', current: 0, total: 1, name: file.name });
    this.dispatchEvent(new CustomEvent('importfile', { detail: { file } }));
  }

  updateImportProgress(detail) {
    const phase = detail.phase;
    let title = 'Reading your archive';
    let message = detail.name ? `Scanning ${detail.name.split('/').pop()}…` : 'Finding MP3 files…';
    let percent = 0;
    if (phase === 'scan') percent = detail.total ? detail.current / detail.total * 12 : 4;
    else if (phase === 'found') { title = 'MP3 files found'; message = `${detail.total.toLocaleString()} song${detail.total === 1 ? '' : 's'} ready to import`; percent = 12; }
    else if (phase === 'extract' || phase === 'import') {
      title = 'Importing your music';
      message = detail.name ? `Reading ${detail.name.split('/').pop()}…` : 'Reading metadata and artwork…';
      percent = 12 + (detail.total ? detail.current / detail.total * 68 : 0);
    } else if (phase === 'duration') {
      title = 'Finishing your library';
      message = 'Checking accurate song durations…';
      percent = 80 + (detail.total ? detail.current / detail.total * 20 : 0);
    }
    this.progressTitle.textContent = title;
    this.progressMessage.textContent = message;
    this.progressFill.style.width = `${clamp(percent, 0, 100)}%`;
    this.progressPercent.textContent = `${Math.round(percent)}%`;
    const imported = detail.imported || 0;
    const duplicates = detail.duplicates || 0;
    this.progressCounts.textContent = duplicates ? `${imported} imported · ${duplicates} duplicate${duplicates === 1 ? '' : 's'}` : `${imported} song${imported === 1 ? '' : 's'} imported`;
  }

  finishImport(report, error = null) {
    this.importProgressOverlay.hidden = true;
    if (error) {
      this.toast(error.name === 'AbortError' ? 'Import cancelled' : 'Import failed', error.name === 'AbortError' ? 'No further songs were added.' : error.message, error.name === 'AbortError' ? 'info' : 'error', 7000);
      if (!this.library.tracks.length) this.showImport({ required: true });
      return;
    }
    const parts = [`${report.imported} imported`];
    if (report.duplicates) parts.push(`${report.duplicates} duplicate${report.duplicates === 1 ? '' : 's'} skipped`);
    if (report.corrupt || report.failed) parts.push(`${report.corrupt + report.failed} problem file${report.corrupt + report.failed === 1 ? '' : 's'}`);
    this.toast('Library ready', parts.join(' · '), report.corrupt || report.failed ? 'info' : 'success', 8000);
    if (report.imported && !this.engine.currentId) {
      const first = this.library.getTrack(report.ids[0]);
      if (first) this.engine.setQueue(report.ids, first.id, { autoplay: false });
    }
  }

  bindKeyboard() {
    document.addEventListener('keydown', (event) => {
      if (!this.shortcutsOverlay.hidden && event.key === 'Escape') { this.shortcutsOverlay.hidden = true; return; }
      if (!this.importOverlay.hidden && event.key === 'Escape' && !this.importRequired) { this.importOverlay.hidden = true; return; }
      if (isEditableTarget(event.target)) {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
          event.preventDefault(); this.searchInput.focus(); this.searchInput.select();
        }
        return;
      }
      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && key === 'k') {
        event.preventDefault(); this.setView('library'); this.searchInput.focus(); this.searchInput.select();
      } else if (event.code === 'Space') { event.preventDefault(); this.engine.toggle(); }
      else if ((event.metaKey || event.ctrlKey) && event.key === 'ArrowRight') { event.preventDefault(); this.engine.next(true); }
      else if ((event.metaKey || event.ctrlKey) && event.key === 'ArrowLeft') { event.preventDefault(); this.engine.previous(); }
      else if (event.altKey && event.key === 'ArrowRight') { event.preventDefault(); this.engine.seekBy(10); }
      else if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); this.engine.seekBy(-10); }
      else if (key === 's') { event.preventDefault(); this.engine.toggleShuffle(); }
      else if (key === 'r') { event.preventDefault(); this.engine.cycleRepeat(); }
      else if (key === 'm') { event.preventDefault(); this.engine.toggleMute(); }
      else if (key === 'j') { event.preventDefault(); this.engine.seekBy(-10); }
      else if (key === 'l') { event.preventDefault(); this.engine.seekBy(10); }
    });
  }

  bindArtworkGestures() {
    let start = null;
    this.heroArtwork.addEventListener('pointerdown', (event) => {
      start = { x: event.clientX, y: event.clientY, time: performance.now(), id: event.pointerId };
      this.heroArtwork.setPointerCapture(event.pointerId);
    });
    this.heroArtwork.addEventListener('pointerup', (event) => {
      if (!start || start.id !== event.pointerId) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      const elapsed = performance.now() - start.time;
      start = null;
      if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.25) {
        if (dx < 0) this.engine.next(true); else this.engine.previous();
      } else if (Math.abs(dx) < 12 && Math.abs(dy) < 12 && elapsed < 450) {
        this.engine.toggle();
      }
    });
    this.heroArtwork.addEventListener('pointercancel', () => { start = null; });
  }

  bindLibrary() {
    this.library.addEventListener('change', () => this.renderLibrary({ preserveScroll: true }));
    this.library.addEventListener('trackadded', () => {
      this.renderLibrary({ preserveScroll: true });
      if (this.importRequired && this.library.tracks.length) this.importRequired = false;
    });
    this.library.addEventListener('trackupdated', () => {
      this.renderLibrary({ preserveScroll: true });
      if (this.currentTrack?.id) this.currentTrack = this.library.getTrack(this.currentTrack.id);
    });
  }

  async refreshStorageInfo() {
    await this.updateStorageMeter();
    if (navigator.storage?.persisted) {
      const persisted = await navigator.storage.persisted().catch(() => false);
      this.persistenceStatus.textContent = persisted ? 'Protected from automatic browser cleanup where supported' : 'May be cleared by the browser when storage is low';
      this.requestPersistenceButton.hidden = persisted;
    } else {
      this.persistenceStatus.textContent = 'Persistent storage requests are not supported here';
      this.requestPersistenceButton.hidden = true;
    }
    if (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
      const url = new URL('./', location.href).href;
      this.shareAddress.textContent = url.replace(/\/$/, '');
      this.copyShareButton.disabled = false;
      this.copyShareButton.dataset.url = url;
    } else {
      this.shareAddress.textContent = 'Publish Sonora with GitHub Pages to get an iPad-ready link';
      this.copyShareButton.disabled = true;
      delete this.copyShareButton.dataset.url;
    }
  }

  async updateStorageMeter() {
    if (!navigator.storage?.estimate) return;
    try {
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      const percent = quota ? usage / quota * 100 : 0;
      this.storageMeter.hidden = false;
      this.storageText.textContent = `${formatBytes(usage)} / ${formatBytes(quota)}`;
      this.storageFill.style.width = `${clamp(percent, 0, 100)}%`;
    } catch { this.storageMeter.hidden = true; }
  }

  async requestPersistence() {
    if (!navigator.storage?.persist) return;
    const granted = await navigator.storage.persist().catch(() => false);
    this.toast(granted ? 'Persistent storage enabled' : 'Persistent storage not granted', granted ? 'Sonora’s local library is less likely to be automatically removed.' : 'Keep the original ZIP so you can re-import if the browser clears storage.', granted ? 'success' : 'info', 7000);
    this.refreshStorageInfo();
  }

  async confirm(title, message, actionLabel = 'Continue') {
    this.confirmTitle.textContent = title;
    this.confirmMessage.textContent = message;
    this.confirmAccept.textContent = actionLabel;
    this.confirmOverlay.hidden = false;
    return new Promise((resolve) => {
      const finish = (value) => {
        this.confirmOverlay.hidden = true;
        this.confirmCancel.removeEventListener('click', cancel);
        this.confirmAccept.removeEventListener('click', accept);
        resolve(value);
      };
      const cancel = () => finish(false);
      const accept = () => finish(true);
      this.confirmCancel.addEventListener('click', cancel);
      this.confirmAccept.addEventListener('click', accept);
      this.confirmAccept.focus();
    });
  }

  toast(title, message, type = 'info', duration = 4500) {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `${svgIcon(type === 'error' ? 'error' : type === 'success' ? 'check' : 'info')}<span class="toast-copy"><strong></strong><small></small></span>`;
    toast.querySelector('strong').textContent = title;
    toast.querySelector('small').textContent = message;
    this.toastRegion.append(toast);
    setTimeout(() => {
      toast.classList.add('out');
      setTimeout(() => toast.remove(), 250);
    }, duration);
  }

  ready() {
    this.app.setAttribute('aria-busy', 'false');
    this.renderLibrary({ preserveScroll: false });
    this.updateVolume({ volume: this.engine.volume, muted: this.engine.muted });
    this.updateModes({ shuffle: this.engine.shuffle, repeat: this.engine.repeat });
    if (!this.library.tracks.length) this.showImport({ required: true });
    this.refreshStorageInfo();
  }
}
