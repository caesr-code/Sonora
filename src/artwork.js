import { getArtworkBlob } from './db.js';

function seededHue(id = '') {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  return Math.abs(hash) % 360;
}

export function placeholderGradient(id) {
  const hue = seededHue(id);
  return `linear-gradient(145deg, hsl(${hue} 72% 58%), hsl(${(hue + 58) % 360} 58% 25%))`;
}

export class ArtworkCache {
  constructor(limit = 120) {
    this.limit = limit;
    this.urls = new Map();
    this.pending = new Map();
  }

  async getUrl(id) {
    if (!id) return null;
    if (this.urls.has(id)) {
      const value = this.urls.get(id);
      this.urls.delete(id);
      this.urls.set(id, value);
      return value;
    }
    if (this.pending.has(id)) return this.pending.get(id);
    const promise = (async () => {
      const blob = await getArtworkBlob(id);
      if (!blob) return null;
      const url = URL.createObjectURL(blob);
      this.urls.set(id, url);
      this.trim();
      return url;
    })().finally(() => this.pending.delete(id));
    this.pending.set(id, promise);
    return promise;
  }

  trim() {
    while (this.urls.size > this.limit) {
      const [id, url] = this.urls.entries().next().value;
      URL.revokeObjectURL(url);
      this.urls.delete(id);
    }
  }

  async applyToImage(image, track, { hideOnMissing = true } = {}) {
    const token = `${track?.id || ''}-${Date.now()}-${Math.random()}`;
    image.dataset.loadToken = token;
    image.alt = track ? `${track.album || 'Album'} artwork` : '';
    image.hidden = true;
    image.removeAttribute('src');
    if (!track?.hasArtwork) return null;
    const url = await this.getUrl(track.id);
    if (image.dataset.loadToken !== token) return null;
    if (!url) {
      if (!hideOnMissing) image.hidden = false;
      return null;
    }
    await new Promise((resolve) => {
      image.onload = resolve;
      image.onerror = resolve;
      image.src = url;
    });
    if (image.dataset.loadToken === token && image.naturalWidth) image.hidden = false;
    return image.hidden ? null : url;
  }

  clear() {
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.pending.clear();
  }
}

export async function dominantColorFromImage(image) {
  if (!image?.naturalWidth) return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 24;
    canvas.height = 24;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0, 24, 24);
    const data = context.getImageData(0, 0, 24, 24).data;
    let r = 0;
    let g = 0;
    let b = 0;
    let weight = 0;
    for (let i = 0; i < data.length; i += 16) {
      const alpha = data[i + 3] / 255;
      const brightness = (data[i] + data[i + 1] + data[i + 2]) / 765;
      const w = alpha * (0.35 + Math.abs(brightness - 0.5));
      r += data[i] * w;
      g += data[i + 1] * w;
      b += data[i + 2] * w;
      weight += w;
    }
    if (!weight) return null;
    return `rgb(${Math.round(r / weight)}, ${Math.round(g / weight)}, ${Math.round(b / weight)})`;
  } catch {
    return null;
  }
}
