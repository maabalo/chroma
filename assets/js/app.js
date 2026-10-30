/* ==========================================================================
   Chroma — app.js
   --------------------------------------------------------------------------
   All behaviour for the palette generator. Written as one plain script (no
   ES modules) so the app runs straight from file:// with no server.

   Data model — the palette is an array of colors:
       [{ hex: '#3ddc97', locked: false }, …]
   Every change goes through updatePalette() (section 07), which re-renders
   the swatches, records undo history and updates the share link.

   TABLE OF CONTENTS
     01  Settings & constants
     02  DOM references
     03  Small helpers
     04  Color conversion (HEX ⇄ RGB ⇄ HSL)
     05  Contrast (WCAG 2.1)
     06  Palette generation (color harmonies)
     07  State, updates & undo history
     08  Share link (URL hash)
     09  Swatch rendering
     10  Swatch actions (lock, pick, copy)
     11  Palette actions (generate, add, remove)
     12  Clipboard
     13  Toast & screen-reader announcements
     14  Saved palettes (library)
     15  Export
     16  Dialogs (shared)
     17  Theme
     18  Keyboard shortcuts
     19  Init
   ========================================================================== */
(function () {
  'use strict';

  /* ==========================================================================
     01  SETTINGS & CONSTANTS
     ========================================================================== */
  const MIN_COLORS = 2;
  const MAX_COLORS = 8;
  const DEFAULT_COLORS = 5;
  const MAX_HISTORY = 100; // undo steps kept in memory
  const MAX_SAVED = 60; // palettes kept in the library
  const TOAST_MS = 1800; // how long the toast stays visible

  const STORAGE_KEYS = {
    theme: 'chroma-theme', // also read by the inline script in index.html
    mode: 'chroma-mode',
    saved: 'chroma-saved',
  };

  const UNDO_DELETE_MS = 6000; // how long "Palette deleted. undo" stays

  const THEMES = ['auto', 'light', 'dark'];
  /** Browser-bar color (meta theme-color) for a manually chosen theme. Matches --surface. */
  const THEME_BAR_COLORS = { light: '#ffffff', dark: '#101317' };

  const HEX_PATTERN = /^#?([0-9a-f]{6})$/i;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  /* ==========================================================================
     02  DOM REFERENCES
     Every id used here exists in index.html.
     ========================================================================== */
  const byId = (id) => document.getElementById(id);

  const els = {
    // Top bar
    helpBtn: byId('helpBtn'),
    themeBtn: byId('themeBtn'),
    // Toolbar
    modeSelect: byId('modeSelect'),
    generateBtn: byId('generateBtn'),
    removeColorBtn: byId('removeColorBtn'),
    addColorBtn: byId('addColorBtn'),
    colorCount: byId('colorCount'),
    undoBtn: byId('undoBtn'),
    redoBtn: byId('redoBtn'),
    shareBtn: byId('shareBtn'),
    saveBtn: byId('saveBtn'),
    libraryBtn: byId('libraryBtn'),
    libraryCount: byId('libraryCount'),
    exportBtn: byId('exportBtn'),
    // Palette
    swatches: byId('swatches'),
    swatchTemplate: byId('swatchTemplate'),
    // Dialogs
    libraryDialog: byId('libraryDialog'),
    libraryList: byId('libraryList'),
    libraryEmpty: byId('libraryEmpty'),
    libraryUndo: byId('libraryUndo'),
    libraryUndoBtn: byId('libraryUndoBtn'),
    exportDialog: byId('exportDialog'),
    exportOutput: byId('exportOutput'),
    exportCopyBtn: byId('exportCopyBtn'),
    exportDownloadBtn: byId('exportDownloadBtn'),
    helpDialog: byId('helpDialog'),
    // Feedback
    toast: byId('toast'),
    announcer: byId('announcer'),
  };

  /* ==========================================================================
     03  SMALL HELPERS
     ========================================================================== */
  /** Keep a number between min and max. */
  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  /** Random float in [min, max). */
  function randomBetween(min, max) {
    return min + Math.random() * (max - min);
  }

  /** Random element of an array. */
  function randomItem(list) {
    return list[Math.floor(Math.random() * list.length)];
  }

  /** Wrap any angle into 0–359.99 degrees. */
  function wrapHue(hue) {
    return ((hue % 360) + 360) % 360;
  }

  /** Short unique-enough id for saved palettes. */
  function makeId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /**
   * Build an icon that points at a <symbol> in the sprite (index.html).
   * @param {string} name symbol id without the "i-" prefix, e.g. "trash"
   * @returns {SVGSVGElement}
   */
  function svgIcon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.appendChild(use);
    return svg;
  }

  /**
   * Turn a button on/off with aria-disabled instead of the disabled attribute.
   * A disabled button drops keyboard focus; aria-disabled keeps it, and each
   * click handler already ignores clicks that can't do anything.
   */
  /**
   * @param {HTMLButtonElement} button
   * @param {boolean} disabled
   */
  function setDisabled(button, disabled) {
    button.setAttribute('aria-disabled', String(disabled));
  }

  /** True when the user is typing in a field (shortcuts must not fire). */
  function isTypingTarget(element) {
    return (
      Boolean(element) && (element.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(element.tagName))
    );
  }

  /** Read from localStorage without throwing (private mode can block it). */
  function readStorage(key) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      console.warn('Chroma: storage is not available', error);
      return null;
    }
  }

  /**
   * Write to localStorage.
   * @returns {boolean} false when storage is full or blocked
   */
  function writeStorage(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (error) {
      console.warn('Chroma: could not write to storage', error);
      return false;
    }
  }

  /* ==========================================================================
     04  COLOR CONVERSION (HEX ⇄ RGB ⇄ HSL)
     RGB channels are 0–255; HSL uses h 0–360, s and l 0–100.
     ========================================================================== */
  /**
   * Turn "3DDC97" or "#3ddc97" into "#3ddc97".
   * @returns {string|null} null when the value is not a 6-digit hex color
   */
  function normalizeHex(value) {
    const match = HEX_PATTERN.exec(String(value).trim());
    return match ? '#' + match[1].toLowerCase() : null;
  }

  /** "#3ddc97" → { r: 61, g: 220, b: 151 } */
  function hexToRgb(hex) {
    const number = parseInt(hex.slice(1), 16);
    return { r: (number >> 16) & 255, g: (number >> 8) & 255, b: number & 255 };
  }

  /** { r, g, b } → "#3ddc97" (channels are rounded and clamped to 0–255). */
  function rgbToHex({ r, g, b }) {
    return (
      '#' +
      [r, g, b].map((channel) => clamp(Math.round(channel), 0, 255).toString(16).padStart(2, '0')).join('')
    );
  }

  /** { r, g, b } → { h, s, l } using the standard RGB → HSL formula. */
  function rgbToHsl({ r, g, b }) {
    const red = r / 255;
    const green = g / 255;
    const blue = b / 255;
    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    const delta = max - min;
    const lightness = (max + min) / 2;

    if (delta === 0) return { h: 0, s: 0, l: lightness * 100 }; // gray

    const saturation = delta / (1 - Math.abs(2 * lightness - 1));
    let hue;
    if (max === red) hue = ((green - blue) / delta) % 6;
    else if (max === green) hue = (blue - red) / delta + 2;
    else hue = (red - green) / delta + 4;

    return { h: wrapHue(hue * 60), s: saturation * 100, l: lightness * 100 };
  }

  /** { h, s, l } → { r, g, b } (unrounded). Out-of-range s/l are clamped. */
  function hslToRgb({ h, s, l }) {
    const saturation = clamp(s, 0, 100) / 100;
    const lightness = clamp(l, 0, 100) / 100;
    const amount = saturation * Math.min(lightness, 1 - lightness);
    const channel = (offset) => {
      const k = (offset + wrapHue(h) / 30) % 12;
      return (lightness - amount * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255;
    };
    return { r: channel(0), g: channel(8), b: channel(4) };
  }

  /** { h, s, l } → "#rrggbb" */
  const hslToHex = (hsl) => rgbToHex(hslToRgb(hsl));
  /** "#rrggbb" → { h, s, l } */
  const hexToHsl = (hex) => rgbToHsl(hexToRgb(hex));

  /** "rgb(61, 220, 151)" */
  function formatRgb(hex) {
    const { r, g, b } = hexToRgb(hex);
    return `rgb(${r}, ${g}, ${b})`;
  }

  /** "hsl(154, 70%, 55%)" */
  function formatHsl(hex) {
    const { h, s, l } = hexToHsl(hex);
    return `hsl(${Math.round(h) % 360}, ${Math.round(s)}%, ${Math.round(l)}%)`;
  }

  /** Text for a color in the given format ("hex" | "rgb" | "hsl"). */
  function formatColor(hex, format) {
    if (format === 'rgb') return formatRgb(hex);
    if (format === 'hsl') return formatHsl(hex);
    return hex.toUpperCase();
  }

  /* ==========================================================================
     05  CONTRAST (WCAG 2.1)
     ========================================================================== */
  /** sRGB channel (0–255) → linear light (0–1). */
  function toLinear(channel) {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  }

  /** Relative luminance, 0 (black) to 1 (white). */
  function luminance(hex) {
    const { r, g, b } = hexToRgb(hex);
    return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
  }

  /** Contrast ratio between two colors, 1 to 21. */
  function contrastRatio(hexA, hexB) {
    const a = luminance(hexA);
    const b = luminance(hexB);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }

  /** WCAG grade for a ratio: AAA, AA, AA large or fail. */
  function contrastGrade(ratio) {
    if (ratio >= 7) return 'AAA';
    if (ratio >= 4.5) return 'AA';
    if (ratio >= 3) return 'AA large';
    return 'fail';
  }

  /** Black or white — whichever is easier to read on this color. */
  function inkFor(hex) {
    return contrastRatio(hex, '#ffffff') >= contrastRatio(hex, '#000000') ? '#ffffff' : '#000000';
  }

  /** Round DOWN to 2 decimals so 4.499 never shows as a passing 4.50. */
  function formatRatio(ratio) {
    return (Math.floor(ratio * 100) / 100).toFixed(2);
  }

  /* ==========================================================================
     06  PALETTE GENERATION (color harmonies)
     Each harmony returns `count` HSL colors built around `baseHue`.
     Keys must match the <option> values of #modeSelect in index.html.
     ========================================================================== */
  /** Lightness for slot `index`, spread from light (first) to dark (last). */
  function lightnessAt(index, count, min, max) {
    const progress = count > 1 ? index / (count - 1) : 0.5;
    return clamp(max - progress * (max - min) + randomBetween(-4, 4), 6, 94);
  }

  const HARMONIES = {
    /** Neighbouring hues spread around the base. */
    analogous(baseHue, count) {
      const step = randomBetween(16, 30);
      const saturation = randomBetween(50, 80);
      return Array.from({ length: count }, (_, i) => ({
        h: baseHue + (i - (count - 1) / 2) * step,
        s: saturation + randomBetween(-10, 10),
        l: lightnessAt(i, count, 28, 84),
      }));
    },

    /** One hue, light to dark. */
    monochromatic(baseHue, count) {
      const saturation = randomBetween(35, 75);
      return Array.from({ length: count }, (_, i) => ({
        h: baseHue + randomBetween(-4, 4),
        s: saturation + randomBetween(-6, 6),
        l: lightnessAt(i, count, 16, 92),
      }));
    },

    /** Base hue for the first half, its opposite for the second half. */
    complementary(baseHue, count) {
      const half = Math.ceil(count / 2);
      return Array.from({ length: count }, (_, i) => ({
        h: (i < half ? baseHue : baseHue + 180) + randomBetween(-6, 6),
        s: randomBetween(50, 80),
        l: lightnessAt(i, count, 26, 86),
      }));
    },

    /** Base hue plus the two hues next to its opposite. */
    splitComplementary(baseHue, count) {
      const offsets = [0, 150, 210];
      return Array.from({ length: count }, (_, i) => ({
        h: baseHue + offsets[i % offsets.length] + randomBetween(-5, 5),
        s: randomBetween(50, 80),
        l: lightnessAt(i, count, 28, 84),
      }));
    },

    /** Three hues 120° apart. */
    triadic(baseHue, count) {
      return Array.from({ length: count }, (_, i) => ({
        h: baseHue + (i % 3) * 120 + randomBetween(-5, 5),
        s: randomBetween(55, 82),
        l: lightnessAt(i, count, 30, 82),
      }));
    },

    /** Unrelated hues with balanced saturation and lightness. */
    random(_baseHue, count) {
      return Array.from({ length: count }, () => ({
        h: randomBetween(0, 360),
        s: randomBetween(40, 85),
        l: randomBetween(28, 82),
      }));
    },
  };

  /** Harmonies that "auto" mode chooses from. */
  const AUTO_HARMONIES = ['analogous', 'monochromatic', 'complementary', 'splitComplementary', 'triadic'];

  /**
   * Return a new palette: locked colors stay, the rest are regenerated.
   * The first locked color (if any) sets the base hue so new colors match it.
   * @param {{hex:string, locked:boolean}[]} palette
   * @param {string} mode key of HARMONIES, or "auto"
   */
  function generateColors(palette, mode) {
    const anchor = palette.find((color) => color.locked);
    const baseHue = anchor ? hexToHsl(anchor.hex).h : randomBetween(0, 360);
    const harmony = mode === 'auto' ? randomItem(AUTO_HARMONIES) : mode;
    const build = HARMONIES[harmony] || HARMONIES.random;
    const fresh = build(baseHue, palette.length);

    return palette.map((color, i) =>
      color.locked ? { ...color } : { hex: hslToHex(fresh[i]), locked: false },
    );
  }

  /** A brand-new palette of `count` colors. */
  function freshPalette(count, mode) {
    const blank = Array.from({ length: count }, () => ({ hex: '#000000', locked: false }));
    return generateColors(blank, mode);
  }

  /* ==========================================================================
     07  STATE, UPDATES & UNDO HISTORY
     history holds snapshots; historyIndex points at the one on screen.
     ========================================================================== */
  const state = {
    palette: [],
    history: [],
    historyIndex: -1,
    mode: 'auto',
    theme: 'auto',
    saved: [],
  };

  /** Deep copy so snapshots in history can't be changed by later edits. */
  function clonePalette(palette) {
    return palette.map((color) => ({ hex: color.hex, locked: color.locked }));
  }

  /** True when two palettes have the same colors and lock states. */
  function samePalette(a, b) {
    return (
      a.length === b.length && a.every((color, i) => color.hex === b[i].hex && color.locked === b[i].locked)
    );
  }

  /** Add the current palette to the undo history (skips exact repeats). */
  function recordHistory() {
    const snapshot = clonePalette(state.palette);
    const current = state.history[state.historyIndex];
    if (current && samePalette(current, snapshot)) return;

    // A new change after undo discards the "redo" branch.
    state.history = state.history.slice(0, state.historyIndex + 1);
    state.history.push(snapshot);
    if (state.history.length > MAX_HISTORY) state.history.shift();
    state.historyIndex = state.history.length - 1;
  }

  /**
   * The one place the palette changes.
   * @param {{hex:string, locked:boolean}[]} next
   * @param {{record?: boolean}} [options] record:false while dragging the color picker
   */
  function updatePalette(next, { record = true } = {}) {
    state.palette = next;
    renderSwatches();
    if (record) {
      recordHistory();
      writeHash();
    }
    updateControls();
  }

  /** Move through history: -1 = undo, +1 = redo. */
  function stepHistory(direction) {
    const target = state.historyIndex + direction;
    if (target < 0 || target >= state.history.length) return;
    state.historyIndex = target;
    state.palette = clonePalette(state.history[target]);
    renderSwatches();
    writeHash();
    updateControls();
    announce(direction < 0 ? 'Undone' : 'Redone');
  }

  /** Enable/disable toolbar buttons to match the state. */
  function updateControls() {
    const count = state.palette.length;
    els.colorCount.textContent = String(count);
    setDisabled(els.addColorBtn, count >= MAX_COLORS);
    setDisabled(els.removeColorBtn, count <= MIN_COLORS);
    setDisabled(els.undoBtn, state.historyIndex <= 0);
    setDisabled(els.redoBtn, state.historyIndex >= state.history.length - 1);
  }

  /* ==========================================================================
     08  SHARE LINK (URL hash)
     The address bar mirrors the palette: index.html#3ddc97-2f80ed-f2c94c
     ========================================================================== */
  /** Palette → "3ddc97-2f80ed-f2c94c" */
  function paletteToHash(palette) {
    return palette.map((color) => color.hex.slice(1)).join('-');
  }

  /** Palette from the URL hash, or null when the hash isn't a valid palette. */
  function readHash() {
    const colors = window.location.hash.replace(/^#/, '').split('-').map(normalizeHex);
    if (colors.length < MIN_COLORS || colors.length > MAX_COLORS || colors.includes(null)) return null;
    return colors.map((hex) => ({ hex, locked: false }));
  }

  /** Update the hash without adding a browser history entry. */
  function writeHash() {
    try {
      window.history.replaceState(null, '', '#' + paletteToHash(state.palette));
    } catch (error) {
      console.warn('Chroma: could not update the share link', error);
    }
  }

  /** User pasted/edited a link with a different palette. */
  function handleHashChange() {
    const fromHash = readHash();
    if (fromHash && paletteToHash(fromHash) !== paletteToHash(state.palette)) {
      updatePalette(fromHash);
      announcePalette('Palette loaded from link');
    }
  }

  /* ==========================================================================
     09  SWATCH RENDERING
     Swatch elements are reused, not rebuilt, so keyboard focus stays put
     when a color changes.
     ========================================================================== */
  /** A fresh swatch <li> cloned from <template id="swatchTemplate">. */
  function createSwatch() {
    return els.swatchTemplate.content.firstElementChild.cloneNode(true);
  }

  /** Make the number of <li> match the palette, then fill each one. */
  function renderSwatches() {
    const list = els.swatches;
    const hadFocus = list.contains(document.activeElement);

    while (list.children.length < state.palette.length) list.appendChild(createSwatch());
    while (list.children.length > state.palette.length) list.lastElementChild.remove();
    state.palette.forEach((color, i) => updateSwatch(list.children[i], color, i));

    // If the focused swatch was removed, move focus to the new last swatch.
    if (hadFocus && !list.contains(document.activeElement) && list.lastElementChild) {
      list.lastElementChild.querySelector('[data-action="lock"]').focus();
    }
  }

  /**
   * Fill one swatch with its color, labels and contrast values.
   * @param {HTMLLIElement} item
   * @param {{hex:string, locked:boolean}} color
   * @param {number} index position in the palette (0-based)
   */
  function updateSwatch(item, color, index) {
    const number = index + 1;
    item.dataset.index = String(index);
    item.style.setProperty('--swatch', color.hex);
    item.style.setProperty('--ink', inkFor(color.hex));
    item.querySelector('.swatch-index').textContent = String(number).padStart(2, '0');

    updateLockButton(item, color.locked, number);
    updatePicker(item, color.hex, number);
    updateCopyButtons(item, color.hex);
    updateContrast(item, color.hex);
  }

  /** Lock button: aria-pressed carries the on/off state. */
  function updateLockButton(item, locked, number) {
    const button = item.querySelector('[data-action="lock"]');
    button.setAttribute('aria-pressed', String(locked));
    button.setAttribute('aria-label', `Lock color ${number}`);
    button.title = locked ? `Unlock (${number})` : `Lock — keep this color (${number})`;
  }

  /** Native color input (only rewritten when the value differs, so dragging stays smooth). */
  function updatePicker(item, hex, number) {
    const picker = item.querySelector('input[type="color"]');
    if (picker.value !== hex) picker.value = hex;
    picker.setAttribute('aria-label', `Pick color ${number}`);
  }

  /** HEX / RGB / HSL buttons — each shows and copies its own format. */
  function updateCopyButtons(item, hex) {
    item.querySelectorAll('[data-action="copy"]').forEach((button) => {
      const text = formatColor(hex, button.dataset.format);
      button.textContent = text;
      button.setAttribute('aria-label', `Copy ${text}`);
      button.title = 'Click to copy';
    });
  }

  /** Contrast against white and black text, e.g. "4.58 AA". */
  function updateContrast(item, hex) {
    item.querySelectorAll('.contrast-value').forEach((output) => {
      const ratio = contrastRatio(hex, output.dataset.against);
      output.textContent = `${formatRatio(ratio)} ${contrastGrade(ratio)}`;
    });
  }

  /* ==========================================================================
     10  SWATCH ACTIONS (lock, pick, copy)
     One listener on the list handles every swatch (event delegation).
     ========================================================================== */
  /** Index of the swatch that contains `element`, or -1. */
  function swatchIndexOf(element) {
    const item = element.closest('.swatch');
    return item ? Number(item.dataset.index) : -1;
  }

  /** Click anywhere in the palette → lock or copy, based on data-action. */
  function handleSwatchClick(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const index = swatchIndexOf(button);
    if (index < 0) return;

    if (button.dataset.action === 'lock') toggleLock(index);
    else if (button.dataset.action === 'copy') copyColor(index, button.dataset.format);
  }

  /** Lock ↔ unlock the color at `index`. */
  function toggleLock(index) {
    if (!state.palette[index]) return;
    const next = clonePalette(state.palette);
    next[index].locked = !next[index].locked;
    updatePalette(next);
    announce(`Color ${index + 1} ${next[index].locked ? 'locked' : 'unlocked'}`);
  }

  /**
   * Apply the color picker's value. A picked color is locked automatically
   * so the next "generate" doesn't throw it away.
   * @param {HTMLInputElement} input
   * @param {boolean} record false while dragging (live preview), true when done
   */
  function applyPickedColor(input, record) {
    const index = swatchIndexOf(input);
    const hex = normalizeHex(input.value);
    if (index < 0 || !hex) return;

    const next = clonePalette(state.palette);
    next[index] = { hex, locked: true };
    updatePalette(next, { record });
  }

  /** Live preview while the color picker is being dragged (not saved to history). */
  function handleSwatchInput(event) {
    if (event.target.matches('input[type="color"]')) applyPickedColor(event.target, false);
  }

  /** Color picker closed/confirmed → save the result to history. */
  function handleSwatchChange(event) {
    if (event.target.matches('input[type="color"]')) applyPickedColor(event.target, true);
  }

  /** Copy one color in the given format ("hex" | "rgb" | "hsl"). */
  function copyColor(index, format) {
    const color = state.palette[index];
    if (!color) return;
    const text = formatColor(color.hex, format);
    copyWithFeedback(text, `Copied ${text}`, color.hex);
  }

  /* ==========================================================================
     11  PALETTE ACTIONS (generate, add, remove)
     ========================================================================== */
  /** New palette; locked colors stay. */
  function generate() {
    if (state.palette.every((color) => color.locked)) {
      showToast('All colors are locked — unlock one first');
      return;
    }
    updatePalette(generateColors(state.palette, state.mode));
    announcePalette('New palette');
  }

  /** Append one color that fits the current palette. */
  function addColor() {
    if (state.palette.length >= MAX_COLORS) return;
    // Treat every existing color as locked so only the new slot is generated.
    const grown = [
      ...state.palette.map((color) => ({ hex: color.hex, locked: true })),
      { hex: '#000000', locked: false },
    ];
    const added = generateColors(grown, state.mode).pop();
    updatePalette([...clonePalette(state.palette), added]);
    announce(`Added ${added.hex.toUpperCase()}`);
  }

  /** Remove the last color that isn't locked. */
  function removeColor() {
    if (state.palette.length <= MIN_COLORS) return;
    let index = -1;
    for (let i = state.palette.length - 1; i >= 0; i -= 1) {
      if (!state.palette[i].locked) {
        index = i;
        break;
      }
    }
    if (index === -1) {
      showToast('Unlock a color to remove it');
      return;
    }
    const next = clonePalette(state.palette);
    const [removed] = next.splice(index, 1);
    updatePalette(next);
    announce(`Removed ${removed.hex.toUpperCase()}`);
  }

  /** Remember the chosen harmony mode for next time. */
  function handleModeChange() {
    state.mode = els.modeSelect.value;
    writeStorage(STORAGE_KEYS.mode, state.mode);
  }

  /** Saved mode, or "auto" when missing/unknown. */
  function readMode() {
    const saved = readStorage(STORAGE_KEYS.mode);
    const valid = Array.from(els.modeSelect.options, (option) => option.value);
    return valid.includes(saved) ? saved : 'auto';
  }

  /* ==========================================================================
     12  CLIPBOARD
     navigator.clipboard needs a secure context; file:// in some browsers
     isn't one, so there's a fallback using a temporary <textarea>.
     ========================================================================== */
  /** Copy text; throws if every method fails. */
  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch (error) {
        console.warn('Chroma: clipboard API failed, trying fallback', error);
      }
    }
    legacyCopy(text);
  }

  /**
   * Old-style copy through a hidden <textarea> + execCommand('copy').
   * Deprecated, but the only option where the async clipboard API is blocked.
   */
  function legacyCopy(text) {
    const previousFocus = document.activeElement;
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    // Inside an open modal dialog, elements outside it can't be focused.
    (document.querySelector('dialog[open]') || document.body).appendChild(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
    if (!copied) throw new Error('The browser refused the copy command');
  }

  /**
   * Copy and tell the user how it went.
   * @returns {Promise<boolean>} true when the text was copied
   */
  async function copyWithFeedback(text, successMessage, swatchHex) {
    try {
      await copyText(text);
      showToast(successMessage, swatchHex);
      return true;
    } catch (error) {
      console.error('Chroma: copy failed', error);
      showToast('Could not copy — select the text and copy it manually');
      return false;
    }
  }

  /** A file:// link only works on this computer, so say so. */
  function copyShareLink() {
    const message =
      window.location.protocol === 'file:'
        ? 'Link copied — works on this computer until the site is hosted'
        : 'Share link copied';
    copyWithFeedback(window.location.href, message);
  }

  /* ==========================================================================
     13  TOAST & SCREEN-READER ANNOUNCEMENTS
     ========================================================================== */
  // With the Popover API the toast sits in the top layer, above open dialogs.
  const supportsPopover = typeof HTMLElement.prototype.showPopover === 'function';
  let toastTimer = 0;

  /**
   * Show a short message at the bottom of the screen.
   * @param {string} message
   * @param {string} [swatchHex] adds a small color chip before the text
   */
  function showToast(message, swatchHex) {
    const toast = els.toast;
    toast.replaceChildren();
    if (swatchHex) {
      const chip = document.createElement('span');
      chip.className = 'toast-swatch';
      chip.style.background = swatchHex;
      chip.setAttribute('aria-hidden', 'true');
      toast.appendChild(chip);
    }
    toast.appendChild(document.createTextNode(message));

    setToastVisible(false); // re-open so it restarts the animation and stacks on top
    setToastVisible(true);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => setToastVisible(false), TOAST_MS);
    announce(message);
  }

  /** Show/hide the toast — via the Popover API when supported, else the hidden attribute. */
  function setToastVisible(visible) {
    const toast = els.toast;
    if (!supportsPopover) {
      toast.hidden = !visible;
      return;
    }
    const isOpen = toast.matches(':popover-open');
    if (visible && !isOpen) toast.showPopover();
    if (!visible && isOpen) toast.hidePopover();
  }

  /**
   * Read a message to screen-reader users (visually hidden).
   * While a modal dialog is open, everything outside it is hidden from
   * assistive tech, so the message goes to that dialog's own status line.
   */
  function announce(message) {
    const openDialog = document.querySelector('dialog[open]');
    const region = (openDialog && openDialog.querySelector('.dialog-status')) || els.announcer;
    region.textContent = '';
    // A short delay makes repeated identical messages announce again.
    setTimeout(() => {
      region.textContent = message;
    }, 50);
  }

  /**
   * Briefly change a button's text ("copy code" → "copied ✓").
   * Visible feedback even where the toast can't appear above a dialog.
   */
  function flashLabel(button, text) {
    if (!button.dataset.label) button.dataset.label = button.textContent;
    button.textContent = text;
    clearTimeout(Number(button.dataset.flashTimer));
    button.dataset.flashTimer = String(
      setTimeout(() => {
        button.textContent = button.dataset.label;
      }, TOAST_MS),
    );
  }

  /** Announce every color, e.g. "New palette: #3DDC97, #2F80ED, …". */
  function announcePalette(prefix) {
    announce(`${prefix}: ${state.palette.map((color) => color.hex.toUpperCase()).join(', ')}`);
  }

  /* ==========================================================================
     14  SAVED PALETTES (library)
     Stored in localStorage as [{ id, colors: ['#hex', …], savedAt }], newest first.
     ========================================================================== */
  // The most recently deleted palette, kept so it can be restored.
  let lastDeleted = null; // { entry, index } | null
  let undoDeleteTimer = 0;

  /** Validate one stored entry; returns null when it's damaged. */
  function normalizeSaved(entry) {
    if (!entry || !Array.isArray(entry.colors)) return null;
    const colors = entry.colors.map(normalizeHex);
    if (colors.length < MIN_COLORS || colors.length > MAX_COLORS || colors.includes(null)) return null;
    return {
      id: typeof entry.id === 'string' ? entry.id : makeId(),
      colors,
      savedAt: Number(entry.savedAt) || Date.now(),
    };
  }

  /** Saved palettes from storage; damaged entries are skipped. */
  function readSaved() {
    const raw = readStorage(STORAGE_KEYS.saved);
    if (!raw) return [];
    try {
      const data = JSON.parse(raw);
      return Array.isArray(data) ? data.map(normalizeSaved).filter(Boolean).slice(0, MAX_SAVED) : [];
    } catch (error) {
      console.warn('Chroma: saved palettes are unreadable and were ignored', error);
      return [];
    }
  }

  /** Persist the library; shows an error and returns false on failure. */
  function persistSaved(list) {
    if (writeStorage(STORAGE_KEYS.saved, JSON.stringify(list))) return true;
    showToast('Could not save — browser storage is full or blocked');
    return false;
  }

  /** Add the current palette to the library (newest first, no duplicates). */
  function savePalette() {
    const colors = state.palette.map((color) => color.hex);
    const key = colors.join();
    if (state.saved.some((entry) => entry.colors.join() === key)) {
      showToast('This palette is already saved');
      return;
    }

    const trimmed = state.saved.length >= MAX_SAVED;
    const next = [{ id: makeId(), colors, savedAt: Date.now() }, ...state.saved].slice(0, MAX_SAVED);
    if (!persistSaved(next)) return;

    state.saved = next;
    updateLibraryCount();
    showToast(trimmed ? `Saved — oldest palette removed (limit ${MAX_SAVED})` : 'Palette saved');
  }

  /** Number bubble on the library button (hidden at 0). */
  function updateLibraryCount() {
    const count = state.saved.length;
    els.libraryCount.textContent = String(count);
    els.libraryCount.hidden = count === 0;
  }

  /** Timestamp → "Oct 30, 2026" in the user's locale. */
  function formatDate(timestamp) {
    return new Date(timestamp).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }

  /** One row: a "load" button showing the colors, and a delete button. */
  function createLibraryItem(entry) {
    const item = document.createElement('li');
    item.className = 'library-item';
    item.append(createLoadButton(entry), createDeleteButton(entry));
    return item;
  }

  /**
   * A button for a library row. data-action/data-id are read by handleLibraryClick.
   * @param {'load'|'delete'} action
   */
  function createLibraryButton(entry, action, className, label) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.dataset.id = entry.id;
    button.dataset.action = action;
    button.setAttribute('aria-label', `${label} palette ${entry.colors.join(', ').toUpperCase()}`);
    return button;
  }

  /** Color strip + "5 colors · Oct 30, 2026". Clicking loads the palette. */
  function createLoadButton(entry) {
    const button = createLibraryButton(entry, 'load', 'library-load', 'Load');
    const meta = document.createElement('span');
    meta.className = 'library-meta';
    meta.textContent = `${entry.colors.length} colors · ${formatDate(entry.savedAt)}`;
    button.append(createColorStrip(entry.colors), meta);
    return button;
  }

  /** Trash-can button. */
  function createDeleteButton(entry) {
    const button = createLibraryButton(entry, 'delete', 'icon-btn library-delete', 'Delete');
    button.title = 'Delete';
    button.appendChild(svgIcon('trash'));
    return button;
  }

  /** Row of colored blocks previewing a palette. */
  function createColorStrip(colors) {
    const strip = document.createElement('span');
    strip.className = 'library-strip';
    colors.forEach((hex) => {
      const block = document.createElement('span');
      block.style.background = hex;
      strip.appendChild(block);
    });
    return strip;
  }

  /** Rebuild the library list (or show the empty message). */
  function renderLibrary() {
    els.libraryList.replaceChildren(...state.saved.map(createLibraryItem));
    els.libraryEmpty.hidden = state.saved.length > 0;
  }

  /** Open the library dialog with an up-to-date list. */
  function openLibrary() {
    hideUndoDelete();
    renderLibrary();
    openDialog(els.libraryDialog);
  }

  /** Click in the library list → load or delete, based on data-action. */
  function handleLibraryClick(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    if (button.dataset.action === 'load') loadSaved(button.dataset.id);
    else if (button.dataset.action === 'delete') deleteSaved(button.dataset.id);
  }

  /** Replace the current palette with a saved one and close the dialog. */
  function loadSaved(id) {
    const entry = state.saved.find((saved) => saved.id === id);
    if (!entry) return;
    updatePalette(entry.colors.map((hex) => ({ hex, locked: false })));
    els.libraryDialog.close();
    showToast('Palette loaded');
  }

  /** Show "Palette deleted. undo" for UNDO_DELETE_MS. */
  function showUndoDelete() {
    els.libraryUndo.hidden = false;
    clearTimeout(undoDeleteTimer);
    undoDeleteTimer = setTimeout(hideUndoDelete, UNDO_DELETE_MS);
  }

  /** Hide the undo bar and forget the deleted palette (waits while it has focus). */
  function hideUndoDelete() {
    clearTimeout(undoDeleteTimer);
    // Don't yank the bar away from someone about to press "undo".
    if (els.libraryUndo.contains(document.activeElement)) {
      undoDeleteTimer = setTimeout(hideUndoDelete, UNDO_DELETE_MS);
      return;
    }
    els.libraryUndo.hidden = true;
    lastDeleted = null;
  }

  /** Put the last deleted palette back where it was. */
  function undoDelete() {
    if (!lastDeleted) return;
    const next = [...state.saved];
    next.splice(Math.min(lastDeleted.index, next.length), 0, lastDeleted.entry);
    if (!persistSaved(next)) return;

    const restoredId = lastDeleted.entry.id;
    state.saved = next;
    lastDeleted = null;
    els.libraryUndo.hidden = true;
    updateLibraryCount();
    renderLibrary();
    announce('Palette restored');
    const restored = els.libraryList.querySelector(`.library-load[data-id="${CSS.escape(restoredId)}"]`);
    if (restored) restored.focus();
  }

  /** Remove a saved palette (can be undone for a few seconds). */
  function deleteSaved(id) {
    const index = state.saved.findIndex((entry) => entry.id === id);
    if (index === -1) return;
    const next = state.saved.filter((entry) => entry.id !== id);
    if (!persistSaved(next)) return;

    lastDeleted = { entry: state.saved[index], index };
    state.saved = next;
    updateLibraryCount();
    renderLibrary();
    showUndoDelete();
    announce('Palette deleted. Undo is available');

    // Keep keyboard focus inside the dialog: next row, previous row, or close button.
    const rows = els.libraryList.querySelectorAll('.library-load');
    const target = rows[Math.min(index, rows.length - 1)] || els.libraryDialog.querySelector('.dialog-close');
    target.focus();
  }

  /* ==========================================================================
     15  EXPORT
     Keys must match the radio values in the export dialog (index.html).
     Each exporter turns an array of hex strings into file text.
     ========================================================================== */
  const EXPORTERS = {
    css: {
      file: 'palette.css',
      mime: 'text/css',
      build: (colors) => `:root {\n${colors.map((hex, i) => `  --color-${i + 1}: ${hex};`).join('\n')}\n}\n`,
    },
    scss: {
      file: '_palette.scss',
      mime: 'text/x-scss',
      build: (colors) => colors.map((hex, i) => `$color-${i + 1}: ${hex};`).join('\n') + '\n',
    },
    tailwind: {
      file: 'palette.tailwind.js',
      mime: 'text/javascript',
      build: (colors) =>
        [
          '// Merge into tailwind.config.js. Use as bg-palette-100, text-palette-200, …',
          'module.exports = {',
          '  theme: {',
          '    extend: {',
          '      colors: {',
          '        palette: {',
          ...colors.map((hex, i) => `          ${(i + 1) * 100}: '${hex}',`),
          '        },',
          '      },',
          '    },',
          '  },',
          '};',
          '',
        ].join('\n'),
    },
    json: {
      file: 'palette.json',
      mime: 'application/json',
      build: (colors) =>
        JSON.stringify(
          colors.map((hex) => ({ hex, rgb: formatRgb(hex), hsl: formatHsl(hex) })),
          null,
          2,
        ) + '\n',
    },
    hex: {
      file: 'palette.txt',
      mime: 'text/plain',
      build: (colors) => colors.join('\n') + '\n',
    },
  };

  /** The exporter for the selected format radio. */
  function currentExporter() {
    const checked = els.exportDialog.querySelector('input[name="exportFormat"]:checked');
    return EXPORTERS[checked ? checked.value : 'css'] || EXPORTERS.css;
  }

  /** Fill the code box for the current palette and format. */
  function renderExport() {
    els.exportOutput.value = currentExporter().build(state.palette.map((color) => color.hex));
  }

  /** Open the export dialog with fresh code. */
  function openExport() {
    renderExport();
    openDialog(els.exportDialog);
  }

  /** Copy the export code; the button briefly confirms it. */
  async function copyExport() {
    if (await copyWithFeedback(els.exportOutput.value, 'Code copied')) {
      flashLabel(els.exportCopyBtn, 'copied ✓');
    }
  }

  /** Save the export as a file (works from file:// too). */
  function downloadExport() {
    const exporter = currentExporter();
    try {
      const blob = new Blob([els.exportOutput.value], { type: exporter.mime });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = exporter.file;
      els.exportDialog.appendChild(link); // inside the modal so it isn't inert
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast(`Downloaded ${exporter.file}`);
    } catch (error) {
      console.error('Chroma: download failed', error);
      showToast('Download failed — copy the code instead');
    }
  }

  /* ==========================================================================
     16  DIALOGS (shared)
     Native <dialog>.showModal() gives Esc-to-close and a focus trap.
     Added here: backdrop click, [data-close] buttons, focus restore.
     ========================================================================== */
  const returnFocus = new WeakMap();

  /** Open a dialog as modal and remember where focus should return. */
  function openDialog(dialog) {
    if (dialog.open) return;
    returnFocus.set(dialog, document.activeElement);
    dialog.showModal();
    const body = dialog.querySelector('.dialog-body');
    if (body) body.scrollTop = 0;
  }

  /** Shared behaviour for every dialog: close buttons, backdrop click, focus restore. */
  function bindDialog(dialog) {
    dialog.addEventListener('click', (event) => {
      // The dialog has no padding, so a click on the dialog itself is a backdrop click.
      if (event.target === dialog || event.target.closest('[data-close]')) dialog.close();
    });
    dialog.addEventListener('close', () => {
      const previous = returnFocus.get(dialog);
      if (previous && document.contains(previous) && typeof previous.focus === 'function') previous.focus();
      returnFocus.delete(dialog);
    });
  }

  /** Open the help guide. */
  function openHelp() {
    openDialog(els.helpDialog);
  }

  /* ==========================================================================
     17  THEME
     "auto" follows the system. The choice is saved in localStorage and
     applied before first paint by the inline script in index.html.
     ========================================================================== */
  /** Saved theme, or "auto" when missing/unknown. */
  function readTheme() {
    const saved = readStorage(STORAGE_KEYS.theme);
    return THEMES.includes(saved) ? saved : 'auto';
  }

  /** Apply a theme to the page, browser bar and theme button. */
  function applyTheme(theme) {
    state.theme = theme;
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);

    updateThemeColorMeta(theme);
    const next = nextTheme(theme);
    els.themeBtn.replaceChildren(svgIcon(`theme-${theme}`));
    els.themeBtn.setAttribute('aria-label', `Theme: ${theme}. Switch to ${next}`);
    els.themeBtn.title = `Theme: ${theme} (click for ${next})`;
  }

  /** Match the browser bar (mobile) to a manually chosen theme; restore defaults for "auto". */
  function updateThemeColorMeta(theme) {
    document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
      if (!meta.dataset.default) meta.dataset.default = meta.content;
      meta.content = THEME_BAR_COLORS[theme] || meta.dataset.default;
    });
  }

  /** auto → light → dark → auto */
  function nextTheme(theme) {
    return THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  }

  /** Theme button: switch to the next theme and remember it. */
  function cycleTheme() {
    const theme = nextTheme(state.theme);
    applyTheme(theme);
    writeStorage(STORAGE_KEYS.theme, theme);
    showToast(`Theme: ${theme}`);
  }

  /* ==========================================================================
     18  KEYBOARD SHORTCUTS
     Ignored while typing, while a dialog is open, or with Alt held.
     Keep this list in sync with the help guide (index.html) and README.
     ========================================================================== */
  const SHORTCUTS = {
    s: savePalette,
    l: openLibrary,
    e: openExport,
    '?': openHelp,
    '+': addColor,
    '=': addColor, // "+" without Shift on most keyboards
    '-': removeColor,
  };

  /** Global keydown: try each kind of shortcut in turn. */
  function handleShortcuts(event) {
    if (shouldIgnoreKey(event)) return;
    const key = event.key.toLowerCase();

    if (event.metaKey || event.ctrlKey) {
      handleHistoryKeys(event, key); // other Ctrl/⌘ combos stay with the browser
      return;
    }
    if (handleSpaceKey(event, key) || handleLockKey(event, key)) return;

    const action = SHORTCUTS[event.key] || SHORTCUTS[key];
    if (!action) return;
    event.preventDefault();
    action();
  }

  /** Shortcuts are off while typing, while a dialog is open, with Alt, or on key repeat. */
  function shouldIgnoreKey(event) {
    return (
      event.defaultPrevented ||
      event.altKey ||
      event.repeat ||
      Boolean(document.querySelector('dialog[open]')) ||
      isTypingTarget(event.target)
    );
  }

  /** Ctrl/⌘ Z = undo; Shift Ctrl/⌘ Z or Ctrl Y = redo. */
  function handleHistoryKeys(event, key) {
    if (key !== 'z' && key !== 'y') return;
    event.preventDefault();
    stepHistory(key === 'y' || event.shiftKey ? 1 : -1);
  }

  /**
   * Space = generate — unless a button has focus (Space presses that button).
   * @returns {boolean} true when the key was Space
   */
  function handleSpaceKey(event, key) {
    if (key !== ' ') return false;
    if (!event.target.closest('button, a, [role="button"]')) {
      event.preventDefault();
      generate();
    }
    return true;
  }

  /**
   * 1–8 = lock/unlock that color.
   * @returns {boolean} true when the key was a digit 1–8
   */
  function handleLockKey(event, key) {
    if (!/^[1-8]$/.test(key)) return false;
    const index = Number(key) - 1;
    if (index < state.palette.length) {
      event.preventDefault();
      toggleLock(index);
    }
    return true;
  }

  /* ==========================================================================
     19  INIT
     ========================================================================== */
  /** Wire every listener, grouped by area of the page. */
  function bindEvents() {
    bindTopbar();
    bindToolbar();
    bindSwatches();
    bindDialogs();
    document.addEventListener('keydown', handleShortcuts);
    window.addEventListener('hashchange', handleHashChange);
  }

  /** Help + theme buttons. */
  function bindTopbar() {
    els.helpBtn.addEventListener('click', openHelp);
    els.themeBtn.addEventListener('click', cycleTheme);
  }

  /** Mode, generate, count, history, share/save/library/export. */
  function bindToolbar() {
    els.modeSelect.addEventListener('change', handleModeChange);
    els.generateBtn.addEventListener('click', generate);
    els.addColorBtn.addEventListener('click', addColor);
    els.removeColorBtn.addEventListener('click', removeColor);
    els.undoBtn.addEventListener('click', () => stepHistory(-1));
    els.redoBtn.addEventListener('click', () => stepHistory(1));
    els.shareBtn.addEventListener('click', copyShareLink);
    els.saveBtn.addEventListener('click', savePalette);
    els.libraryBtn.addEventListener('click', openLibrary);
    els.exportBtn.addEventListener('click', openExport);
  }

  /** One delegated listener per event type covers every swatch. */
  function bindSwatches() {
    els.swatches.addEventListener('click', handleSwatchClick);
    els.swatches.addEventListener('input', handleSwatchInput);
    els.swatches.addEventListener('change', handleSwatchChange);
  }

  /** Shared dialog behaviour + library and export controls. */
  function bindDialogs() {
    [els.libraryDialog, els.exportDialog, els.helpDialog].forEach(bindDialog);
    els.libraryList.addEventListener('click', handleLibraryClick);
    els.libraryUndoBtn.addEventListener('click', undoDelete);
    els.libraryDialog.addEventListener('close', hideUndoDelete);
    els.exportDialog.addEventListener('change', (event) => {
      if (event.target.name === 'exportFormat') renderExport();
    });
    els.exportCopyBtn.addEventListener('click', copyExport);
    els.exportDownloadBtn.addEventListener('click', downloadExport);
  }

  /** Start the app: restore settings, pick the first palette, wire events. */
  function init() {
    applyTheme(readTheme());

    if (supportsPopover) {
      els.toast.setAttribute('popover', 'manual');
      els.toast.hidden = false; // the popover state controls visibility from now on
    }

    state.mode = readMode();
    els.modeSelect.value = state.mode;

    state.saved = readSaved();
    updateLibraryCount();

    // Start from a shared link if there is one, otherwise a fresh palette.
    updatePalette(readHash() || freshPalette(DEFAULT_COLORS, state.mode));
    bindEvents();
  }

  init();
})();
