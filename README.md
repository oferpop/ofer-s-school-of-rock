# Ofer's School of Rock

A local, dependency-free chord and tab reader for Ofer's School of Rock, built
after inspecting the Ultimate Guitar reader with REA (reverse-engineering MCP)
and the in-app browser. It reproduces that reader's layout and behaviour, not
its content: all sample songs are traditional / public-domain material written
for this project.

## Run it

```bash
git clone https://github.com/oferpop/ofer-s-school-of-rock.git
cd ofer-s-school-of-rock
python3 -m http.server 4173
# open http://127.0.0.1:4173
```

No build step, no npm install. Plain ES modules — they need to be served over
HTTP, so opening `index.html` from the filesystem will not work.

## What's implemented

**Catalog (`#/`)**
- Song catalog with search across title / artist / key
- Type filters (Chords, Tab, Ukulele, Bass) and sort by rating or views
- Cards with rating, vote count, views, key and difficulty
- Save / unsave straight from the card

**Tab reader (`#/song/:id`)**
- Title, view/save/comment stats, author and difficulty line
- `Tuning · Key · Capo` header that tracks transposition
- Monospace chord sheet with chord chips, `[Section]` headers and ASCII tab blocks
- **Autoscroll** with adjustable speed (0.1 → 1.0), stops at the page bottom
- **Transpose** ±11 semitones — chords, the key label and every diagram update
- **Use flats** (C# → Db) applied on top of any transposition
- **Simplify** — strips extensions and slash basses (`B7` → `B`, `C#7` → `C#`)
- **Text size** A− / A+
- **Save** to My tabs (localStorage) and **Print** (dedicated print stylesheet)
- Sidebar rail: sign-in placeholders, "More versions" sibling tabs, author note
- Chord panel with generated SVG diagrams for every chord used in the song

**My tabs (`#/saved`)** — everything saved on this device.

**Import (`#/import`)**
- Paste any chord sheet or ASCII tab, give it a title, artist, key, tuning and
  capo, and it opens in the full reader — transpose, diagrams, simplify,
  autoscroll and print all work on it
- Imported tabs are listed in the catalog with an `Imported` badge, sort and
  search alongside the shipped ones, and can be deleted from the reader
- They live in `localStorage` (`osr.imported.v1`) and never touch the repo, so
  material you have access to stays on your machine

## Content policy

The catalog holds public-domain songs plus chord charts and original studies
written for this project. Third-party lyrics and note-for-note transcriptions
are deliberately absent — that is what `#/import` is for: you supply the text,
it stays in your browser.

## How the interesting parts work

`js/chords.js`
- **Parsing** — `C`, `Am`, `F#m7`, `B7`, `Bb/D` → root, quality, slash bass
- **Transposition** — semitone arithmetic on root and bass, with a sharp/flat
  preference layer
- **Simplification** — collapses extensions to a plain major/minor triad
- **Shapes** — a curated table for common open chords, then an algorithmic
  fallback: it brute-forces fret combinations from the 1st to the 10th position
  and keeps the best shape that (a) contains only chord tones, (b) puts the root
  (or slash bass) on the lowest sounding string, (c) spans ≤ 4 frets and
  (d) sounds at least 4 strings
- **Diagrams** — hand-built SVG, no libraries

`js/app.js`
- Hash router (`#/`, `#/song/:id`, `#/saved`) with full re-render on state change
- Per-song viewer state: transpose, flats, simplify, font scale, autoscroll speed
- Autoscroll uses `requestAnimationFrame` with delta-time so speed is
  frame-rate independent

## Deliberate gaps

- No backend, accounts, comments, ratings submission or PDF export
- Sign up / Log in are inert placeholders (no auth)
- "More versions" only shows when another entry shares a title and type
- No Guitar Pro / Power Tab rendering — chord sheets and ASCII tabs only
- Catalog is 19 hand-written songs — 14 public-domain pieces, one
  chords-and-structure chart for "The Way Things Go" (no lyrics), one for
  "Can't Stop" (harmony and song map only — riff and solo go through Import)
  and three original OSR solo studies (E minor rock, 12-bar blues in A,
  country in G)

## Layout notes

Breakpoints follow the real site: a 258px version rail above 1000px, a sticky
chord panel beside the sheet on wide screens, and a stacked single-column reader
below that.
