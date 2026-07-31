import { throttle } from './utils.js';

export class VirtualList {
  constructor({ container, spacer, rows, renderItem, getRowHeight }) {
    this.container = container;
    this.spacer = spacer;
    this.rows = rows;
    this.renderItem = renderItem;
    this.getRowHeight = getRowHeight || (() => 76);
    this.items = [];
    this.selectedId = null;
    this.lastRange = '';
    this.scrollHandler = throttle(() => this.render(), 32);
    this.resizeObserver = new ResizeObserver(() => {
      this.lastRange = '';
      this.updateSize();
      this.render();
    });
    this.container.addEventListener('scroll', this.scrollHandler, { passive: true });
    this.resizeObserver.observe(container);
  }

  setItems(items, { preserveScroll = false } = {}) {
    this.items = items || [];
    if (!preserveScroll) this.container.scrollTop = 0;
    this.lastRange = '';
    this.updateSize();
    this.render();
  }

  setSelected(id) {
    this.selectedId = id;
    this.rows.querySelectorAll('.song-row').forEach((row) => row.setAttribute('aria-selected', String(row.dataset.id === id)));
  }

  updateSize() {
    this.rowHeight = this.getRowHeight();
    this.spacer.style.height = `${this.items.length * this.rowHeight}px`;
  }

  render() {
    const height = this.container.clientHeight;
    const scrollTop = this.container.scrollTop;
    const overscan = 7;
    const start = Math.max(0, Math.floor(scrollTop / this.rowHeight) - overscan);
    const end = Math.min(this.items.length, Math.ceil((scrollTop + height) / this.rowHeight) + overscan);
    const range = `${start}:${end}:${this.selectedId}:${this.rowHeight}`;
    if (range === this.lastRange) return;
    this.lastRange = range;
    const fragment = document.createDocumentFragment();
    for (let index = start; index < end; index += 1) {
      const item = this.items[index];
      const row = this.renderItem(item, index);
      row.style.transform = `translateY(${index * this.rowHeight}px)`;
      row.style.height = `${this.rowHeight}px`;
      row.setAttribute('aria-posinset', String(index + 1));
      row.setAttribute('aria-setsize', String(this.items.length));
      row.setAttribute('aria-selected', String(item.id === this.selectedId));
      fragment.append(row);
    }
    this.rows.replaceChildren(fragment);
  }

  scrollToId(id, { align = 'center' } = {}) {
    const index = this.items.findIndex((item) => item.id === id);
    if (index < 0) return;
    const target = index * this.rowHeight;
    if (align === 'center') this.container.scrollTo({ top: Math.max(0, target - this.container.clientHeight / 2 + this.rowHeight / 2), behavior: 'smooth' });
    else this.container.scrollTo({ top: target, behavior: 'smooth' });
  }

  destroy() {
    this.container.removeEventListener('scroll', this.scrollHandler);
    this.resizeObserver.disconnect();
  }
}
