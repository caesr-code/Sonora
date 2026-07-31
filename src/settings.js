import { clamp, hexToRgb } from './utils.js';

const STORAGE_KEY = 'sonora.settings.v2';

export const accentOptions = [
  { name: 'Violet', value: '#8b7cff', strong: '#6f5cff' },
  { name: 'Ocean', value: '#3ea6ff', strong: '#1689e8' },
  { name: 'Mint', value: '#41cfa0', strong: '#1ebc88' },
  { name: 'Rose', value: '#ef6f9e', strong: '#d94f83' },
  { name: 'Amber', value: '#e9a43a', strong: '#d98b18' },
  { name: 'Crimson', value: '#ef646f', strong: '#dc4554' },
];

export const defaultSettings = Object.freeze({
  theme: 'system',
  accent: '#8b7cff',
  animation: 'normal',
  reducedMotion: globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false,
  waveform: 'bars',
  backgroundPlayback: true,
  mediaSession: true,
  defaultVolume: 0.82,
  highContrast: false,
  textSize: 'normal',
  lastView: 'library',
  sort: 'added-desc',
});

export class SettingsStore extends EventTarget {
  constructor() {
    super();
    this.value = this.load();
    this.apply();
  }

  load() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      return this.validate({ ...defaultSettings, ...stored });
    } catch {
      return { ...defaultSettings };
    }
  }

  validate(input) {
    const themes = ['system', 'dark', 'light'];
    const animations = ['slow', 'normal', 'fast'];
    const waveforms = ['bars', 'mirror', 'line'];
    const textSizes = ['normal', 'large', 'xlarge'];
    const views = ['library', 'player', 'queue', 'settings'];
    const sorts = ['added-desc', 'title-asc', 'artist-asc', 'album-asc', 'duration-desc'];
    return {
      theme: themes.includes(input.theme) ? input.theme : defaultSettings.theme,
      accent: accentOptions.some((item) => item.value === input.accent) ? input.accent : defaultSettings.accent,
      animation: animations.includes(input.animation) ? input.animation : defaultSettings.animation,
      reducedMotion: Boolean(input.reducedMotion),
      waveform: waveforms.includes(input.waveform) ? input.waveform : defaultSettings.waveform,
      backgroundPlayback: input.backgroundPlayback !== false,
      mediaSession: input.mediaSession !== false,
      defaultVolume: clamp(Number(input.defaultVolume), 0, 1),
      highContrast: Boolean(input.highContrast),
      textSize: textSizes.includes(input.textSize) ? input.textSize : defaultSettings.textSize,
      lastView: views.includes(input.lastView) ? input.lastView : defaultSettings.lastView,
      sort: sorts.includes(input.sort) ? input.sort : defaultSettings.sort,
    };
  }

  get(key) {
    return this.value[key];
  }

  set(key, value, { silent = false } = {}) {
    const next = this.validate({ ...this.value, [key]: value });
    const previous = this.value[key];
    this.value = next;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.value));
    this.apply();
    if (!silent && previous !== this.value[key]) {
      this.dispatchEvent(new CustomEvent('change', { detail: { key, value: this.value[key], settings: { ...this.value } } }));
    }
    return this.value[key];
  }

  patch(values, { silent = false } = {}) {
    const previous = this.value;
    this.value = this.validate({ ...this.value, ...values });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.value));
    this.apply();
    if (!silent) this.dispatchEvent(new CustomEvent('change', { detail: { key: null, value: null, previous, settings: { ...this.value } } }));
  }

  apply() {
    const root = document.documentElement;
    root.dataset.theme = this.value.theme;
    root.dataset.animation = this.value.animation;
    root.dataset.reducedMotion = String(this.value.reducedMotion);
    root.dataset.waveform = this.value.waveform;
    root.dataset.contrast = this.value.highContrast ? 'high' : 'normal';
    root.dataset.textSize = this.value.textSize;
    const option = accentOptions.find((item) => item.value === this.value.accent) || accentOptions[0];
    const rgb = hexToRgb(option.value);
    root.style.setProperty('--accent', option.value);
    root.style.setProperty('--accent-strong', option.strong);
    root.style.setProperty('--accent-rgb', `${rgb.r}, ${rgb.g}, ${rgb.b}`);
    const themeColor = this.resolvedTheme() === 'light' ? '#f4f3f8' : '#0d0d12';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themeColor);
  }

  resolvedTheme() {
    if (this.value.theme !== 'system') return this.value.theme;
    return globalThis.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  cycleTheme() {
    const order = ['system', 'dark', 'light'];
    const current = order.indexOf(this.value.theme);
    return this.set('theme', order[(current + 1) % order.length]);
  }
}
