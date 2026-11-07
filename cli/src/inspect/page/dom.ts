// DOM helpers shared by the shell, the views and the panel: the context they read, a virtual list and small
// formatters. Markup is built with the escaping `html` tag, since paths and names come from the project.
import type { FileOwner, Violation } from '../../contract/browser.js';
import { html, type HtmlValue, type SafeHtml } from './html.js';
import type { Selection } from '../graph/types.js';
import type { DirNode, ProjectIndex, SearchItem } from './model.js';
import type { UrlState, View } from './url.js';

/** What views and the panel need from the shell. */
export interface Ctx {
  index: ProjectIndex;
  state: UrlState & { view: View; depth: number };
  /** Ids of buckets, edges and violations changed since the page opened and not marked seen. */
  changed: ReadonlySet<string>;
  /** A link to `selection`, in `view` or the current view. */
  href(selection: Selection, view?: View): string;
  go(patch: Partial<UrlState>): void;
  /** Writes the list options (viewOptions in views.ts) to the query string, without a new history entry. */
  saveOptions(): void;
  copy(text: string): void;
  tree(): DirNode;
  searchItems(): SearchItem[];
  /** renderFull of a violation, cached. */
  text(v: Violation): string;
  owner(path: string): FileOwner | undefined;
  /** The folder name of the root project, from the page shell. */
  rootName: string;
}

const nf = new Intl.NumberFormat();
export const fmt = (n: number) => nf.format(n);
export const plural = (n: number, one: string, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;

/** A code token: monospace, never translated, truncated with the full value on hover. */
export const code = (text: string, cls = ''): SafeHtml => html`<span class="mono trunc ${cls}" translate="no" title="${text}">${text}</span>`;

export const link = (href: string, body: HtmlValue, cls = '', current = false): SafeHtml =>
  html`<a href="${href}" class="${cls}"${current ? html` aria-current="true"` : ''}>${body}</a>`;

export const tag = (text: string) => html`<span class="tag">${text}</span>`;

/** Items separated by commas. Each comma sticks to its item, so a line never starts with a comma. */
export const commaList = (items: HtmlValue[]): SafeHtml =>
  html`${items.map((item, i) => html`<span class="ci">${item}${i < items.length - 1 ? ',' : ''}</span>${i < items.length - 1 ? ' ' : ''}`)}`;

/**
 * Replaces the markup of `el` and gives the focus back to the same control when the focus was inside: the element
 * with the same data-key, else the same href. Returns false when the focus was inside and has no match.
 */
export function rerender(el: HTMLElement, markup: string): boolean {
  const active = document.activeElement;
  const inside = active instanceof HTMLElement && el.contains(active);
  const key = inside ? (active.dataset.key ?? active.getAttribute('href')) : null;
  el.innerHTML = markup;
  if (!inside) return true;
  const again = key === null ? undefined : [...el.querySelectorAll<HTMLElement>('[data-key], [href]')].find((e) => (e.dataset.key ?? e.getAttribute('href')) === key);
  again?.focus({ preventScroll: true });
  return again !== undefined;
}

export const sameSelection = (a: Selection, b: Selection) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A list that renders only the rows in view. Rows have a fixed height. The list is one tab stop (roving tabindex):
 * arrow keys, Home, End and Page keys move the focus between rows; Enter then follows the row's link or presses its
 * button.
 */
export class VirtualList {
  readonly el: HTMLElement;
  private readonly inner: HTMLElement;
  private readonly win: HTMLElement;
  private count = 0;
  private active = 0;
  private frame = 0;

  constructor(
    el: HTMLElement,
    private readonly rowHeight: number,
    private readonly row: (i: number) => SafeHtml,
    label: string,
  ) {
    this.el = el;
    el.classList.add('vlist');
    el.innerHTML = '<div class="vinner"><div class="vwin" role="list"></div></div>';
    this.inner = el.firstElementChild as HTMLElement;
    this.win = this.inner.firstElementChild as HTMLElement;
    this.win.setAttribute('aria-label', label);
    el.addEventListener('scroll', () => this.schedule(), { passive: true });
    el.addEventListener('keydown', (e) => this.key(e));
    el.addEventListener('focusin', (e) => {
      const at = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
      if (at) this.active = Number(at.dataset.i);
    });
  }

  setCount(n: number): void {
    this.count = n;
    this.active = Math.min(this.active, Math.max(0, n - 1));
    this.inner.style.height = `${n * this.rowHeight}px`;
    this.paint();
  }

  /** Renders the visible rows again, after a selection or data change. */
  refresh(): void {
    this.paint();
  }

  /** Scrolls row `i` into view: by the least amount, or to the middle with `center` (for a selection made elsewhere). */
  scrollTo(i: number, center = false): void {
    const top = i * this.rowHeight;
    const view = this.el.clientHeight;
    const outside = top < this.el.scrollTop || top + this.rowHeight > this.el.scrollTop + view;
    if (outside && center) this.el.scrollTop = top - (view - this.rowHeight) / 2;
    else if (top < this.el.scrollTop) this.el.scrollTop = top;
    else if (top + this.rowHeight > this.el.scrollTop + view) this.el.scrollTop = top + this.rowHeight - view;
    this.paint();
  }

  private schedule(): void {
    if (this.frame === 0) this.frame = requestAnimationFrame(() => this.paint());
  }

  private paint(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    const height = this.el.clientHeight || 800;
    const first = Math.max(0, Math.floor(this.el.scrollTop / this.rowHeight) - 10);
    const last = Math.min(this.count, Math.ceil((this.el.scrollTop + height) / this.rowHeight) + 10);
    const focused = this.win.contains(document.activeElement);
    const rows: string[] = [];
    for (let i = first; i < last; i++) {
      rows.push(
        `<div class="vrow" role="listitem" data-i="${i}" aria-posinset="${i + 1}" aria-setsize="${this.count}" style="top:${i * this.rowHeight}px">${this.row(i).value}</div>`,
      );
    }
    this.win.innerHTML = rows.join('');
    // The tab stop is the active row, or the first row in view when the active one scrolled out of the window.
    if (!focused && (this.active < first || this.active >= last)) this.active = Math.min(this.count - 1, Math.max(first, Math.ceil(this.el.scrollTop / this.rowHeight)));
    for (const c of this.win.querySelectorAll<HTMLElement>(':is(a,button)')) c.tabIndex = -1;
    const stop = this.control(this.active);
    if (stop) stop.tabIndex = 0;
    if (focused) stop?.focus({ preventScroll: true });
  }

  private control(i: number): HTMLElement | null {
    return this.win.querySelector<HTMLElement>(`[data-i="${i}"] :is(a,button)`);
  }

  private focusRow(i: number): void {
    this.control(i)?.focus({ preventScroll: true });
  }

  /** Moves the tab stop to row `i` without focusing it, for a selection made elsewhere. */
  setActive(i: number): void {
    if (i < 0 || i >= this.count || i === this.active) return;
    this.active = i;
    this.paint();
  }

  private key(e: KeyboardEvent): void {
    if ((e.target as HTMLElement).closest('.vwin') === null) return;
    const page = Math.max(1, Math.floor(this.el.clientHeight / this.rowHeight) - 1);
    const moves: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page, Home: -Infinity, End: Infinity };
    const move = moves[e.key];
    if (move === undefined || this.count === 0) return;
    e.preventDefault();
    this.active = Math.max(0, Math.min(this.count - 1, this.active + move));
    this.scrollTo(this.active);
    this.focusRow(this.active);
  }
}
