# Ofer's School of Rock Pro

A local, dependency-free chord and tab reader for Ofer's School of Rock, built
after inspecting the Ultimate Guitar reader with REA (reverse-engineering MCP)
and the in-app browser. It reproduces that reader's layout and behaviour, not
its content: all sample songs are traditional / public-domain material written
for this project.

The **Pro** layer adds playlists, a metronome, practice tracking, tab export and
backups. Like the reader, it is client-side only: there is no account, no server
and nothing leaves the browser.

## Run it

```bash
git clone https://github.com/oferpop/ofer-s-school-of-rock.git
cd ofer-s-school-of-rock
python3 server.py                # http://127.0.0.1:4173
```
No build step, no npm install, no third-party packages. `server.py` serves the
static files and the accounts API, and creates `data/osr.db` (SQLite) on first
run. Plain ES modules still need to be served over HTTP, so opening
`index.html` from the filesystem will not work.

The app also runs on any static host with **guest mode only**: without
`server.py` the signup/login pages explain that accounts need the local server.

### Deploy

- **GitHub Pages** — `.github/workflows/pages.yml` publishes `index.html`,
  `css/`, `js/` and `favicon.svg` on every push to `main`. It is a static
  deployment: guest mode, playlists, metronome, tuner, videos, ratings, backup
  and print all work; accounts and comments need the Python server.
- **Full app** — run `python3 server.py` on a host with a persistent disk (the
  SQLite file lives in `data/`), behind a TLS proxy. Set `HOST`/`PORT` to bind
  elsewhere, e.g. `HOST=0.0.0.0 PORT=8080 python3 server.py`.

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
- **Save** to My tabs (localStorage), **Export .txt**, **Print / PDF**
- **Video** — paste a YouTube link per song; it is saved with the tab and
  synced to the account. The poster never contacts YouTube: the
  `youtube-nocookie` iframe is created only when you press play
- **Add to playlist** from the toolbar, or create a playlist in place
- **Metronome** — 40–240 BPM, ±5 steps, tap tempo, 2/3/4/6 beats per bar with an
  accented downbeat and a beat indicator
- Sidebar rail: sign-in placeholders, "More versions" sibling tabs, author note
- Chord panel with generated SVG diagrams for every chord used in the song
- When opened from a playlist: a context bar with the list name, position and
  **Prev / Next** (wrapping), so a set list plays end to end

**My tabs (`#/saved`)** — everything saved on this device.

**Artists (`#/artists`, `#/artist/:slug`)**
- Every artist in the catalog and your imports, with tab counts
- Artist pages list that artist's tabs with the normal cards and save buttons

**Charts (`#/charts`)**
- Most viewed and highest rated, ten each; imports are never ranked

**Learn (`#/learn`)**
- Four short original lessons: reading a chord sheet, transpose/capo, practising
  with the metronome, building a set list

**Tuner (`#/tuner`)**
- Chromatic tuner from the microphone: note, octave, cents and a needle, with an
  in-tune band of ±5 cents
- Reference tones for guitar (standard, drop D, half step down), 4-string bass
  and ukulele; the chosen tuning is remembered
- Audio is analysed in the page and never recorded or uploaded

**Ratings and comments**
- Rate any tab 1–5 stars; the rating is yours alone, stored with the account and
  cleared by clicking the same star again
- Comments are shared across accounts on the server: anyone can read, signed-in
  users can post (1–1000 characters, 20 per hour), and only the author can
  delete. Text is escaped, never rendered as markup

**Playlists (`#/playlists`,
`#/playlist/:id`)**
- Create, rename and delete playlists; each card shows its songs and **Play all**
- Playlist detail: numbered set list, remove a song, and a filterable picker to
  add any catalog or imported tab
- Playback context travels in the hash (`#/song/:id?list=:listId`), so refresh
  and back/forward keep the set list

**Pro (`#/pro`)**
- Practice log: minutes counted while the metronome or autoscroll runs, per tab
- Stats: practice minutes, tabs practised, saved tabs, playlists
- **Backup** — one JSON file with saved tabs, playlists, imported sheets and
  practice stats; **Restore** merges nothing and replaces that state after
  validating the file shape

**Accounts (`#/signup`, `#/login`)**
- Real signup and login against `server.py`: scrypt-hashed passwords with a
  per-user salt, random session tokens in an httpOnly `SameSite=Lax` cookie
  (only the SHA-256 of the token is stored), same-origin checks on writes, and
  rate limits per IP and per account
- Saved tabs, playlists, imported sheets and practice time live on the server
  for a signed-in user and are loaded on every device; edits sync after ~3 s
  and on page unload
- Signing in with an account that already has data replaces this browser's
  copy; signing in to an empty account adopts the tabs already on this device
