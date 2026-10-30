# Chroma — Color Palette Generator

Generate color palettes that work together. Lock the colors you like, fine-tune them, check their contrast, save palettes, and export them as code.
Everything runs in the browser and nothing is uploaded.

To use it, open `index.html` in a modern browser (Chrome, Edge, Safari or Firefox). There's no build step and no server.

---

## Project structure

```
Palette_Generator/
├── index.html           Page structure, swatch template, dialogs, help text
├── README.md            This file
├── package.json         Lint/format scripts (Node is NOT needed to run the app)
├── eslint.config.mjs    JavaScript rules (ESLint recommended + strict equality, const, no var)
├── .stylelintrc.json    CSS rules (stylelint-config-standard, BEM class names allowed)
├── .htmlvalidate.json   HTML rules (html-validate recommended, Prettier-compatible)
├── .prettierrc.json     Formatting (Prettier, single quotes, 110 columns)
└── assets/
    ├── css/style.css    All styling: design tokens, components, breakpoints
    └── js/app.js        All behaviour: color math, generation, UI
```

Each file starts with a **table of contents**. Section numbers in comments (for example `section 06`) refer to those tables.

---

## Features

- **Generate.** Uses one of six harmony modes, or `auto`, which picks a different mode each time.
- **Lock.** Locked colors stay put. New palettes are built around the hue of the first locked color.
- **Pick.** The native color picker sets a color by hand, and the picked color locks automatically.
- **Copy.** Click HEX, RGB or HSL on any swatch to copy it.
- **Contrast.** Each swatch shows its WCAG contrast against white and against black, graded AAA, AA, AA large or fail.
- **2–8 colors, undo/redo.** Undo keeps the last 100 steps.
- **Share link.** The URL hash always holds the palette, for example `index.html#3ddc97-2f80ed-f2c94c`.
- **Library.** Up to 60 palettes are saved in `localStorage`. After a delete, an **undo** option appears for a few seconds.
- **Export.** Available as CSS variables, SCSS, a Tailwind config, JSON or a HEX list, to copy or download.
- **Themes.** Light, dark and auto. A help guide is built in.

---

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` | New palette (when no button has focus) |
| `1`–`8` | Lock / unlock that color |
| `+` / `-` | Add / remove a color |
| `Ctrl/⌘ Z` | Undo |
| `Shift Ctrl/⌘ Z` or `Ctrl Y` | Redo |
| `S` | Save palette |
| `L` | Saved palettes |
| `E` | Export |
| `?` | Help guide |
| `Esc` | Close a dialog |

---

## Common changes

### Edit the help guide
The help guide is plain HTML in **`index.html`**, inside `<dialog id="helpDialog">`. Edit the text directly. If you add a shortcut, list it in three places: the help guide, `SHORTCUTS` in `app.js` (section 18), and the table above.

### Add a harmony mode
1. In **`app.js` → section 06**, add a function to `HARMONIES`. It receives `(baseHue, count)` and returns `count` objects shaped `{ h, s, l }`.
2. In **`index.html`**, add an `<option>` to `#modeSelect` with the same name as its `value`.
3. Optional: to let `auto` pick the new mode, add it to `AUTO_HARMONIES`.

### Add an export format
1. In **`app.js` → section 15**, add an entry to `EXPORTERS` with `file`, `mime` and `build(colors)`.
2. In **`index.html`**, add a radio to the export dialog's `.format-picker` with the same `value`.

### Add or change an icon
All icons are drawn once in the **sprite** at the top of `<body>` in `index.html`. Each one is a `<symbol id="i-NAME" viewBox="0 0 24 24">` holding 24×24 line art. To use an icon in HTML, write `<svg class="icon" aria-hidden="true"><use href="#i-NAME"/></svg>`; from JavaScript, call `svgIcon('NAME')`. Line width and caps come from `.icon` in `style.css`.

### Change colors, fonts or spacing
Edit the design tokens in **`style.css` → section 01**. The light theme is in `:root`. The dark theme appears **twice**: once for the manual setting and once for `auto`. Keep both blocks identical, and re-check contrast (it must stay at least 4.5:1) if you change any text color.

### Tune limits
Limits are constants in **`app.js` → section 01**: `MIN_COLORS`, `MAX_COLORS`, `DEFAULT_COLORS`, `MAX_HISTORY` and `MAX_SAVED`.

---

## Code checks

Node.js is **only** needed for these checks. The app itself runs from `index.html` without it.

```sh
npm install          # once: downloads the checkers into node_modules/
npm run lint         # HTML + CSS + JS + formatting; must pass before shipping
npm run format       # auto-format every file with Prettier
```

| Tool | Checks | Config |
|---|---|---|
| html-validate | Valid HTML, accessible names, ARIA usage | `.htmlvalidate.json` |
| Stylelint | Modern, error-free CSS | `.stylelintrc.json` |
| ESLint | JavaScript bugs and unsafe patterns | `eslint.config.mjs` |
| Prettier | Consistent formatting | `.prettierrc.json` |

Formatting is left to Prettier; the linters only check correctness.

---

## Standards followed

- **Accessibility (WCAG 2.1 AA).** Interface text has contrast of at least 4.5:1. Swatch text is black or white, whichever has the higher contrast; every generated color reaches at least 4.58:1. There is a skip link, a `<noscript>` message and visible focus rings. Native `<dialog>` elements provide the focus trap and Esc to close. Each dialog has its own status region, because content outside an open dialog is hidden from screen readers. Toolbar buttons that can't act use `aria-disabled` rather than `disabled`, so keyboard focus stays on them. The lock buttons use `aria-pressed`. Screen readers hear a live-region announcement for each action. Reduced motion is respected.
- **Security.** All dynamic text is inserted with `textContent`; `innerHTML` is used only for trusted icon constants. Saved data is validated before use.
- **Responsive and mobile-first.** Phones show stacked rows and tablets get a roomier toolbar (≥600px). Desktops get full-height columns (≥900px), and container queries shrink text when a column is narrow. Short desktop windows scroll instead of squashing the swatches. The mobile browser bar color follows the chosen theme.
- **Robustness.** Storage, clipboard and download failures are shown to the user and logged with a `Chroma:` prefix. When the async clipboard API is unavailable, for example on `file://` in some browsers, copying falls back to an older method.
- **Code style.** The code uses `'use strict'` and has no build tools. Every function has a JSDoc comment and is no longer than 25 lines. Each file has a table of contents.
