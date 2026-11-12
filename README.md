# Ofer's School of Rock Pro

A local, dependency-free chord and tab reader for Ofer's School of Rock, built
after inspecting the Ultimate Guitar reader with REA (reverse-engineering MCP)
and the in-app browser. It reproduces that reader's layout and behaviour, not
its content: all sample songs are traditional / public-domain material written
for this project.

**Live static copy:** https://oferpop.github.io/ofer-s-school-of-rock/ — guest
mode only (no accounts/comments; those need `server.py`).

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
- Search-first landing: a hero search, guitar/bass/ukulele instrument links, a
  featured (top rated) tab with an excerpt, and a "Popular right now" rail
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
- **Display modes** — Tab (ASCII), Notes (staff notation) or Both; the melody is
  rendered on a treble staff with clefs, barlines, accidentals and ledger lines
- **Play tab** — plays what is written: ASCII tablature note by note, or the
  chord lines one bar each, with synthesized plucks, count-in and loop. Every
  song opens at its own tempo (the catalog ships the original BPM; imports read
  `Tempo: 120` from the pasted text or use the field).
  Bends (`7b9`), bend-and-release (`7b9r7`), slides (`7/9`, `9\7`),
  hammer-ons/pull-offs (`7h9`) and vibrato (`7~`) are played as pitch movement
  or articulated note pairs, not as separate columns; dead notes (`x`) become
  muted thumps, harmonics (`<7>`, `<12>`) are pitched from the harmonic series
  and taps (`t12`) are normal strikes. The staff draws a bend arrow, an X for
  dead notes, a diamond for harmonics and a T for taps
- **Playhead** — a vertical marker follows the exact column being played, with a
  progress bar in the transport; click any point in the tab (or the bar) and
  playback jumps there and continues
- **A–B loop** — with Loop on, drag across the tablature to select the phrase:
  the range is drawn on the rows and on the progress bar and repeats until you
  clear it; the A and B buttons drop boundaries at the playhead
- **Space** toggles play/pause anywhere on a song page (except while typing)
- **Follow** — listens to the microphone (same tuner engine), shows the note the
  tab expects next, advances when you play it, counts wrong notes, and keeps the
  highlighted line and playhead on the note you owe. It accepts the same pitch
  class an octave away (melodies are often played in another position), needs a
  new attack for repeated notes, and Skip moves on; it stops at the end
- **Video** — every catalog song ships with a YouTube video (each id checked
  with YouTube's oEmbed endpoint); a link you paste replaces it and is saved
  with the tab and synced to the account. There is also a direct “YouTube” link
  on the tab line. The poster never contacts YouTube: the `youtube-nocookie`
  iframe is created only when you press play
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

**Transcribe (`#/transcribe`)**
- Load an audio file you own; the analyser folds each frame into 12 pitch
  classes (bass-weighted), scores them against major, minor, 7th, m7, sus4 and
  dim shapes, smooths the result and writes a chord chart. Dividing each
  template score by its number of chord tones keeps plain triads from losing to
  their own seventh
- The tempo comes from onset-flux autocorrelation with a comb and a 110 BPM
  prior (no double/half-time errors on steady material). When the chord changes
  are regular, the fitted change period corrects the octave and decides how many
  chords belong in a bar (1–4), so bar-delimited charts keep half-bar changes
- Charts open in the reader as a `chords` song with the detected key and tempo;
  the player spreads each bar's chords evenly across its four beats. Analysis
  shows a spinner, a percentage bar and elapsed time
- Everything runs in the browser: nothing is uploaded, and the app never
  downloads audio from YouTube or Spotify

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
- Labelled tablature (`e|--0--`) and unlabelled Ultimate Guitar style blocks
  (4–6 numeric rows) are recognised as tab, so the player and the Notes view
  work on pasted tabs too
- **Album tabs** with `number N` markers (and an optional `1.title` list at the
  top) can be split into one song per track: the import builds the songs, fills
  in the track names, detects open tunings per track and puts them in a playlist
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
- Stability: a 0.012 RMS gate rejects pick noise and room sound, readings need a
  clarity below 0.22, and the shown note is the median of the last five readings
  with two agreeing frames before it may change
- `noteFromFrequency()` maps Hz to a note, octave and cents around A4 = 440
- Reference tones are short triangle-wave envelopes; the microphone is stopped
  and the AudioContext closed whenever the page or tuning changes

`js/player.js`
- Parses a sheet into timed events: contiguous ASCII tablature blocks are read
  column by column (one character ≈ a 16th note, two-digit frets supported) and
  each column becomes a chord of MIDI notes from the song's tuning; otherwise
  the chord lines play one bar per chord, honouring transpose/flats/simplify
- Karplus-Strong plucks (noise burst into a damped delay line), scheduled ahead
  on the Web Audio clock; the transport tracks position, pause/resume, loop and
  a four-click count-in
- The reader highlights every line of the sounding block (or chord line) and
  scrolls it into view

`js/staff.js`
- Draws the same parsed events as a treble staff: five lines, G-clef, 4/4 time,
  barlines every 16 columns, rotated note heads, stems, sharps and ledger lines
- Four bars per row, so a long melody wraps; the staff block carries the source
  line range, which is how the player highlights it

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
- The tab player is an approximation, not a transcription: tablature timing
  assumes one character per 16th note, chord playback uses generated voicings
  (one bar per chord) rather than the recorded guitar, and transposition shifts
  chord playback but not tablature fret numbers
- Playlists, saved tabs and stats are per account on that server only
- "More versions" only shows when another entry shares a title and type
- No Guitar Pro / Power Tab rendering — chord sheets and ASCII tabs only
- Catalog is 27 hand-written songs — 14 public-domain pieces, three original
  OSR solo studies (E minor rock, 12-bar blues in A, country in G), two bass
  arrangements (House of the Rising Sun and a blues-in-A study), the public-domain
  melody "יונתן הקטן" (Hänschen klein) with tab and staff, and seven
  harmony-and-structure charts (The Way Things Go, plus Can't Stop, Under the
  Bridge, Californication, Scar Tissue, Otherside and Dani California). The
  RHCP entries carry chords, sections and playing notes only: no lyrics, and
  riff/solo transcriptions go through `#/import` instead

## Layout notes

Breakpoints follow the real site: a 258px version rail above 1000px, a sticky
chord panel beside the sheet on wide screens, and a stacked single-column reader
below that.
