import { clamp } from './utils.js';
import { getWaveform, putWaveform } from './db.js';

export async function generateWaveform(blob, { points = 960, signal } = {}) {
  if (!blob) throw new Error('Audio data is unavailable.');
  if (signal?.aborted) throw new DOMException('Waveform cancelled.', 'AbortError');
  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContextClass) throw new Error('This browser cannot analyse audio waveforms.');
  const context = new AudioContextClass({ latencyHint: 'playback' });
  try {
    const buffer = await blob.arrayBuffer();
    if (signal?.aborted) throw new DOMException('Waveform cancelled.', 'AbortError');
    const audioBuffer = await context.decodeAudioData(buffer.slice(0));
    if (!audioBuffer.length) throw new Error('The MP3 contains no decodable audio.');
    const output = new Float32Array(points);
    const channels = [];
    for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) channels.push(audioBuffer.getChannelData(channel));
    const blockSize = Math.max(1, Math.floor(audioBuffer.length / points));
    for (let point = 0; point < points; point += 1) {
      const start = point * blockSize;
      const end = point === points - 1 ? audioBuffer.length : Math.min(audioBuffer.length, start + blockSize);
      let sumSquares = 0;
      let peak = 0;
      let count = 0;
      const stride = Math.max(1, Math.floor((end - start) / 280));
      for (let sample = start; sample < end; sample += stride) {
        let value = 0;
        for (const channel of channels) value += Math.abs(channel[sample] || 0);
        value /= channels.length;
        peak = Math.max(peak, value);
        sumSquares += value * value;
        count += 1;
      }
      const rms = count ? Math.sqrt(sumSquares / count) : 0;
      output[point] = peak * 0.62 + rms * 0.38;
      if (signal?.aborted) throw new DOMException('Waveform cancelled.', 'AbortError');
      if (point % 80 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const sorted = [...output].sort((a, b) => a - b);
    const reference = sorted[Math.floor(sorted.length * 0.96)] || Math.max(...output) || 1;
    const quantized = new Uint16Array(points);
    for (let i = 0; i < points; i += 1) {
      const normalized = clamp(output[i] / reference, 0.035, 1);
      quantized[i] = Math.round(normalized * 65535);
    }
    return quantized;
  } finally {
    await context.close().catch(() => {});
  }
}

export async function getOrCreateWaveform(trackId, blob, options = {}) {
  const cached = await getWaveform(trackId);
  if (cached?.length) return cached;
  const waveform = await generateWaveform(blob, options);
  await putWaveform(trackId, waveform);
  return waveform;
}

export class WaveformRenderer extends EventTarget {
  constructor(canvas, settings) {
    super();
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    this.settings = settings;
    this.samples = null;
    this.progress = 0;
    this.hover = null;
    this.dragging = false;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.bind();
    this.resize();
  }