- Logging out clears this browser's copy so the next person starts clean


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
- Hash router (`#/`, `#/song/:id`, `#/saved`, `#/playlists`, `#/playlist/:id`,
  `#/pro`) with full re-render on state change
- Per-song viewer state: transpose, flats, simplify, font scale, autoscroll speed
- Autoscroll uses `requestAnimationFrame` with delta-time so speed is
  frame-rate independent

`js/pro.js`
- **Playlists** — `osr.playlists.v1`: id, name, creation time and ordered song ids
- **Videos** — `osr.videos.v1`: one YouTube id + title per song, synced with the account
- **Practice log** — `osr.practice.v1`: seconds per song, written once a second
  while the metronome or autoscroll runs (no idle reading credit)
- **Metronome** — Web Audio, scheduled 120 ms ahead in 25 ms ticks so the click
  does not drift with timers; accented first beat, 40–240 BPM, tap tempo averages
  the last five taps
- **Backup/restore** — validates the JSON shape and rebuilds state only from
  fields this app writes; unknown keys are dropped

`server.py`
- Standard library only: `ThreadingHTTPServer` for static files plus a JSON API,
  SQLite in `data/osr.db`, `hashlib.scrypt` for passwords, `secrets` for session
  tokens, and in-memory sliding-window rate limits
- `GET /api/auth/me`, `POST /api/auth/signup|login|logout`,
  `GET|PUT /api/state`,
  `GET /api/comments?song=`, `POST /api/comments`, `DELETE /api/comments/<id>`
- Writes require a same-origin `Origin`/`Referer`; `/data`, `server.py` and
  dotfiles are never served; API responses are `no-store`

`js/auth.js`
- Same-origin fetch helper with a 204 path, `probe()` for "is an accounts server
  here?", and `keepalive` state pushes on unload

`js/tuner.js`
- `getUserMedia` (echo cancellation and gain control off) → `AnalyserNode`
- YIN pitch detection (difference function + cumulative-mean normalisation) at
  ~14 readings per second, with parabolic interpolation; tested from E1 (41 Hz)
  to A4 (440 Hz), silence returns no reading
- `noteFromFrequency()` maps Hz to a note, octave and cents around A4 = 440
- Reference tones are short triangle-wave envelopes; the microphone is stopped
  and the AudioContext closed whenever the page or tuning changes

## Security notes

- Passwords are never stored or logged in clear text; scrypt uses a per-user
  salt and constant-time comparison, and unknown emails still pay the same hash
  cost so timing does not reveal which addresses exist.
- Sessions survive restarts (stored in SQLite) and expire after 30 days.
- The included server speaks plain HTTP and has no email delivery, so there is
  no verification mail or password-reset flow. For anything beyond localhost,
  put it behind a TLS reverse proxy; the session cookie gets `Secure`
  automatically when the request is HTTPS.
- This is an account system for a local practice app, not a multi-tenant
  service: there is no admin UI, audit log or backup automation.
- Video links are user-supplied: only an 11-character YouTube id clears
  validation (`watch`, `youtu.be`, `shorts`, `embed`, `live`, or a bare id), and
  the embed URL is rebuilt from that id, so no pasted text becomes markup.
- Nothing loads from YouTube until the play button is pressed, and the iframe
  is a `youtube-nocookie` embed with `referrerpolicy="strict-origin-when-cross-origin"`.
- Comments are plain text: escaped on render, length-capped, rate-limited to 20
  per hour per account, and deletable only by their author. There is no
  moderation queue, reporting or editing.
- Microphone audio is analysed locally by the tuner and never sent anywhere;
  the browser still asks for permission each session, and no audio is stored.

## Deliberate gaps

- No cloud sync beyond the local `server.py`; no OAuth/social login, email
  verification or password reset
- Comments have no moderation, reporting, editing or pagination beyond the
  newest 200 per song; ratings are private to each account
- The tuner is chromatic with a fixed A4 = 440 Hz: it detects one note at a time,
  has no strobe or polyphonic display and no per-instrument calibration beyond
  the reference tones
- Playlists, saved tabs and stats are per account on that server only
- "More versions" only shows when another entry shares a title and type
- No Guitar Pro / Power Tab rendering — chord sheets and ASCII tabs only
- Catalog is 24 hand-written songs — 14 public-domain pieces, three original
  OSR solo studies (E minor rock, 12-bar blues in A, country in G), and seven
  harmony-and-structure charts (The Way Things Go, plus Can't Stop, Under the
  Bridge, Californication, Scar Tissue, Otherside and Dani California). The
  RHCP entries carry chords, sections and playing notes only: no lyrics, and
  riff/solo transcriptions go through `#/import` instead

## Layout notes

Breakpoints follow the real site: a 258px version rail above 1000px, a sticky
chord panel beside the sheet on wide screens, and a stacked single-column reader
below that.