  bind() {
    this.canvas.addEventListener('pointerdown', (event) => {
      this.dragging = true;
      this.canvas.setPointerCapture(event.pointerId);
      this.seekFromEvent(event, false);
    });
    this.canvas.addEventListener('pointermove', (event) => {
      this.hover = this.fractionFromEvent(event);
      if (this.dragging) this.seekFromEvent(event, false);
      this.draw();
    });
    this.canvas.addEventListener('pointerup', (event) => {
      if (!this.dragging) return;
      this.dragging = false;
      this.seekFromEvent(event, true);
    });
    this.canvas.addEventListener('pointercancel', () => { this.dragging = false; });
    this.canvas.addEventListener('pointerleave', () => {
      if (!this.dragging) this.hover = null;
      this.draw();
    });
    this.canvas.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        const delta = event.key === 'ArrowRight' ? 0.02 : -0.02;
        this.dispatchEvent(new CustomEvent('seekfraction', { detail: { fraction: clamp(this.progress + delta, 0, 1), commit: true } }));
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        this.dispatchEvent(new CustomEvent('seekfraction', { detail: { fraction: event.key === 'Home' ? 0 : 1, commit: true } }));
      }
    });
    this.settings.addEventListener('change', (event) => {
      if (!event.detail.key || ['waveform', 'accent', 'theme', 'highContrast'].includes(event.detail.key)) this.draw();
    });
  }

  fractionFromEvent(event) {
    const rect = this.canvas.getBoundingClientRect();
    return clamp((event.clientX - rect.left) / rect.width, 0, 1);
  }

  seekFromEvent(event, commit) {
    const fraction = this.fractionFromEvent(event);
    this.hover = fraction;
    this.dispatchEvent(new CustomEvent('seekfraction', { detail: { fraction, commit } }));
    this.draw();
  }

  setSamples(samples) {
    this.samples = samples;
    this.draw();
  }

  setProgress(progress) {
    this.progress = clamp(Number(progress) || 0, 0, 1);
    this.canvas.setAttribute('aria-valuenow', String(Math.round(this.progress * 100)));
    this.canvas.setAttribute('aria-valuemin', '0');
    this.canvas.setAttribute('aria-valuemax', '100');
    this.canvas.setAttribute('role', 'slider');
    this.draw();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const ratio = Math.min(2, globalThis.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
    }
    this.draw();
  }

  colours() {
    const computed = getComputedStyle(document.documentElement);
    return {
      active: computed.getPropertyValue('--accent').trim() || '#8b7cff',
      remaining: computed.getPropertyValue('--surface-strong').trim() || 'rgba(255,255,255,.12)',
      hover: computed.getPropertyValue('--text').trim() || '#fff',
    };
  }

  draw() {
    const rect = this.canvas.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    if (!width || !height) return;
    const ctx = this.context;
    ctx.clearRect(0, 0, width, height);
    const samples = this.samples?.length ? this.samples : new Uint16Array(96).fill(8000);
    const style = this.settings.get('waveform');
    const colors = this.colours();
    const playedX = width * this.progress;
    ctx.lineCap = 'round';
    if (style === 'line') this.drawLine(ctx, samples, width, height, playedX, colors);
    else this.drawBars(ctx, samples, width, height, playedX, colors, style === 'mirror');
    if (this.hover != null) {
      const x = this.hover * width;
      ctx.beginPath();
      ctx.moveTo(x, 3);
      ctx.lineTo(x, height - 3);
      ctx.strokeStyle = colors.hover;
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  drawBars(ctx, samples, width, height, playedX, colors, mirror) {
    const desired = Math.max(30, Math.floor(width / 5));
    const count = Math.min(desired, samples.length);
    const step = width / count;
    const barWidth = Math.max(1.5, step * 0.52);
    for (let index = 0; index < count; index += 1) {
      const sampleIndex = Math.floor((index / count) * samples.length);
      const amplitude = samples[sampleIndex] / 65535;
      const barHeight = Math.max(3, amplitude * (mirror ? height * 0.46 : height * 0.82));
      const x = index * step + (step - barWidth) / 2;
      const centerX = x + barWidth / 2;
      ctx.fillStyle = centerX <= playedX ? colors.active : colors.remaining;
      if (mirror) {
        const y = height / 2 - barHeight;
        this.roundedRect(ctx, x, y, barWidth, barHeight * 2, barWidth / 2);
      } else {
        const y = (height - barHeight) / 2;
        this.roundedRect(ctx, x, y, barWidth, barHeight, barWidth / 2);
      }
      ctx.fill();
    }
  }

  drawLine(ctx, samples, width, height, playedX, colors) {
    const points = Math.min(Math.floor(width), samples.length);
    const build = () => {
      ctx.beginPath();
      for (let index = 0; index < points; index += 1) {
        const sampleIndex = Math.floor((index / Math.max(1, points - 1)) * (samples.length - 1));
        const amplitude = samples[sampleIndex] / 65535;
        const x = (index / Math.max(1, points - 1)) * width;
        const y = height / 2 - (amplitude - 0.25) * height * 0.54;
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    };
    ctx.lineWidth = 2.2;
    build();
    ctx.strokeStyle = colors.remaining;
    ctx.stroke();
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, playedX, height);
    ctx.clip();
    build();
    ctx.strokeStyle = colors.active;
    ctx.stroke();
    ctx.restore();
  }

  roundedRect(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
  }

  destroy() {
    this.resizeObserver.disconnect();
  }
}
