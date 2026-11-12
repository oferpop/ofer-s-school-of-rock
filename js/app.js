import { songs, byId, versionsOf } from "./data.js?v=20261112ba";
import {
  isChordToken,
  chordTokensByLine,
  transposeChord,
  simplifyChord,
  diagramSVG,
  uniqueChords,
} from "./chords.js?v=20261112ba";
import {
  loadPlaylists,
  persistPlaylists,
  newPlaylist,
  playlistOf,
  loadPractice,
  addPractice,
  persistPractice,
  loadVideos,
  persistVideos,
  loadRatings,
  persistRatings,
  loadTempos,
  persistTempos,
  practiceTotals,
  practiceBySong,
  clampBpm,
  beatChoices,
  Metronome,
  downloadText,
  buildBackup,
  readBackup,
} from "./pro.js?v=20261112ba";

import {
  probe,
  signup as apiSignup,
  login as apiLogin,
  logout as apiLogout,
  pullState,
  pushState,
} from "./auth.js?v=20261112ba";
import { listComments, addComment, deleteComment } from "./comments.js?v=20261112ba";
import { Tuner, TUNINGS, midiToNote } from "./tuner.js?v=20261112ba";
import { parseSong, TabPlayer, countIn, tabBlockEnd, matchesTargets } from "./player.js?v=20261112ba";
import { renderStaff } from "./staff.js?v=20261112ba";
import { parseMusicXml, parseMxl, parseMidi, renderScore, paintScoreAt, scoreMeta } from "./notation.js?v=20261112ba";
import { chordsToChart, detectNotesAsync, estimateChordsAsync, estimateTempo, notesToTab } from "./transcribe.js?v=20261112ba";

const SAVED_KEY = "ugclone.saved.v1";
const IMPORTED_KEY = "osr.imported.v1";
const CAPOS_KEY = "osr.capos.v1";

function loadCapos() {
  try {
    const raw = JSON.parse(localStorage.getItem(CAPOS_KEY));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function persistCapos(map) {
  localStorage.setItem(CAPOS_KEY, JSON.stringify(map));
}

const ENTRIES_KEY = "osr.entries.v1";

function loadEntries() {
  try {
    const raw = JSON.parse(localStorage.getItem(ENTRIES_KEY) || "{}");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function persistEntries(map) {
  localStorage.setItem(ENTRIES_KEY, JSON.stringify(map));
}

function loadInstrumentVolume() {
  const raw = localStorage.getItem("osr.player.volume");
  if (raw === null) return 80;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 80;
}

function loadClickVolume() {
  const raw = localStorage.getItem("osr.player.clickvolume");
  if (raw === null) return 55;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 55;
}

function clampCapo(value) {
  const number = Math.round(Number(value) || 0);
  return Math.max(0, Math.min(9, number));
}

// Tabs pasted by the reader live only in this browser — they are never part of
// the shipped catalog, so the repo carries no third-party transcriptions.
let imported = loadImported();

const state = {
  query: "",
  type: "all",
  sort: "relevance",
  saved: new Set(loadSaved()),
  playlists: loadPlaylists(),
  videos: loadVideos(),
  ratings: loadRatings(),
  tempos: loadTempos(),
  capos: loadCapos(),
  entries: loadEntries(),
  picker: "",
  backupNote: "",
  display: localStorage.getItem("osr.display") || "tab",
  layout: localStorage.getItem("osr.layout") || "cards",
  sortDir: "desc",
  showVideo: false,
  videoEditing: false,
  videoError: "",
  tunerTuning: localStorage.getItem("osr.tuning.v1") || "guitar",
  tunerMode: localStorage.getItem("osr.tunermode.v1") || "auto",
  tunerString: -1,
  // accounts
  user: null,
  authAvailable: null,
  authBusy: false,
  authError: "",
  authMode: "login",
  // per-song viewer state
  transpose: 0,
  flats: false,
  simplify: false,
  fontScale: 1,
  playing: false,
  speed: 0.2,
};

const metro = new Metronome();
const tuner = new Tuner();
const tabPlayer = new TabPlayer();

const playerState = {
  open: false,
  bpm: Number(localStorage.getItem("osr.player.bpm")) || 100,
  countIn: localStorage.getItem("osr.player.countin") !== "off",
  loop: localStorage.getItem("osr.player.loop") === "on",
  click: localStorage.getItem("osr.player.click") === "on",
  clickVolume: loadClickVolume(),
  instrument: localStorage.getItem("osr.player.instrument") || "auto",
  volume: loadInstrumentVolume(),
  status: "stopped",
  parsed: null,
  songId: null,
  loopStart: 0,
  loopEnd: 0,
  tempoSongId: null,
};

function playerInstrument(parsed) {
  if (playerState.instrument === "auto") {
    return parsed?.kind === "score" ? "piano" : "guitar";
  }
  return playerState.instrument === "piano" ? "piano" : "guitar";
}

let playerTicker = null;

const followState = {
  active: false,
  index: 0,
  correct: 0,
  wrong: 0,
  armed: true,
  lastHeard: 0,
  flashTimer: null,
};

let autoScrollRaf = null;
let practiceTimer = null;
let practiceSong = null;
let tunerRunning = false;
let applyingRemote = false;
let syncTimer = null;
let syncPending = false;

function loadSaved() {
  try {
    return JSON.parse(localStorage.getItem(SAVED_KEY) || "[]");
  } catch {
    return [];
  }
}

function persistSaved() {
  localStorage.setItem(SAVED_KEY, JSON.stringify([...state.saved]));
  queueSync();
}

function loadImported() {
  try {
    const list = JSON.parse(localStorage.getItem(IMPORTED_KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function persistImported() {
  localStorage.setItem(IMPORTED_KEY, JSON.stringify(imported));
  queueSync();
}

function savePlaylists() {
  persistPlaylists(state.playlists);
  queueSync();
}

// While signed in, every local change is pushed to the account, coalesced so a
// running metronome does not turn into one request per second.
function queueSync() {
  if (!state.user || applyingRemote) return;
  syncPending = true;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => flushSync(), 3000);
}

async function flushSync(keepalive = false) {
  if (!state.user || !syncPending) return;
  syncPending = false;
  const result = await pushState(snapshotState(), { keepalive });
  if (!result.ok) syncPending = true;
}

document.addEventListener("keydown", (event) => {
  if (event.code !== "Space" || event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target;
  if (target && target.closest && target.closest("input, textarea, select, button, [contenteditable]")) return;
  const current = route();
  if (current.view !== "song") return;
  const song = findSong(current.id);
  if (!song) return;
  event.preventDefault();
  togglePlayer(song);
});

window.addEventListener("pagehide", () => {
  if (state.user && syncPending) {
    syncPending = false;
    pushState(snapshotState(), { keepalive: true });
  }
});

// Everything the reader can open: pasted tabs first, then the shipped catalog.
function catalogue() {
  return [...imported, ...songs];
}

function findSong(id) {
  return imported.find((s) => s.id === id) || byId(id);
}

const isImported = (song) => Boolean(song?.imported);

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const fmt = (n) => n.toLocaleString("en-US");

// 842,113 -> "842K", 1,204,552 -> "1.2M" (the compact "hits" column).
const compact = (n) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
};

// --- routing ------------------------------------------------------------

function route() {
  const raw = location.hash.replace(/^#/, "") || "/";
  const [path, qs] = raw.split("?");
  const params = new URLSearchParams(qs || "");
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "song" && parts[1])
    return { view: "song", id: decodeURIComponent(parts[1]), list: params.get("list") || null };
  if (parts[0] === "saved") return { view: "saved" };
  if (parts[0] === "import") return { view: "import" };
  if (parts[0] === "playlists") return { view: "playlists" };
  if (parts[0] === "playlist" && parts[1])
    return { view: "playlist", id: decodeURIComponent(parts[1]) };
  if (parts[0] === "pro") return { view: "pro" };
  if (parts[0] === "artists") return { view: "artists" };
  if (parts[0] === "artist" && parts[1]) return { view: "artist", slug: decodeURIComponent(parts[1]) };
  if (parts[0] === "charts") return { view: "charts" };
  if (parts[0] === "tuner") return { view: "tuner" };
  if (parts[0] === "transcribe") return { view: "transcribe" };
  if (parts[0] === "learn") return { view: "learn" };
  if (parts[0] === "login") return { view: "auth", mode: "login" };
  if (parts[0] === "signup") return { view: "auth", mode: "signup" };
  return { view: "explore", q: params.get("q") || state.query, t: params.get("t") || null };
}

function go(path) {
  location.hash = path;
}

window.addEventListener("hashchange", () => {
  stopAutoScroll();
  stopMetronome();
  stopPractice();
  stopTuner();
  stopFollow();
  stopPlayer();
  playerState.loopStart = 0;
  playerState.loopEnd = 0;
  tabPlayer.loopStart = 0;
  tabPlayer.loopEnd = 0;
  state.picker = "";
  state.backupNote = "";
  state.showVideo = false;
  state.videoEditing = false;
  state.videoError = "";
  state.transpose = 0;
  state.simplify = false;
  applyRouteType();
  render();
});

// The instrument links carry their filter in the hash (`#/?t=bass`); chip
// clicks only change state, so this runs on navigation, not on every render.
function applyRouteType() {
  const raw = location.hash.split("?")[1] || "";
  const type = new URLSearchParams(raw).get("t");
  state.type = type || "all";
}

// --- chrome -------------------------------------------------------------

function header() {
  const view = route().view;
  return `
    <header class="site-header">
      <a class="brand" href="#/">
        <span class="brand-mark">OSR</span>
        <span class="brand-text"><strong>Ofer's School of Rock <span class="brand-pro">PRO</span></strong><em>chords, tabs &amp; practice tools</em></span>
      </a>
      <nav class="main-nav">
        <a href="#/" class="${view === "explore" ? "is-active" : ""}">Tabs</a>
        <a href="#/artists" class="${view === "artists" || view === "artist" ? "is-active" : ""}">Artists</a>
        <a href="#/charts" class="${view === "charts" ? "is-active" : ""}">Charts</a>
        <a href="#/tuner" class="${view === "tuner" ? "is-active" : ""}">Tuner</a>
        <a href="#/transcribe" class="${view === "transcribe" ? "is-active" : ""}">Transcribe</a>
        <a href="#/saved" class="${view === "saved" ? "is-active" : ""}">My tabs</a>
        <a href="#/playlists" class="${view === "playlists" || view === "playlist" ? "is-active" : ""}">Playlists</a>
        <a href="#/import" class="${view === "import" ? "is-active" : ""}">Import</a>
        <a href="#/pro" class="${view === "pro" ? "is-active" : ""}">Pro</a>
      </nav>
      <form class="search" id="search-form" role="search">
        <input id="search-input" type="search" placeholder="chords and tabs" autocomplete="off"
               value="${esc(state.query)}" aria-label="Search songs, artists and tabs" />
        <button type="submit" aria-label="Search">Search</button>
      </form>
      <div class="auth-slot">
        ${
          state.user
            ? `<span class="auth-name" title="${esc(state.user.email)}">${esc(state.user.name)}</span>
               <button class="pill" data-logout>Log out</button>`
            : `<a class="auth-link" href="#/login">Log in</a>
               <a class="pill primary auth-signup" href="#/signup">Sign up</a>`
        }
      </div>
    </header>`;
}

// --- explore ------------------------------------------------------------

function filteredSongs() {
  const q = state.query.trim().toLowerCase();
  let list = catalogue().filter((s) => {
    const matchesType =
      state.type === "all" ||
      (state.type === "guitar" ? s.type === "chords" || s.type === "tabs" : s.type === state.type);
    const matchesQuery =
      !q ||
      s.title.toLowerCase().includes(q) ||
      s.artist.toLowerCase().includes(q) ||
      s.key.toLowerCase() === q;
    return matchesType && matchesQuery;
  });
  const direction = state.sortDir === "asc" ? 1 : -1;
  if (state.sort === "rating") list = [...list].sort((a, b) => (a.rating - b.rating) * direction);
  else if (state.sort === "views") list = [...list].sort((a, b) => (a.views - b.views) * direction);
  else if (state.sort === "title")
    list = [...list].sort((a, b) => a.title.localeCompare(b.title) * (state.sortDir === "desc" ? -1 : 1));
  return list;
}

const TYPE_LABEL = { chords: "Chords", tabs: "Tab", ukulele: "Ukulele", bass: "Bass", notation: "Score" };

function songCard(song) {
  const isSaved = state.saved.has(song.id);
  return `
    <article class="card" data-id="${song.id}">
      <a class="card-main" href="#/song/${encodeURIComponent(song.id)}">
        <div class="card-head">
          <h3>${esc(song.title)}</h3>
          <span class="badge">${TYPE_LABEL[song.type] || "Tab"}</span>
          ${isImported(song) ? `<span class="badge badge-import">Imported</span>` : ""}
        </div>
        <p class="card-artist">${esc(song.artist)}</p>
        <ul class="meta">
          ${
            isImported(song)
              ? song.notation
                ? `<li class="dim">${scoreMeta(song.notation).notes} notes</li><li class="dim">Key ${esc(
                    song.key,
                  )}</li>`
                : `<li class="dim">${song.body.split("\n").length} lines</li><li class="dim">Key ${esc(song.key)}</li>`
              : `<li><span class="star">★</span> ${song.rating.toFixed(1)} <span class="dim">(${fmt(song.votes)})</span></li>
          <li class="dim">${fmt(song.views)} views</li>
          <li class="dim">Key ${esc(song.key)}</li>
          <li class="dim difficulty-${song.difficulty}">${song.difficulty}</li>`
          }
        </ul>
      </a>
      <button class="save-btn ${isSaved ? "is-saved" : ""}" data-save="${song.id}"
              aria-pressed="${isSaved}" title="${isSaved ? "Remove from my tabs" : "Save tab"}">
        ${isSaved ? "Saved" : "Save"}
      </button>
    </article>`;
}

function popularSongs() {
  return songs
    .filter((song) => !isImported(song))
    .sort((a, b) => b.views - a.views)
    .slice(0, 6);
}

function featuredSong() {
  return [...songs].sort((a, b) => b.rating - a.rating || b.votes - a.votes)[0];
}

function typeCount(type) {
  if (type === "guitar") return songs.filter((s) => s.type === "chords" || s.type === "tabs").length;
  return songs.filter((s) => s.type === type).length;
}

function featuredBlock() {
  const song = featuredSong();
  if (!song) return "";
  return `
    <section class="featured">
      <div class="featured-info">
        <p class="featured-kicker"><span class="badge">Featured</span> top rated in the catalog</p>
        <h2><a href="${songHref(song)}">${esc(song.title)}</a></h2>
        <p class="dim featured-meta">${esc(song.artist)} · Key ${esc(song.key)} · ${esc(song.tuning)} ·
          <span class="star">★</span> ${song.rating.toFixed(1)}</p>
        <div class="pl-actions">
          <a class="pill primary" href="${songHref(song)}"><span class="ico">▶</span> Open in reader</a>
          <a class="pill" href="#/artist/${encodeURIComponent(artistSlug(song.artist))}">More by ${esc(
            song.artist,
          )}</a>
        </div>
      </div>
      <div class="featured-sheet" aria-hidden="true">${renderSheet(song, 16)}</div>
    </section>`;
}

function exploreView() {
  const list = filteredSongs();
  const types = ["all", "chords", "tabs", "notation", "ukulele", "bass"];
  const listMode = state.layout === "list";
  return `
    <main class="ws">
      <section class="hero home-hero">
        <h1>Find a tab and start playing</h1>
        <p class="hero-sub">${fmt(songs.length)} songs · chords, tabs and ukulele arrangements${
          imported.length ? ` · ${imported.length} imported tab${imported.length === 1 ? "" : "s"}` : ""
        } · <a class="learn-link" href="#/learn">new here? start with the lessons</a></p>
        <form class="hero-search" id="hero-search" role="search">
          <input id="hero-search-input" type="search" placeholder="Search songs, artists or keys" autocomplete="off"
                 value="${esc(state.query)}" aria-label="Search songs, artists or keys" />
          <button type="submit" class="pill primary">Search</button>
        </form>
        <nav class="instrument-links" aria-label="Browse by instrument">
          <a href="#/?t=guitar">Guitar <span class="count">${typeCount("guitar")}</span></a>
          <a href="#/?t=bass">Bass <span class="count">${typeCount("bass")}</span></a>
          <a href="#/?t=ukulele">Ukulele <span class="count">${typeCount("ukulele")}</span></a>
          <a href="#/?t=all">All tabs</a>
        </nav>
      </section>

      ${featuredBlock()}

      <section class="popular">
        <div class="popular-head">
          <h2>Popular right now</h2>
          <a href="#/charts">All charts</a>
        </div>
        <ol class="popular-list">
          ${popularSongs()
            .map(
              (song, i) => `<li>
                <span class="chart-rank">${i + 1}</span>
                <a class="chart-main" href="${songHref(song)}">
                  <strong>${esc(song.title)}</strong>
                  <span class="dim">${esc(song.artist)}</span>
                </a>
                <span class="chart-extra"><span class="star">★</span> ${song.rating.toFixed(1)} · ${fmt(
                  song.views,
                )}</span>
              </li>`,
            )
            .join("")}
        </ol>
      </section>

      <div class="filters">
        <div class="chips" role="group" aria-label="Filter by type">
          ${types
            .map(
              (t) =>
                `<button class="chip ${state.type === t ? "is-on" : ""}" data-type="${t}">${
                  t === "all" ? "All" : TYPE_LABEL[t]
                }</button>`,
            )
            .join("")}
        </div>
        <div class="layout-toggle pill-group" role="group" aria-label="Layout">
          <button class="pill sq ${listMode ? "" : "is-on"}" data-layout="cards" aria-pressed="${!listMode}">Cards</button>
          <button class="pill sq ${listMode ? "is-on" : ""}" data-layout="list" aria-pressed="${listMode}">List</button>
        </div>
        <label class="sort">
          Sort
          <select id="sort">
            <option value="relevance" ${state.sort === "relevance" ? "selected" : ""}>Relevance</option>
            <option value="rating" ${state.sort === "rating" ? "selected" : ""}>Rating</option>
            <option value="views" ${state.sort === "views" ? "selected" : ""}>Hits</option>
          </select>
        </label>
      </div>

      <p class="result-count">${list.length} result${list.length === 1 ? "" : "s"}${
        state.query ? ` for “${esc(state.query)}”` : ""
      }</p>

      ${
        list.length
          ? listMode
            ? songTable(list)
            : `<div class="results">${list.map(songCard).join("")}</div>`
          : `<p class="empty">No tabs match that search yet.</p>`
      }
    </main>`;
}

function sortArrow(key) {
  if (state.sort !== key) return "";
  return state.sortDir === "asc" ? " ↑" : " ↓";
}

function songTable(list) {
  const header = (key, label) =>
    `<button class="th-sort ${state.sort === key ? "is-on" : ""}" data-sort="${key}">${label}${sortArrow(key)}</button>`;
  return `
    <div class="tab-table" role="table" aria-label="Tabs">
      <div class="tab-row tab-head" role="row">
        <span>${header("title", "Song")}</span>
        <span>Artist</span>
        <span class="num">${header("rating", "Rating")}</span>
        <span class="num">${header("views", "Hits")}</span>
        <span class="type-col">Type</span>
      </div>
      ${list
        .map(
          (song) => `<a class="tab-row" role="row" href="${songHref(song)}">
            <span class="tab-song">
              <strong>${esc(song.title)}</strong>
              ${isImported(song) ? `<span class="badge badge-import">Imported</span>` : ""}
            </span>
            <span class="dim">${esc(song.artist)}</span>
            <span class="num">${isImported(song) ? "—" : `<span class="star">★</span> ${song.rating.toFixed(1)}`}</span>
            <span class="num dim">${isImported(song) ? "—" : compact(song.views)}</span>
            <span class="type-col"><span class="badge">${TYPE_LABEL[song.type] || "Tab"}</span></span>
          </a>`,
        )
        .join("")}
    </div>`;
}

// --- sheet --------------------------------------------------------------

function hasTabBlocks(song) {
  if (song.notation) return false;
  const lines = song.body.split("\n");
  return lines.some((_, index) => tabBlockEnd(lines, index) !== -1);
}

function renderSheet(song, maxLines = 0, capo = 0) {
  if (song.notation) return renderScore(song.notation, { bpm: playerState.bpm });
  const allLines = song.body.split("\n");
  const lines = maxLines ? allLines.slice(0, maxLines) : allLines;
  const chordTokens = chordTokensByLine(song.body);
  const out = [];
  let parsed = null;

  const staffFor = (start, end) => {
    if (!parsed) {
      parsed = parseSong(song, {
        bpm: playerState.bpm,
        transpose: state.transpose - (song.type === "chords" ? capo : 0),
        flats: state.flats,
        simplify: state.simplify,
      });
    }
    const inBlock = parsed.events.filter(
      (event) => event.lines[0] === start && event.lines[1] === end,
    );
    if (!inBlock.length) return "";
    const first = Math.min(...inBlock.map((event) => event.time));
    const events = inBlock.map((event) => ({
      ...event,
      column: Math.round((event.time - first) / parsed.step),
    }));
    return `<div class="staff-block" data-line-start="${start}" data-line-end="${end}">${renderStaff(events)}</div>`;
  };

  const renderLine = (line, index, inTab = false) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return `<div class="line" data-line="${index}">&nbsp;</div>`;
    }
    if (/^\[.*\]$/.test(trimmed)) {
      return `<h4 class="section" data-line="${index}">${esc(trimmed.slice(1, -1))}</h4>`;
    }

    const allowed = new Set(chordTokens[index]);
    const tokens = line.split(/(\s+)/);
    const rendered = tokens
      .map((tok) => {
        if (!tok.trim()) return esc(tok);
        if (!isChordToken(tok)) return esc(tok);
        if (!allowed.has(tok)) return esc(tok);
        let chord = tok;
        const shift = state.transpose - capo;
        if (shift) chord = transposeChord(chord, shift, state.flats);
        else if (state.flats) chord = transposeChord(chord, 0, true);
        if (state.simplify) chord = simplifyChord(chord);
        return `<span class="ch" data-chord="${esc(chord)}">${esc(chord)}</span>`;
      })
      .join("");

    return `<div class="line${inTab ? " tabline" : ""}" data-line="${index}">${rendered}</div>`;
  };

  let index = 0;
  while (index < lines.length) {
    const end = tabBlockEnd(lines, index);
    if (end !== -1) {
      if (state.display !== "tab") {
        const staff = staffFor(index, end);
        if (staff) out.push(staff);
      }
      if (state.display !== "notes") {
        const rowsOut = [];
        for (let i = index; i <= end; i++) rowsOut.push(renderLine(lines[i], i, true));
        out.push(
          `<div class="tab-block" data-line-start="${index}" data-line-end="${end}">` +
            `<span class="tab-loop-band" aria-hidden="true" hidden></span>` +
            `<span class="tab-playhead" aria-hidden="true" hidden></span>${rowsOut.join("")}</div>`,
        );
      }
      index = end + 1;
      continue;
    }
    out.push(renderLine(lines[index], index));
    index += 1;
  }

  return `<div class="sheet" style="--sheet-font: ${(15 * state.fontScale).toFixed(1)}px">${out.join("")}</div>`;
}

function chordPanel(song, capo = 0) {
  const chords = uniqueChords(song.body)
    .map((c) => {
      let chord = c;
      const shift = state.transpose - capo;
      if (shift) chord = transposeChord(chord, shift, state.flats);
      else if (state.flats) chord = transposeChord(chord, 0, true);
      if (state.simplify) chord = simplifyChord(chord);
      return chord;
    })
    .filter((c, i, arr) => arr.indexOf(c) === i);

  if (!chords.length) return "";
  return `
    <aside class="chord-panel">
      <h3>Chords</h3>
      <div class="diagrams">
        ${chords
          .map((c) => `<figure class="diagram"><div class="dgm">${diagramSVG(c)}</div><figcaption>${esc(c)}</figcaption></figure>`)
          .join("")}
      </div>
    </aside>`;
}

function transposeKey(key) {
  if (!state.transpose && !state.flats) return key;
  const out = transposeChord(key, state.transpose, state.flats);
  return out === key ? key : out;
}

// --- pro helpers --------------------------------------------------------

function songHref(song, listId = null) {
  const base = `#/song/${encodeURIComponent(song.id)}`;
  return listId ? `${base}?list=${encodeURIComponent(listId)}` : base;
}

function listSongs(list) {
  return list.songIds.map(findSong).filter(Boolean);
}

function neighbour(items, id, step) {
  if (!items.length) return null;
  const at = items.findIndex((s) => s.id === id);
  if (at === -1) return step > 0 ? items[0] : items[items.length - 1];
  return items[(at + step + items.length) % items.length];
}

function slug(text) {
  return (
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "tab"
  );
}

function tabText(song) {
  return [
    `${song.title} — ${song.artist}`,
    `${TYPE_LABEL[song.type] || "Tab"} · Key ${transposeKey(song.key)} · Tuning ${song.tuning} · Capo ${song.capo}`,
    "",
    song.body,
    "",
    "Exported from Ofer's School of Rock Pro",
  ].join("\n");
}

// --- ratings & comments -------------------------------------------------

function ratingRow(song) {
  const mine = Number(state.ratings[song.id]) || 0;
  return `
    <div class="rating-row" role="group" aria-label="Your rating">
      <span class="rating-label">Your rating</span>
      <div class="stars">
        ${[1, 2, 3, 4, 5]
          .map(
            (n) => `<button class="star-btn ${n <= mine ? "is-on" : ""}" data-rate="${n}"
              aria-label="${n} star${n === 1 ? "" : "s"}" aria-pressed="${n <= mine}">★</button>`,
          )
          .join("")}
      </div>
      <span class="dim rating-value">${mine ? `${mine}/5` : "not rated"}</span>
    </div>`;
}

function commentsSection() {
  return `
    <section class="comments" id="comments">
      <h2>Comments <span class="dim" id="comment-count"></span></h2>
      <form class="comment-form" id="comment-form" hidden>
        <textarea name="body" rows="3" maxlength="1000" required
          placeholder="Share a tip, a correction or how you play it…"></textarea>
        <div class="comment-actions">
          <button class="pill primary" type="submit">Post comment</button>
          <span class="comment-error" id="comment-error" role="alert"></span>
        </div>
      </form>
      <p class="comment-login dim" id="comment-login" hidden>Log in to join the discussion.</p>
      <div class="comment-list" id="comments-list"><p class="dim">Loading comments…</p></div>
    </section>`;
}

// --- videos -------------------------------------------------------------

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

// Only YouTube links (or a bare 11-character id) are accepted: the embed URL
// is rebuilt from the id, never from the pasted text.
function youtubeId(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  if (YOUTUBE_ID.test(raw)) return raw;

  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  const host = url.hostname.replace(/^(www|m)\./, "");
  let id = null;
  if (host === "youtu.be") {
    id = url.pathname.slice(1).split("/")[0];
  } else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (url.pathname === "/watch") id = url.searchParams.get("v");
    else {
      const match = url.pathname.match(/^\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{11})/);
      if (match) id = match[1];
    }
  }
  return id && YOUTUBE_ID.test(id) ? id : null;
}

function videoPanel(song) {
  if (!state.showVideo) return "";
  const saved = state.videos[song.id];
  const builtin = !saved && song.youtube ? { id: song.youtube, builtin: true } : null;
  const video = saved || builtin;
  const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(
    `${song.artist} ${song.title}`,
  )}`;
  const editing = state.videoEditing || !video;

  if (video && !editing) {
    return `
      <section class="video-block" aria-label="Song video">
        <div class="video-frame" id="video-frame" data-video-id="${esc(video.id)}">
          <button class="video-poster" data-video-play aria-label="Play video">
            <span class="video-play" aria-hidden="true">▶</span>
            <span class="video-title">${esc(video.title || `${song.title} — ${song.artist}`)}</span>
            <span class="video-sub">${builtin ? "Built-in video" : "Your video"} · YouTube loads only when pressed</span>
          </button>
        </div>
        <div class="video-actions">
          <a class="pill" href="https://www.youtube.com/watch?v=${esc(video.id)}" target="_blank" rel="noopener noreferrer">Watch on YouTube</a>
          <button class="pill" id="video-edit">Replace video</button>
          ${builtin ? "" : `<button class="pill danger" id="video-remove">Remove</button>`}
          <a class="pill" href="${searchUrl}" target="_blank" rel="noopener noreferrer">Find another</a>
        </div>
      </section>`;
  }

  return `
    <section class="video-block" aria-label="Song video">
      <form class="video-form" id="video-form">
        <label>YouTube link
          <input name="url" placeholder="https://www.youtube.com/watch?v=…" required autocomplete="off" />
        </label>
        <label>Title <span class="dim">(optional)</span>
          <input name="title" maxlength="120" placeholder="${esc(song.title)}" autocomplete="off" />
        </label>
        <div class="video-form-actions">
          <button class="pill primary" type="submit">${video ? "Save video" : "Add video"}</button>
          ${video ? `<button class="pill" type="button" id="video-cancel">Cancel</button>` : ""}
        </div>
      </form>
      <p class="video-error" role="alert">${esc(state.videoError)}</p>
      <p class="video-hint dim">
        Only YouTube links are embedded, and the player loads only when you press play.
        <a href="${searchUrl}" target="_blank" rel="noopener noreferrer">Search YouTube for this song</a>
      </p>
    </section>`;
}


function togglePlaylistSong(playlistId, songId) {
  state.playlists = state.playlists.map((list) =>
    list.id === playlistId
      ? {
          ...list,
          songIds: list.songIds.includes(songId)
            ? list.songIds.filter((id) => id !== songId)
            : [...list.songIds, songId],
        }
      : list,
  );
  savePlaylists();
  render();
}

function deletePlaylist(playlistId) {
  state.playlists = state.playlists.filter((list) => list.id !== playlistId);
  savePlaylists();
}


function songView(id) {
  const song = findSong(id);
  if (!song) {
    return `<main class="ws"><p class="empty">That tab does not exist. <a href="#/">Back to the catalog</a>.</p></main>`;
  }
  // Each song carries its own tempo: load it for the player and metronome.
  const songBpm = clampBpm(Number(state.tempos[song.id] ?? song.bpm) || 100);
  const capo = clampCapo(state.capos[song.id]);
  const score = song.notation ? scoreMeta(song.notation) : null;
  const editTools = score
    ? ""
    : `
          <button class="pill ${state.simplify ? "is-on" : ""}" id="simplify" aria-pressed="${state.simplify}">Simplify</button>
          <div class="pill-group" role="group" aria-label="Transpose">
            <button class="pill sq" id="down" aria-label="Transpose down">−</button>
            <span class="pill sq value" title="Semitones">${state.transpose > 0 ? "+" : ""}${state.transpose}</span>
            <button class="pill sq" id="up" aria-label="Transpose up">+</button>
          </div>
          <button class="pill ${state.flats ? "is-on" : ""}" id="flats" aria-pressed="${state.flats}">Use flats</button>
          <div class="pill-group" role="group" aria-label="Text size">
            <button class="pill sq" id="font-down" aria-label="Smaller text">A−</button>
            <button class="pill sq" id="font-up" aria-label="Larger text">A+</button>
          </div>
          ${
            hasTabBlocks(song)
              ? `<div class="pill-group" role="group" aria-label="Display mode">
                   ${["tab", "notes", "both"]
                     .map(
                       (mode) =>
                         `<button class="pill sq display-btn ${state.display === mode ? "is-on" : ""}" data-display="${mode}">${
                           mode === "tab" ? "Tab" : mode === "notes" ? "Notes" : "Both"
                         }</button>`,
                     )
                     .join("")}
                 </div>`
              : ""
          }`;
  if (playerState.tempoSongId !== song.id || playerState.bpm !== songBpm) {
    playerState.tempoSongId = song.id;
    playerState.bpm = songBpm;
    metro.setBpm(songBpm);
  }

  const importedSong = isImported(song);
  const versions = importedSong ? [] : versionsOf(song);
  const isSaved = state.saved.has(song.id);
  const listId = route().list;
  const list = listId ? playlistOf(state.playlists, listId) : null;
  const items = list ? listSongs(list) : [];
  const position = list ? items.findIndex((s) => s.id === song.id) : -1;
  const prev = list ? neighbour(items, song.id, -1) : null;
  const next = list ? neighbour(items, song.id, 1) : null;
  return `
    <main class="ws song-layout">
      <aside class="rail">
        <div class="rail-player">
          <h3 class="rail-title">Player</h3>
          ${playerBar(song)}
        </div>
        ${
          versions.length
            ? `<h3 class="rail-title">More versions</h3>
               <ul class="versions">
                 <li class="is-current"><a href="#/song/${song.id}">Official</a><span><span class="star">★</span> ${song.rating.toFixed(
                   1,
                 )} <span class="dim">(${fmt(song.votes)})</span></span></li>
                 ${versions
                   .map(
                     (v) =>
                       `<li><a href="#/song/${v.id}">${esc(v.title)}</a><span><span class="star">★</span> ${v.rating.toFixed(
                         1,
                       )} <span class="dim">(${fmt(v.votes)})</span></span></li>`,
                   )
                   .join("")}
               </ul>`
            : ""
        }
        <div class="rail-note">
          ${
            importedSong
              ? `<strong>${score ? "Imported score" : "Imported tab"}</strong>
                 <p>Stored in this browser only — not part of the catalog in the repo.</p>
                 <button class="pill danger" id="delete-import">Delete this ${score ? "score" : "tab"}</button>`
              : `<strong>About the author</strong>
                 <p>${esc(song.author)} — ${fmt(song.saves)} saves, ${fmt(song.comments)} comments.</p>`
          }
        </div>
      </aside>

      <article class="song">
        <h1 class="song-title">${esc(song.title)} ${TYPE_LABEL[song.type] || "Tab"} <span>by</span> ${esc(song.artist)}</h1>
        ${
          importedSong
            ? `<p class="stats">${
                score
                  ? `Imported score · ${score.notes} notes · ${score.measures} measures`
                  : `Imported on this device · ${song.body.split("\n").length} lines`
              }</p>`
            : `<p class="stats">${fmt(song.views)} views · ${fmt(song.saves)} saves · ${fmt(song.comments)} comments</p>`
        }
        <p class="byline">
          ${
            importedSong
              ? `${
                  score ? "Imported from a score file" : "Pasted into this browser"
                } · <span class="badge badge-import">Imported</span>`
              : `Author: ${esc(song.author)} · <span class="difficulty-${song.difficulty}">${song.difficulty}</span>
          · <span class="star">★</span> ${song.rating.toFixed(1)}`
          }
        </p>

        ${ratingRow(song)}

        ${
          list
            ? `<div class="playlist-bar">
                 <span class="pb-label">Playlist</span>
                 <a class="pb-name" href="#/playlist/${encodeURIComponent(list.id)}">${esc(list.name)}</a>
                 <span class="dim">${position === -1 ? "not in this list" : `${position + 1} of ${items.length}`}</span>
                 ${
                   prev
                     ? `<a class="pill" href="${songHref(prev, list.id)}">◀ Prev</a>`
                     : `<span class="pill is-off">◀ Prev</span>`
                 }
                 ${next ? `<a class="pill" href="${songHref(next, list.id)}">Next ▶</a>` : `<span class="pill is-off">Next ▶</span>`}
               </div>`
            : ""
        }

        <div class="toolbar">
          <button class="pill primary" id="autoscroll" aria-pressed="${state.playing}">
            <span class="ico">${state.playing ? "❚❚" : "▶"}</span> Autoscroll
          </button>
          <button class="pill" id="speed">Speed: ${state.speed.toFixed(1)}</button>
          ${editTools}
          <button class="pill ${isSaved ? "is-on" : ""}" id="save" aria-pressed="${isSaved}">${isSaved ? "Saved" : "Save"}</button>
          ${
            score
              ? ""
              : `<button class="pill ${state.showVideo ? "is-on" : ""}" id="video-toggle" aria-pressed="${state.showVideo}">Video</button>`
          }
          <form class="add-list" id="add-list-form">
            <select id="list-select" name="list" aria-label="Add to playlist">
              <option value="">Add to playlist…</option>
              ${state.playlists
                .map(
                  (p) =>
                    `<option value="${p.id}" ${p.songIds.includes(song.id) ? "disabled" : ""}>${esc(p.name)}${
                      p.songIds.includes(song.id) ? " (added)" : ""
                    }</option>`,
                )
                .join("")}
            </select>
            <input name="new" placeholder="or new playlist" aria-label="New playlist name" maxlength="60" />
            <button class="pill" type="submit">Add</button>
          </form>
          ${score ? "" : `<button class="pill" id="export-tab">Export .txt</button>`}
          <button class="pill" id="print">Print / PDF</button>
          ${
            importedSong || score
              ? ""
              : `<a class="pill" href="#/import?title=${encodeURIComponent(song.title)}&artist=${encodeURIComponent(
                  song.artist,
                )}&key=${encodeURIComponent(song.key)}&type=${encodeURIComponent(song.type)}">Add a tab for this song</a>`
          }
        </div>

        <p class="tab-meta">${
          score
            ? `Score <span>·</span> Key: ${esc(score.key || "—")} <span>·</span> ${esc(score.time)} <span>·</span> ${
                score.staves === 2
                  ? "Grand staff"
                  : score.clef === "bass"
                    ? "Bass staff"
                    : "Treble staff"
              }`
            : `Tuning: ${esc(song.tuning)} <span>·</span> Key: ${esc(transposeKey(song.key))} <span>·</span>
          <span class="capo-edit" title="${esc(song.capo)}">Capo
            <button class="pill sq capo-step" id="capo-down" aria-label="Capo down" ${
              capo <= 0 ? "disabled" : ""
            }>−</button>
            <span class="pill sq value" id="capo-value">${capo}</span>
            <button class="pill sq capo-step" id="capo-up" aria-label="Capo up" ${
              capo >= 9 ? "disabled" : ""
            }>+</button>
          </span>`
        } <span>·</span> <label class="tempo-edit">Tempo
          <input id="tempo-input" type="number" min="40" max="240" step="1" value="${songBpm}" aria-label="Song tempo in BPM" /> BPM</label>${
          song.youtube
            ? ` <span>·</span> <a class="youtube-link" href="https://www.youtube.com/watch?v=${esc(
                song.youtube,
              )}" target="_blank" rel="noopener noreferrer">YouTube</a>`
            : ""
        }</p>

        <div class="practice-bar">
          <span class="pb-label">Practice</span>
          <button class="pill primary" id="metro" aria-pressed="${metro.on}">
            <span class="ico">${metro.on ? "❚❚" : "▶"}</span> Metronome
          </button>
          <div class="pill-group" role="group" aria-label="Tempo">
            <button class="pill sq" id="bpm-down" aria-label="Slower">−</button>
            <span class="pill sq value" id="bpm-value" title="Beats per minute">${metro.bpm}</span>
            <button class="pill sq" id="bpm-up" aria-label="Faster">+</button>
          </div>
          <span class="bpm-unit">BPM</span>
          <button class="pill" id="tap-tempo">Tap tempo</button>
          <label class="pill-select">Beats
            <select id="beats">
              ${beatChoices()
                .map((n) => `<option value="${n}" ${metro.beats === n ? "selected" : ""}>${n}</option>`)
                .join("")}
            </select>
          </label>
          <div class="beat-dots" id="beat-dots" aria-hidden="true">
            ${Array.from({ length: metro.beats }, (_, i) => `<span class="dot" data-beat="${i}"></span>`).join("")}
          </div>
        </div>

        ${videoPanel(song)}

        <div class="timeline-card">
          <div class="timeline-head">
            <span class="timeline-title">Timeline</span>
            <span class="dim" id="timeline-info"></span>
            <button class="pill sq" id="timeline-add-entry" title="Mark an entry at the player position">+ Entry</button>
          </div>
          <div class="timeline" id="timeline" role="slider" aria-label="Song timeline"
               aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" tabindex="0">
            <div class="timeline-ticks" id="timeline-ticks"></div>
            <span class="timeline-loop" id="timeline-loop" hidden></span>
            <span class="timeline-pulse" id="timeline-pulse" aria-hidden="true"></span>
            <span class="timeline-playhead" id="timeline-playhead" aria-hidden="true"></span>
          </div>
          <p class="timeline-hint dim">Click to play from a point · drag to loop · Alt-click to mark an entry</p>
        </div>

        <div class="sheet-wrap${score ? " score-only" : ""}">
          ${renderSheet(song, 0, capo)}
          ${score ? "" : chordPanel(song, capo)}
        </div>

        ${commentsSection()}
      </article>
    </main>`;
}

function savedView() {
  const list = catalogue().filter((s) => state.saved.has(s.id));
  return `
    <main class="ws">
      <section class="hero">
        <h1>My tabs</h1>
        <p class="hero-sub">${list.length} saved tab${list.length === 1 ? "" : "s"} on this device</p>
      </section>
      <div class="results">
        ${list.length ? list.map(songCard).join("") : `<p class="empty">Nothing saved yet. Hit <strong>Save</strong> on a tab.</p>`}
      </div>
    </main>`;
}

// --- artists & charts ---------------------------------------------------

function artistSlug(name) {
  return (
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unknown"
  );
}

function artistGroups() {
  const groups = new Map();
  for (const song of catalogue()) {
    const slug = artistSlug(song.artist);
    if (!groups.has(slug)) groups.set(slug, { slug, name: song.artist, songs: [] });
    groups.get(slug).songs.push(song);
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function artistsView() {
  const groups = artistGroups();
  return `
    <main class="ws">
      <section class="hero">
        <h1>Artists</h1>
        <p class="hero-sub">${groups.length} artists · ${catalogue().length} tabs, including everything you imported.</p>
      </section>
      <div class="artist-grid">
        ${groups
          .map(
            (group) => `<a class="artist-card" href="#/artist/${encodeURIComponent(group.slug)}">
              <strong>${esc(group.name)}</strong>
              <span class="dim">${group.songs.length} tab${group.songs.length === 1 ? "" : "s"}</span>
            </a>`,
          )
          .join("")}
      </div>
    </main>`;
}

function artistView(slug) {
  const group = artistGroups().find((entry) => entry.slug === slug);
  if (!group) {
    return `<main class="ws"><p class="empty">No tabs for that artist. <a href="#/artists">All artists</a>.</p></main>`;
  }
  return `
    <main class="ws">
      <section class="hero">
        <p class="crumb"><a href="#/artists">Artists</a></p>
        <h1>${esc(group.name)}</h1>
        <p class="hero-sub">${group.songs.length} tab${group.songs.length === 1 ? "" : "s"} in this catalog.</p>
      </section>
      <div class="results">${group.songs.map(songCard).join("")}</div>
    </main>`;
}

function chartsView() {
  const shipped = songs.filter((song) => !isImported(song));
  const byViews = [...shipped].sort((a, b) => b.views - a.views).slice(0, 10);
  const byRating = [...shipped]
    .sort((a, b) => b.rating - a.rating || b.votes - a.votes)
    .slice(0, 10);
  const row = (song, index, extra) => `<li>
    <span class="chart-rank">${index + 1}</span>
    <a class="chart-main" href="${songHref(song)}">
      <strong>${esc(song.title)}</strong>
      <span class="dim">${esc(song.artist)}</span>
    </a>
    <span class="chart-extra">${extra}</span>
  </li>`;
  return `
    <main class="ws">
      <section class="hero">
        <h1>Charts</h1>
        <p class="hero-sub">The catalog's most-played and best-rated tabs. Your own imports are not ranked.</p>
      </section>
      <div class="chart-grid">
        <section class="chart-block">
          <h2>Most viewed</h2>
          <ol class="chart-list">
            ${byViews.map((song, i) => row(song, i, `${fmt(song.views)} views`)).join("")}
          </ol>
        </section>
        <section class="chart-block">
          <h2>Highest rated</h2>
          <ol class="chart-list">
            ${byRating.map((song, i) => row(song, i, `<span class="star">★</span> ${song.rating.toFixed(1)}`)).join("")}
          </ol>
        </section>
      </div>
    </main>`;
}

function learnView() {
  const lessons = [
    {
      title: "Reading a chord sheet",
      body: `A chord sheet is a map, not a score. The words in brackets are sections
        ([Intro], [Verse 1]); the letters above the words are the chords, one per bar
        unless two are crowded together. When you see an ASCII block under the chords
        (the e|—B|—G|— lines) that is a riff written as tab: each line is a string,
        each number a fret.`,
    },
    {
      title: "Transpose, capo and the key label",
      body: `Transposing moves every chord by the same number of semitones, so the
        shapes keep their relationships. The key label follows along. If the shapes get
        awkward, put a capo on and transpose down: a capo on 2 with shapes in G sounds
        in A. "Use flats" only changes how the same chord is spelled — Bb instead of A#.`,
    },
    {
      title: "Practise with the metronome",
      body: `Set a tempo you can play cleanly, not the tempo you want. Start the
        metronome, play one section, and only then raise it by five BPM. The first beat
        of every bar is accented so you can hear where the bar starts. Tap tempo matches
        a recording: tap four or five times along with it.`,
    },
    {
      title: "Build a set list that flows",
      body: `Group songs by key and tempo so transitions are easy, and put the one you
        are least sure of early rather than last. A playlist plays end to end with the
        metronome running, and the practice log counts only the time the metronome or
        autoscroll is actually on.`,
    },
  ];
  return `
    <main class="ws">
      <section class="hero">
        <h1>Learn</h1>
        <p class="hero-sub">Short, original notes on getting more out of the reader.</p>
      </section>
      <div class="lesson-list">
        ${lessons
          .map(
            (lesson, i) => `<article class="lesson">
              <span class="lesson-num">${i + 1}</span>
              <h2>${esc(lesson.title)}</h2>
              <p>${esc(lesson.body.replace(/\s+/g, " ").trim())}</p>
            </article>`,
          )
          .join("")}
      </div>
    </main>`;
}

function tunerView() {
  const tuning = TUNINGS[state.tunerTuning] || TUNINGS.guitar;
  const groups = new Map();
  for (const [key, entry] of Object.entries(TUNINGS)) {
    const group = entry.group || "Other";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push([key, entry]);
  }
  // Show the highest string first, the way a headstock is drawn.
  const pegs = tuning.strings.map(([name], index) => ({ name, index })).reverse();
  const auto = state.tunerMode === "auto";
  const chromatic = state.tunerMode === "chromatic";
  const pinned = !auto && !chromatic && state.tunerString >= 0 ? tuning.strings[state.tunerString] : null;

  return `
    <main class="ws tuner-page">
      <section class="hero">
        <p class="crumb">Tool</p>
        <h1>Tuner</h1>
        <p class="hero-sub">Chromatic tuning from your microphone. Auto mode finds the string for you; tap a peg to pin one string instead. Nothing is recorded or uploaded, and reference tones work without a microphone.</p>
      </section>

      <div class="tuner-card" id="tuner-readout">
        <div class="tuner-modes" role="group" aria-label="Tuner mode">
          <button class="pill ${auto ? "is-on" : ""}" id="tuner-mode-auto" aria-pressed="${auto}">Auto string</button>
          <button class="pill ${chromatic ? "is-on" : ""}" id="tuner-mode-chromatic" aria-pressed="${chromatic}">Chromatic</button>
        </div>

        <div class="tuner-headstock" id="tuner-headstock">
          ${pegs
            .map(
              ({ name, index }) => `<button class="string-peg ${
                state.tunerMode === "string" && state.tunerString === index ? "is-selected" : ""
              }" data-string="${index}" aria-pressed="${
                state.tunerMode === "string" && state.tunerString === index
              }" title="Tune ${esc(name)}"><span class="peg-name">${esc(name)}</span><span class="peg-dot" aria-hidden="true"></span></button>`,
            )
            .join("")}
        </div>

        <div class="tuner-note-row">
          <span class="tuner-note" id="tuner-note">—</span>
          <span class="tuner-octave" id="tuner-octave"></span>
        </div>
        <div class="tuner-gauge">
          <span class="tuner-center" aria-hidden="true"></span>
          <span class="tuner-marker" id="tuner-marker" aria-hidden="true"></span>
        </div>
        <p class="tuner-status" id="tuner-status">Press start and play a note.</p>
        <p class="tuner-target dim" id="tuner-target">${
          pinned ? `Target ${esc(pinned[0])} — or pick another peg` : auto ? "Auto — play any string" : "Chromatic — play any note"
        }</p>
        <p class="tuner-hz dim" id="tuner-hz"></p>
        <div class="tuner-controls">
          <button class="pill primary" id="tuner-toggle" aria-pressed="false">Start listening</button>
          <label class="pill-select">Tuning
            <select id="tuning-select">
              ${[...groups.entries()]
                .map(
                  ([group, entries]) =>
                    `<optgroup label="${esc(group)}">${entries
                      .map(
                        ([key, entry]) =>
                          `<option value="${key}" ${
                            key === state.tunerTuning ? "selected" : ""
                          }>${esc(entry.label)}</option>`,
                      )
                      .join("")}</optgroup>`,
                )
                .join("")}
            </select>
          </label>
        </div>
        <p class="tuner-error" id="tuner-error" role="alert"></p>
      </div>

      <section class="pro-block">
        <h2>Reference tones</h2>
        <p class="dim">Tap a string to hear it. These play through the speakers — no microphone needed.</p>
        <div class="tone-row" id="tone-row">
          ${tuning.strings
            .map(
              ([name, hz]) => `<button class="tone-btn" data-tone="${hz}">
                <strong>${esc(name)}</strong><span>${hz.toFixed(2)} Hz</span>
              </button>`,
            )
            .join("")}
        </div>
      </section>
    </main>`;
}

function stopTuner() {
  if (tunerRunning) tuner.stop();
  tunerRunning = false;
  const readout = document.getElementById("tuner-readout");
  const note = document.getElementById("tuner-note");
  const octave = document.getElementById("tuner-octave");
  const marker = document.getElementById("tuner-marker");
  const hz = document.getElementById("tuner-hz");
  if (readout) readout.classList.remove("is-live", "is-in-tune", "is-close");
  if (note) note.textContent = "—";
  if (octave) octave.textContent = "";
  if (marker) marker.style.left = "50%";
  if (hz) hz.textContent = "";
  document.querySelectorAll(".string-peg").forEach((peg) => {
    peg.classList.remove("is-heard", "is-tuned", "is-suggested");
  });
}

// --- tab player ---------------------------------------------------------

const clock = (seconds) => {
  const total = Math.max(0, Math.round(seconds || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

function playerBar(song = null) {
  const score = Boolean(song?.notation);
  const time = playerState.parsed ? clock(tabPlayer.position) : "0:00";
  const total = playerState.parsed ? clock(playerState.parsed.duration) : "0:00";
  const playing = playerState.status === "playing";
  return `
    <div class="player-bar" id="player-bar" data-score="${score ? "1" : "0"}">
      <span class="pb-label">Play</span>
      <button class="pill primary" id="player-toggle" aria-pressed="${playing}">
        <span class="ico">${playing ? "❚❚" : "▶"}</span> ${
          playing ? "Pause" : playerState.status === "paused" ? "Resume" : score ? "Play the score" : "Play the tab"
        }
      </button>
      <button class="pill" id="player-stop">Stop</button>
      <div class="pill-group" role="group" aria-label="Player tempo">
        <button class="pill sq" id="player-bpm-down" aria-label="Slower">−</button>
        <span class="pill sq value" id="player-bpm">${playerState.bpm}</span>
        <button class="pill sq" id="player-bpm-up" aria-label="Faster">+</button>
      </div>
      <button class="pill ${playerState.countIn ? "is-on" : ""}" id="player-countin" aria-pressed="${playerState.countIn}">Count-in</button>
      <button class="pill ${playerState.click ? "is-on" : ""}" id="player-click" aria-pressed="${playerState.click}" title="Metronome click on every beat">Click</button>
      <span class="click-volume-wrap" title="Click volume">
        <input class="click-volume" id="player-click-volume" type="range" min="0" max="100" step="1"
               value="${playerState.clickVolume}" aria-label="Click volume" />
        <span class="click-volume-value dim" id="player-click-volume-value">${playerState.clickVolume}%</span>
      </span>
      <label class="pill-select player-instrument">Sound
        <select id="player-instrument" aria-label="Playback instrument">
          ${[
            ["auto", "Auto"],
            ["piano", "Piano"],
            ["guitar", "Guitar"],
          ]
            .map(
              ([value, label]) =>
                `<option value="${value}" ${playerState.instrument === value ? "selected" : ""}>${label}</option>`,
            )
            .join("")}
        </select>
      </label>
      <span class="click-volume-wrap player-volume-wrap" title="Instrument volume">
        <input class="click-volume" id="player-volume" type="range" min="0" max="100" step="1"
               value="${playerState.volume}" aria-label="Instrument volume" />
        <span class="click-volume-value dim" id="player-volume-value">${playerState.volume}%</span>
      </span>
      <button class="pill ${playerState.loop ? "is-on" : ""}" id="player-loop" aria-pressed="${playerState.loop}">Loop</button>
      <button class="pill sq loop-mark" id="loop-a" title="Set loop start at the playhead" aria-label="Set loop start">A</button>
      <button class="pill sq loop-mark" id="loop-b" title="Set loop end at the playhead" aria-label="Set loop end">B</button>
      <button class="pill ${followState.active ? "is-on" : ""}" id="player-follow" aria-pressed="${followState.active}" title="Listen to you play and follow the tab">Follow</button>
      <span class="now-chord" id="now-chord" hidden>—</span>
      <span class="player-time dim" id="player-time">${time} / ${total}</span>
      <span class="player-kind dim" id="player-kind">${
        playerState.parsed
          ? playerState.parsed.kind === "tab"
            ? "Tablature"
            : playerState.parsed.kind === "score"
              ? "Score"
              : "Chords"
          : ""
      }</span>
      <div class="player-progress" id="player-progress" role="slider" aria-label="Playback position"
           aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" tabindex="0">
        <span class="player-loop-range" id="player-loop-range" hidden></span>
        <span class="player-progress-fill" id="player-progress-fill"></span>
      </div>
      <div class="follow-bar" id="follow-bar" ${followState.active ? "" : "hidden"}>
        <span class="follow-note" id="follow-note">—</span>
        <span class="follow-status" id="follow-status">Play the highlighted note</span>
        <span class="follow-heard dim" id="follow-heard"></span>
        <span class="follow-score dim" id="follow-score"></span>
        <button class="pill" id="follow-skip">Skip</button>
      </div>
    </div>`;
}

function updatePlayerBar() {
  const bar = document.getElementById("player-bar");
  if (!bar) return;

  const livePosition = playerState.status === "playing" ? tabPlayer.elapsed() : tabPlayer.position;
  paintTimeline(livePosition);

  const toggle = document.getElementById("player-toggle");
  if (toggle) {
    const playing = playerState.status === "playing";
    const score = bar.dataset.score === "1" || playerState.parsed?.kind === "score";
    toggle.innerHTML = `<span class="ico">${playing ? "❚❚" : "▶"}</span> ${
      playing ? "Pause" : playerState.status === "paused" ? "Resume" : score ? "Play the score" : "Play the tab"
    }`;
    toggle.setAttribute("aria-pressed", String(playing));
  }

  const bpm = document.getElementById("player-bpm");
  if (bpm) bpm.textContent = playerState.bpm;

  const time = document.getElementById("player-time");
  if (time && playerState.parsed) {
    const position = playerState.status === "playing" ? tabPlayer.elapsed() : tabPlayer.position;
    time.textContent = `${clock(position)} / ${clock(playerState.parsed.duration)}`;
  }

  if (playerState.parsed && playerState.parsed.duration) {
    const position = playerState.status === "playing" ? tabPlayer.elapsed() : tabPlayer.position;
    if (playerState.status === "playing") paintPlayheadAtTime(position);
    const pct = Math.max(0, Math.min(100, (position / playerState.parsed.duration) * 100));
    const fill = document.getElementById("player-progress-fill");
    const bar = document.getElementById("player-progress");
    if (fill) fill.style.width = `${pct}%`;
    if (bar) bar.setAttribute("aria-valuenow", String(Math.round(pct)));
  }

  const followButton = document.getElementById("player-follow");
  if (followButton) {
    followButton.classList.toggle("is-on", followState.active);
    followButton.setAttribute("aria-pressed", String(followState.active));
  }
  const followBar = document.getElementById("follow-bar");
  if (followBar) followBar.hidden = !followState.active;

  const kind = document.getElementById("player-kind");
  if (kind && playerState.parsed) {
    kind.textContent =
      playerState.parsed.kind === "tab"
        ? "Tablature"
        : playerState.parsed.kind === "score"
          ? "Score"
          : "Chords";
  }
}

function startTicker() {
  stopTicker();
  playerTicker = setInterval(updatePlayerBar, 120);
}

function stopTicker() {
  if (playerTicker) clearInterval(playerTicker);
  playerTicker = null;
}

function highlightRange(range) {
  document.querySelectorAll(".sheet .is-playing").forEach((el) => el.classList.remove("is-playing"));
  document.querySelectorAll(".sheet .staff-block").forEach((el) => el.classList.remove("is-playing"));
  if (!range) return;
  const [from, to] = range;
  for (let i = from; i <= to; i++) {
    document.querySelectorAll(`.sheet [data-line="${i}"]`).forEach((el) => el.classList.add("is-playing"));
  }
  document.querySelectorAll(".sheet .staff-block").forEach((el) => {
    if (Number(el.dataset.lineStart) === from && Number(el.dataset.lineEnd) === to) {
      el.classList.add("is-playing");
    }
  });
  const target = document.querySelector(`.sheet [data-line="${from}"]`) || document.querySelector(".sheet .staff-block.is-playing");
  if (!target) return;
  const rect = target.getBoundingClientRect();
  if (rect.top < 0 || rect.bottom > window.innerHeight) {
    target.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

// --- follow mode --------------------------------------------------------

function followEvent() {
  return playerState.parsed?.events[followState.index] || null;
}

function followLabel(event) {
  if (!event) return "—";
  const first = midiToNote(event.midi[0]);
  return event.midi.length > 1 ? `${first.name}${first.octave} +${event.midi.length - 1}` : `${first.name}${first.octave}`;
}

function paintFollow() {
  const event = followEvent();
  const note = document.getElementById("follow-note");
  if (note) note.textContent = followLabel(event);
  const status = document.getElementById("follow-status");
  if (status) status.textContent = event ? "Play the highlighted note" : "Done — nice work";
  const score = document.getElementById("follow-score");
  if (score) score.textContent = `${followState.correct} ✓ · ${followState.wrong} ✗`;
  const bar = document.getElementById("follow-bar");
  if (bar) bar.hidden = !followState.active;
  if (!event) {
    highlightRange(null);
    clearTimeout(followState.endTimer);
    followState.endTimer = setTimeout(() => stopFollow(), 2500);
    return;
  }
  clearTimeout(followState.endTimer);
  highlightRange(event.lines);
  paintPlayheadAtTime(event.time);
}

function onFollowPitch(reading) {
  if (!followState.active) return;
  const event = followEvent();
  if (!event) return;

  const heard = reading.midi + reading.cents / 100;
  const now = performance.now();
  const gap = now - (followState.lastHeard || 0);
  followState.lastHeard = now;
  if (gap > 180) followState.armed = true;

  const heardNote = midiToNote(reading.midi);
  const heardEl = document.getElementById("follow-heard");
  if (heardEl) {
    heardEl.textContent = `${heardNote.name}${heardNote.octave} ${reading.cents > 0 ? "+" : ""}${reading.cents}¢`;
  }

  if (matchesTargets(heard, event.midi, 0.8, true)) {
    if (!followState.armed) return;
    followState.armed = false;
    followState.correct += 1;
    const bar = document.getElementById("follow-bar");
    if (bar) {
      bar.classList.add("is-correct");
      clearTimeout(followState.flashTimer);
      followState.flashTimer = setTimeout(() => bar.classList.remove("is-correct"), 320);
    }
    followState.index += 1;
    paintFollow();
    return;
  }

  const expected = event.midi[0];
  if (followState.armed && Math.abs(heard - expected) > 1.2) {
    followState.armed = false;
    followState.wrong += 1;
    const status = document.getElementById("follow-status");
    if (status) {
      status.textContent = `Heard ${heardNote.name}${heardNote.octave} — expected ${followLabel(event)}`;
    }
    const score = document.getElementById("follow-score");
    if (score) score.textContent = `${followState.correct} ✓ · ${followState.wrong} ✗`;
  }
}

function showFollowError(message) {
  followState.active = false;
  updatePlayerBar();
  const bar = document.getElementById("follow-bar");
  if (bar) bar.hidden = false;
  const status = document.getElementById("follow-status");
  if (status) status.textContent = message;
}

async function startFollow(song) {
  const parsed = ensureParsed(song);
  if (!parsed.events.length) return;
  if (playerState.status === "playing") stopPlayer();
  followState.active = true;
  followState.index = 0;
  followState.correct = 0;
  followState.wrong = 0;
  followState.armed = true;
  followState.lastHeard = 0;
  updatePlayerBar();
  paintFollow();

  const started = await tuner.start({ onResult: onFollowPitch, onError: showFollowError });
  if (!started) {
    // Keep the microphone error visible instead of hiding the strip.
    followState.active = false;
  }
}

function stopFollow() {
  if (followState.active) tuner.stop();
  followState.active = false;
  clearTimeout(followState.flashTimer);
  const bar = document.getElementById("follow-bar");
  if (bar) bar.hidden = true;
  updatePlayerBar();
}

function stopPlayer() {
  tabPlayer.stop();
  stopTicker();
  highlightRange(null);
  clearPlayhead();
  playerState.status = "stopped";
  updatePlayerBar();
}

// --- playhead & seeking -------------------------------------------------

function ensureParsed(song) {
  const parsed = parseSong(song, {
    bpm: playerState.bpm,
    transpose: state.transpose,
    flats: state.flats,
    simplify: state.simplify,
  });
  playerState.parsed = parsed;
  playerState.songId = song.id;
  playerState.blocks = blockOffsets(parsed);
  return parsed;
}

function blockOffsets(parsed) {
  const map = new Map();
  for (const event of parsed.events) {
    const key = event.lines[0];
    const start = event.blockStart ?? event.time;
    const finish = event.blockEnd ?? event.time + Math.max(parsed.step, event.duration);
    const current = map.get(key);
    if (!current) {
      map.set(key, { start, end: finish, endLine: event.lines[1], step: parsed.step });
    } else {
      current.start = Math.min(current.start, start);
      current.end = Math.max(current.end, finish);
      current.endLine = event.lines[1];
    }
  }
  return map;
}

function tabCharWidth(lineEl) {
  const style = getComputedStyle(lineEl);
  if (!tabCharWidth.canvas) tabCharWidth.canvas = document.createElement("canvas");
  const ctx = tabCharWidth.canvas.getContext("2d");
  ctx.font = `${style.fontSize} ${style.fontFamily}`;
  return ctx.measureText("0").width || 8;
}

// Musical columns skip bar lines, so map a column to the character index on screen.
function visualIndex(text, column) {
  let seen = 0;
  for (let i = 2; i < text.length; i++) {
    if (text[i] === "|") continue;
    if (seen === column) return i;
    seen += 1;
  }
  return text.length;
}

// Place the playhead from a time, not from the last event, so it keeps moving
// through rests and long notes and always agrees with the progress bar.
function currentChordAt(seconds) {
  const parsed = playerState.parsed;
  if (parsed?.kind !== "chords") return null;
  let current = null;
  for (const event of parsed.events) {
    if (!event.chord) continue;
    if (event.time <= seconds + 0.001) current = event;
    else break;
  }
  return current;
}

function paintCurrentChord(event) {
  document.querySelectorAll(".sheet .ch.is-current").forEach((chord) => chord.classList.remove("is-current"));
  const now = document.getElementById("now-chord");
  if (!now) return;
  if (!event) {
    now.hidden = true;
    now.textContent = "—";
    now.classList.remove("is-on");
    return;
  }
  now.hidden = false;
  now.textContent = event.chord;
  now.classList.add("is-on");
  const lineIndex = event.lines?.[0];
  if (lineIndex === undefined) return;
  const lineEl = document.querySelector(`.sheet [data-line="${lineIndex}"]`);
  if (!lineEl) return;
  const lineEvents = playerState.parsed.events.filter(
    (item) => item.chord && item.lines[0] === lineIndex,
  );
  const order = lineEvents.indexOf(event);
  const tokens = lineEl.querySelectorAll(".ch");
  if (order >= 0 && tokens[order]) tokens[order].classList.add("is-current");
}

function paintPlayheadAtTime(seconds) {
  if (playerState.parsed?.kind === "score") {
    paintScoreAt(document.querySelector(".score-sheet"), seconds, playerState.bpm);
    return;
  }
  if (playerState.parsed?.kind === "chords") {
    paintCurrentChord(currentChordAt(seconds));
    return;
  }
  const blocks = playerState.blocks;
  if (!blocks) return;
  let key = null;
  let entry = null;
  for (const [lineStart, value] of blocks) {
    if (value.start <= seconds + 0.001) {
      key = lineStart;
      entry = value;
    }
  }
  if (!entry) return;

  const block = document.querySelector(
    `.tab-block[data-line-start="${key}"][data-line-end="${entry.endLine}"]`,
  );
  if (!block) return;
  const marker = block.querySelector(".tab-playhead");
  const row = block.querySelector(".line.tabline");
  if (!marker || !row) return;

  const column = Math.max(0, Math.round((seconds - entry.start) / entry.step));
  const left = tabCharWidth(row) * visualIndex(row.textContent, column);
  document.querySelectorAll(".tab-playhead").forEach((other) => {
    if (other !== marker) other.hidden = true;
  });
  marker.hidden = false;
  marker.style.left = `${left}px`;
}

function clearPlayhead() {
  paintTimeline(0);
  paintCurrentChord(null);
  document.getElementById("timeline-pulse")?.classList.remove("is-hit");
  document.querySelectorAll(".score-note.is-active").forEach((note) => note.classList.remove("is-active"));
  document.querySelectorAll(".tab-playhead").forEach((marker) => {
    marker.hidden = true;
    marker.style.left = "0px";
  });
  const fill = document.getElementById("player-progress-fill");
  if (fill) fill.style.width = "0%";
}

function timeAtPoint(song, block, lineEl, clientX) {
  const entry = playerState.blocks?.get(Number(block.dataset.lineStart));
  if (!entry) return null;
  const text = lineEl.textContent;
  const width = tabCharWidth(lineEl);
  const rect = lineEl.getBoundingClientRect();
  const index = Math.max(0, Math.round((clientX - rect.left) / width));
  let column = 0;
  for (let i = 2; i < Math.min(index, text.length); i++) {
    if (text[i] !== "|") column += 1;
  }
  return entry.start + column * entry.step;
}

function timeAtLinePoint(song, lineEl, clientX) {
  const parsed = ensureParsed(song);
  const index = Number(lineEl.dataset.line);
  const events = parsed.events.filter((event) => event.lines[0] === index);
  if (!events.length) {
    const next = parsed.events.find((event) => event.lines[0] >= index);
    if (next) return next.time;
    const last = parsed.events[parsed.events.length - 1];
    return last ? last.time : 0;
  }
  if (events.length === 1) return events[0].time;
  const rect = lineEl.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(0.999, (clientX - rect.left) / Math.max(1, rect.width)));
  return events[Math.min(events.length - 1, Math.floor(ratio * events.length))].time;
}

function timeAtScorePoint(event) {
  const node = document.elementFromPoint(event.clientX, event.clientY) || event.target;
  const bpm = Math.max(20, playerState.bpm || 100);
  const note = node.closest?.(".score-note");
  if (note && Number.isFinite(Number(note.dataset.start))) {
    return Number(note.dataset.start) * (60 / bpm);
  }
  const svg = document.querySelector(".score-sheet .score-svg");
  if (!svg) return null;
  const box = svg.getBoundingClientRect();
  if (event.clientY < box.top - 24 || event.clientY > box.bottom + 24) return null;
  let hit = node.closest?.(".score-hit");
  if (!hit) {
    let best = null;
    let bestDistance = Infinity;
    for (const candidate of svg.querySelectorAll(".score-hit")) {
      const rect = candidate.getBoundingClientRect();
      const dx =
        event.clientX < rect.left ? rect.left - event.clientX : event.clientX > rect.right ? event.clientX - rect.right : 0;
      const dy =
        event.clientY < rect.top ? rect.top - event.clientY : event.clientY > rect.bottom ? event.clientY - rect.bottom : 0;
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
      }
    }
    hit = best;
  }
  if (!hit) return null;
  const rect = hit.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(0.999, (event.clientX - rect.left) / Math.max(1, rect.width)));
  const quarters = Number(hit.dataset.start) + ratio * Number(hit.dataset.duration);
  return (Number.isFinite(quarters) ? quarters : 0) * (60 / bpm);
}

function timeAtTextSheetPoint(song, event) {
  const node = document.elementFromPoint(event.clientX, event.clientY) || event.target;
  ensureParsed(song);
  const block = node.closest?.(".tab-block");
  if (block) {
    const row = node.closest(".line.tabline") || block.querySelector(".line.tabline");
    if (row) {
      const seconds = timeAtPoint(song, block, row, event.clientX);
      if (seconds !== null) return seconds;
    }
  }
  let line = node.closest?.(".line[data-line]");
  if (!line) {
    const sheetEl = document.querySelector(".sheet");
    if (!sheetEl) return null;
    let best = null;
    let bestDistance = Infinity;
    for (const candidate of sheetEl.querySelectorAll(".line[data-line]")) {
      const rect = candidate.getBoundingClientRect();
      const distance = Math.abs((rect.top + rect.bottom) / 2 - event.clientY);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
      }
    }
    line = best;
  }
  if (!line) return null;
  return timeAtLinePoint(song, line, event.clientX);
}

function timeAtSheetPoint(song, event) {
  const node = document.elementFromPoint(event.clientX, event.clientY) || event.target;
  if (node.closest?.(".score-sheet")) return timeAtScorePoint(event);
  if (node.closest?.(".sheet")) return timeAtTextSheetPoint(song, event);
  return null;
}

async function seekPlayer(song, seconds, { autoplay = true } = {}) {
  const parsed = ensureParsed(song);
  let target = Math.max(0, Math.min(seconds, parsed.duration - 0.05));
  if (playerState.loop && playerState.loopEnd > playerState.loopStart) {
    target = Math.max(playerState.loopStart, Math.min(target, playerState.loopEnd - 0.05));
  }
  tabPlayer.stop();
  stopTicker();
  const resume = playerState.status === "playing" || autoplay;
  if (resume) {
    await startPlayer(song, { from: target });
    return;
  }
  playerState.status = "paused";
  tabPlayer.position = target;
  updatePlayerBar();
  paintPlayheadAtTime(target);
}

function applyLoop(song) {
  tabPlayer.loop = playerState.loop;
  tabPlayer.loopStart = playerState.loop ? playerState.loopStart : 0;
  tabPlayer.loopEnd = playerState.loop ? playerState.loopEnd : 0;
  const button = document.getElementById("player-loop");
  if (button) {
    button.classList.toggle("is-on", playerState.loop);
    button.setAttribute("aria-pressed", String(playerState.loop));
  }
  drawLoopRange();
}

function markLoopPoint(song, which) {
  const parsed = ensureParsed(song);
  const position = playerState.status === "playing" ? tabPlayer.elapsed() : tabPlayer.position;
  if (which === "a") {
    playerState.loopStart = position;
    if (playerState.loopEnd <= position + 0.1) {
      playerState.loopEnd = Math.min(parsed.duration, position + 4);
    }
  } else {
    playerState.loopEnd = position;
    if (playerState.loopStart >= position - 0.1) {
      playerState.loopStart = Math.max(0, position - 4);
    }
  }
  playerState.loop = true;
  applyLoop(song);
}

// Highlight the selected loop on the progress bar and across the tab rows.
function buildTimeline(song, parsed = ensureParsed(song)) {
  const box = document.getElementById("timeline");
  const ticks = document.getElementById("timeline-ticks");
  if (!box || !ticks) return;
  const bpm = Math.max(20, playerState.bpm || 100);
  const beats = Math.max(1, Number(parsed?.beats) || 4);
  const beatType = Math.max(1, Number(parsed?.beatType) || 4);
  const duration = Math.max(0.01, parsed?.duration || 0);
  const barSeconds = (60 / bpm) * beats;
  const barCount = Math.max(1, Math.ceil(duration / barSeconds));
  const showBeats = barCount <= 64;
  const labelEvery = Math.max(1, Math.ceil(barCount / 8));
  let html = "";
  for (let bar = 0; bar < barCount; bar++) {
    const left = (bar / barCount) * 100;
    html += `<span class="timeline-tick bar" style="left:${left}%"></span>`;
    if (bar % labelEvery === 0) {
      html += `<span class="timeline-bar-label" style="left:${left}%">${bar + 1}</span>`;
    }
    if (showBeats) {
      for (let beat = 1; beat < beats; beat++) {
        const beatLeft = ((bar + beat / beats) / barCount) * 100;
        html += `<span class="timeline-tick beat" style="left:${beatLeft}%"></span>`;
      }
    }
  }
  const fractionOf = (entry) =>
    Number.isFinite(entry.at) ? entry.at : Math.max(0, Math.min(1, (Number(entry.time) || 0) / duration));
  const entries = [...(state.entries[song.id] || [])].sort((a, b) => fractionOf(a) - fractionOf(b));
  entries.forEach((entry, index) => {
    const fraction = fractionOf(entry);
    const left = Math.max(0, Math.min(100, fraction * 100));
    html += `<span class="timeline-entry" role="button" tabindex="0" data-index="${index}" data-time="${
      fraction * duration
    }" style="left:${left}%" title="Entry ${entry.label || index + 1} — click to play, Alt-click to remove">${
      entry.label || index + 1
    }</span>`;
  });
  ticks.innerHTML = html;
  const info = document.getElementById("timeline-info");
  if (info) info.textContent = `${barCount} bar${barCount === 1 ? "" : "s"} · ${beats}/${beatType} · ${bpm} BPM`;
  paintTimeline(playerState.status === "playing" ? tabPlayer.elapsed() : tabPlayer.position);
}

function paintTimeline(seconds) {
  const box = document.getElementById("timeline");
  if (!box) return;
  const duration = Math.max(0.01, playerState.parsed?.duration || 0);
  const position = Math.max(0, Math.min(duration, Number(seconds) || 0));
  const percent = (position / duration) * 100;
  const head = document.getElementById("timeline-playhead");
  if (head) head.style.left = `${percent}%`;
  box.setAttribute("aria-valuenow", String(Math.round(percent)));

  const loop = document.getElementById("timeline-loop");
  if (loop) {
    const active = playerState.loop && playerState.loopEnd > playerState.loopStart + 0.05;
    loop.hidden = !active;
    if (active) {
      loop.style.left = `${(playerState.loopStart / duration) * 100}%`;
      loop.style.width = `${((playerState.loopEnd - playerState.loopStart) / duration) * 100}%`;
    }
  }

  const pulse = document.getElementById("timeline-pulse");
  if (pulse) {
    pulse.style.left = `${percent}%`;
    const bpm = Math.max(20, playerState.bpm || 100);
    const beat = 60 / bpm;
    const beatIndex = Math.floor(position / beat);
    if (playerState.status === "playing" && box.dataset.beat !== String(beatIndex)) {
      box.dataset.beat = String(beatIndex);
      pulse.classList.remove("is-hit");
      void pulse.offsetWidth;
      pulse.classList.add("is-hit");
    }
  }
}

function timeAtTimelinePoint(song, event) {
  const box = document.getElementById("timeline");
  if (!box) return null;
  const rect = box.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(0.999, (event.clientX - rect.left) / Math.max(1, rect.width)));
  return ratio * ensureParsed(song).duration;
}

function addTimelineEntry(song, time) {
  if (!Number.isFinite(time)) return;
  const duration = Math.max(0.01, ensureParsed(song).duration);
  const at = Math.max(0, Math.min(1, time / duration));
  const list = [...(state.entries[song.id] || [])];
  const fractionOf = (entry) =>
    Number.isFinite(entry.at) ? entry.at : Math.max(0, Math.min(1, (Number(entry.time) || 0) / duration));
  if (list.some((entry) => Math.abs(fractionOf(entry) - at) < 0.005)) return;
  const label = list.reduce((max, entry) => Math.max(max, Number(entry.label) || 0), 0) + 1;
  list.push({ at, label });
  list.sort((a, b) => fractionOf(a) - fractionOf(b));
  state.entries = { ...state.entries, [song.id]: list };
  persistEntries(state.entries);
  buildTimeline(song);
}

function removeTimelineEntry(song, index) {
  const list = [...(state.entries[song.id] || [])];
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return;
  list.splice(index, 1);
  if (list.length) {
    state.entries = { ...state.entries, [song.id]: list };
  } else {
    const next = { ...state.entries };
    delete next[song.id];
    state.entries = next;
  }
  persistEntries(state.entries);
  buildTimeline(song);
}

function drawScoreLoop() {
  const svg = document.querySelector(".score-sheet .score-svg");
  const layer = svg?.querySelector(".score-loop-layer");
  if (!svg || !layer) return;
  layer.innerHTML = "";
  if (!playerState.loop || playerState.loopEnd <= playerState.loopStart + 0.05) return;
  const bpm = Math.max(20, playerState.bpm || 100);
  const quartersPerSecond = bpm / 60;
  const a = playerState.loopStart * quartersPerSecond;
  const b = playerState.loopEnd * quartersPerSecond;
  svg.querySelectorAll(".score-hit").forEach((hit) => {
    const start = Number(hit.dataset.start);
    const duration = Number(hit.dataset.duration);
    if (!(duration > 0)) return;
    const from = Math.max(start, a);
    const to = Math.min(start + duration, b);
    if (!(to > from)) return;
    const x = Number(hit.getAttribute("x"));
    const width = Number(hit.getAttribute("width"));
    const y = Number(hit.getAttribute("y"));
    const height = Number(hit.getAttribute("height"));
    const rx = x + ((from - start) / duration) * width;
    const rw = Math.max(1, ((to - from) / duration) * width);
    layer.insertAdjacentHTML(
      "beforeend",
      `<rect class="score-loop-band" x="${rx}" y="${y}" width="${rw}" height="${height}" />`,
    );
  });
}

function drawChordLoop(parsed) {
  document.querySelectorAll(".sheet .line.has-loop").forEach((line) => {
    line.classList.remove("has-loop");
    line.style.removeProperty("--loop-left");
    line.style.removeProperty("--loop-width");
  });
  if (!playerState.loop || playerState.loopEnd <= playerState.loopStart + 0.05) return;
  if (parsed?.kind !== "chords") return;
  const lines = document.querySelectorAll(".sheet .line[data-line]");
  for (const line of lines) {
    const index = Number(line.dataset.line);
    const events = parsed.events.filter((event) => event.chord && event.lines[0] === index);
    if (!events.length) continue;
    const tokens = line.querySelectorAll(".ch");
    if (!tokens.length) continue;
    const first = events.findIndex((event) => event.time >= playerState.loopStart - 0.001);
    if (first === -1) continue;
    let last = -1;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].time <= playerState.loopEnd + 0.001) {
        last = i;
        break;
      }
    }
    if (last < first) continue;
    const startToken = tokens[Math.min(first, tokens.length - 1)];
    const endToken = tokens[Math.min(last, tokens.length - 1)];
    const left = playerState.loopStart <= events[0].time ? 0 : startToken.offsetLeft;
    const right =
      playerState.loopEnd >= events[events.length - 1].time
        ? line.clientWidth
        : endToken.offsetLeft + endToken.offsetWidth;
    const width = Math.max(4, right - left);
    line.classList.add("has-loop");
    line.style.setProperty("--loop-left", `${left}px`);
    line.style.setProperty("--loop-width", `${width}px`);
  }
}

function drawLoopRange() {
  const parsed = playerState.parsed;
  const active = parsed && playerState.loopEnd > playerState.loopStart + 0.05;
  const range = document.getElementById("player-loop-range");
  if (range) {
    range.hidden = !active;
    if (active) {
      range.style.left = `${(playerState.loopStart / parsed.duration) * 100}%`;
      range.style.width = `${((playerState.loopEnd - playerState.loopStart) / parsed.duration) * 100}%`;
    }
  }

  document.querySelectorAll(".tab-block").forEach((block) => {
    const band = block.querySelector(".tab-loop-band");
    const row = block.querySelector(".line.tabline");
    const entry = playerState.blocks?.get(Number(block.dataset.lineStart));
    if (!band || !row || !entry || !active) {
      if (band) band.hidden = true;
      return;
    }
    const a = Math.max(playerState.loopStart, entry.start);
    const b = Math.min(playerState.loopEnd, entry.end);
    if (b <= a) {
      band.hidden = true;
      return;
    }
    const width = tabCharWidth(row);
    const colA = Math.max(0, Math.round((a - entry.start) / entry.step));
    const colB = Math.max(colA, Math.round((b - entry.start) / entry.step));
    const left = width * visualIndex(row.textContent, colA);
    const right = width * visualIndex(row.textContent, colB);
    band.hidden = false;
    band.style.left = `${left}px`;
    band.style.width = `${Math.max(2, right - left)}px`;
  });

  drawScoreLoop();
  drawChordLoop(parsed);
  paintTimeline(playerState.status === "playing" ? tabPlayer.elapsed() : tabPlayer.position);
}

async function startPlayer(song, { from = 0, fraction = null } = {}) {
  playerState.songId = song.id;

  const parsed = parseSong(song, {
    bpm: playerState.bpm,
    transpose: state.transpose,
    flats: state.flats,
    simplify: state.simplify,
  });
  if (!parsed.events.length) {
    playerState.status = "stopped";
    updatePlayerBar();
    return;
  }
  playerState.parsed = parsed;
  playerState.blocks = blockOffsets(parsed);
  buildTimeline(song, parsed);
  if (fraction !== null) from = Math.min(parsed.duration * fraction, parsed.duration - 0.05);

  if (playerState.countIn && from <= 0.001) {
    playerState.status = "countin";
    updatePlayerBar();
    await countIn(playerState.bpm, 4, playerState.clickVolume / 100);
    if (playerState.status !== "countin") return; // stopped during the count-in
  }

  tabPlayer.load(parsed, { bpm: playerState.bpm });
  tabPlayer.click = playerState.click;
  tabPlayer.clickVolume = playerState.clickVolume / 100;
  tabPlayer.setInstrument(playerInstrument(parsed));
  tabPlayer.setInstrumentVolume(playerState.volume / 100);
  tabPlayer.position = from;
  tabPlayer.loopStart = playerState.loop ? playerState.loopStart : 0;
  tabPlayer.loopEnd = playerState.loop ? playerState.loopEnd : 0;
  const started = await tabPlayer.play({
    from,
    loop: playerState.loop,
    click: playerState.click,
    clickVolume: playerState.clickVolume / 100,
    instrument: tabPlayer.instrument,
    instrumentVolume: playerState.volume / 100,
    onLine: highlightRange,
    onState: (status) => {
      if (status === "ended" || status === "stopped" || status === "paused") {
        playerState.status = status;
        if (status !== "paused") stopTicker();
        updatePlayerBar();
      }
    },
    onEnd: () => {
      stopTicker();
      highlightRange(null);
    },
  });

  playerState.status = started ? "playing" : "stopped";
  if (started) {
    startTicker();
    paintPlayheadAtTime(from);
  }
  updatePlayerBar();
  drawLoopRange();
}

async function togglePlayer(song) {
  if (followState.active) stopFollow();
  if (playerState.status === "playing") {
    tabPlayer.pause();
    stopTicker();
    playerState.status = "paused";
  } else if (playerState.status === "paused") {
    await tabPlayer.resume({
      loop: playerState.loop,
      click: playerState.click,
      clickVolume: playerState.clickVolume / 100,
      instrument: tabPlayer.instrument,
      instrumentVolume: playerState.volume / 100,
    });
    playerState.status = "playing";
    startTicker();
  } else {
    await startPlayer(song);
  }
  updatePlayerBar();
}

function changeBpm(delta, song) {
  playerState.bpm = Math.min(240, Math.max(40, playerState.bpm + delta));
  localStorage.setItem("osr.player.bpm", String(playerState.bpm));
  if (playerState.status === "playing" && playerState.parsed && playerState.parsed.duration) {
    const fraction = tabPlayer.elapsed() / playerState.parsed.duration;
    tabPlayer.stop();
    startPlayer(song, { fraction });
  } else {
    updatePlayerBar();
  }
}

function wirePlayer(song) {
  const toggle = document.getElementById("player-toggle");
  if (!toggle) return;
  const initialParsed = ensureParsed(song);
  buildTimeline(song, initialParsed);

  toggle.addEventListener("click", () => togglePlayer(song));
  document.getElementById("player-stop").addEventListener("click", () => stopPlayer());
  document.getElementById("player-bpm-down").addEventListener("click", () => changeBpm(-5, song));
  document.getElementById("player-bpm-up").addEventListener("click", () => changeBpm(5, song));

  const countButton = document.getElementById("player-countin");
  countButton.addEventListener("click", () => {
    playerState.countIn = !playerState.countIn;
    localStorage.setItem("osr.player.countin", playerState.countIn ? "on" : "off");
    countButton.classList.toggle("is-on", playerState.countIn);
    countButton.setAttribute("aria-pressed", String(playerState.countIn));
  });

  const clickButton = document.getElementById("player-click");
  if (clickButton) {
    clickButton.addEventListener("click", () => {
      playerState.click = !playerState.click;
      localStorage.setItem("osr.player.click", playerState.click ? "on" : "off");
      clickButton.classList.toggle("is-on", playerState.click);
      clickButton.setAttribute("aria-pressed", String(playerState.click));
      if (playerState.status === "playing") seekPlayer(song, tabPlayer.elapsed());
    });
  }

  const clickVolume = document.getElementById("player-click-volume");
  if (clickVolume) {
    const applyClickVolume = () => {
      const value = Math.max(0, Math.min(100, Number(clickVolume.value) || 0));
      playerState.clickVolume = value;
      localStorage.setItem("osr.player.clickvolume", String(value));
      tabPlayer.setClickVolume(value / 100);
      const label = document.getElementById("player-click-volume-value");
      if (label) label.textContent = `${value}%`;
    };
    clickVolume.addEventListener("input", applyClickVolume);
    tabPlayer.setClickVolume(playerState.clickVolume / 100);
  }

  const instrumentSelect = document.getElementById("player-instrument");
  if (instrumentSelect) {
    instrumentSelect.value = playerState.instrument;
    instrumentSelect.addEventListener("change", () => {
      playerState.instrument = instrumentSelect.value;
      localStorage.setItem("osr.player.instrument", playerState.instrument);
      tabPlayer.setInstrument(playerInstrument(playerState.parsed));
      if (playerState.status === "playing") seekPlayer(song, tabPlayer.elapsed());
    });
  }

  const volume = document.getElementById("player-volume");
  if (volume) {
    const applyVolume = () => {
      const value = Math.max(0, Math.min(100, Number(volume.value) || 0));
      playerState.volume = value;
      localStorage.setItem("osr.player.volume", String(value));
      tabPlayer.setInstrumentVolume(value / 100);
      const label = document.getElementById("player-volume-value");
      if (label) label.textContent = `${value}%`;
    };
    volume.addEventListener("input", applyVolume);
    tabPlayer.setInstrumentVolume(playerState.volume / 100);
  }

  const loopButton = document.getElementById("player-loop");
  loopButton.addEventListener("click", () => {
    playerState.loop = !playerState.loop;
    localStorage.setItem("osr.player.loop", playerState.loop ? "on" : "off");
    applyLoop(song);
    const wasPlaying = playerState.status === "playing";
    const position = wasPlaying ? tabPlayer.elapsed() : tabPlayer.position;
    seekPlayer(song, position, { autoplay: wasPlaying });
    drawLoopRange();
  });

  const markA = document.getElementById("loop-a");
  if (markA) markA.addEventListener("click", () => markLoopPoint(song, "a"));
  const markB = document.getElementById("loop-b");
  if (markB) markB.addEventListener("click", () => markLoopPoint(song, "b"));

  const followButton = document.getElementById("player-follow");
  if (followButton) {
    followButton.addEventListener("click", () => {
      if (followState.active) stopFollow();
      else startFollow(song);
    });
  }
  const followSkip = document.getElementById("follow-skip");
  if (followSkip) {
    followSkip.addEventListener("click", () => {
      if (!followState.active) return;
      followState.index += 1;
      followState.armed = true;
      paintFollow();
    });
  }

  const progress = document.getElementById("player-progress");
  progress.addEventListener("click", (event) => {
    const rect = progress.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const duration = ensureParsed(song).duration;
    seekPlayer(song, fraction * duration);
  });

  progress.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const duration = ensureParsed(song).duration;
    const step = event.key === "ArrowRight" ? 1 : -1;
    const position = playerState.status === "playing" ? tabPlayer.elapsed() : tabPlayer.position;
    seekPlayer(song, Math.max(0, Math.min(duration - 0.05, position + step)));
  });

  const content = document.querySelector(".score-sheet") || document.querySelector(".sheet");
  if (content) {
    let drag = null;

    content.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const time = timeAtSheetPoint(song, event);
      if (time === null) return;
      drag = { start: time, x: event.clientX, y: event.clientY, moved: false, pointerId: event.pointerId };
      try {
        content.setPointerCapture(event.pointerId);
      } catch {
        /* pointer capture is optional */
      }
    });

    content.addEventListener("pointermove", (event) => {
      if (!drag) return;
      // On touch, a swipe is a scroll, not a loop selection. A tap still seeks.
      if (event.pointerType === "touch") {
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 8) {
          drag = null;
          content.classList.remove("is-dragging");
        }
        return;
      }
      if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) return;
      drag.moved = true;
      content.classList.add("is-dragging");
      const time = timeAtSheetPoint(song, event);
      if (time === null) return;
      playerState.loopStart = Math.min(drag.start, time);
      playerState.loopEnd = Math.max(drag.start, time);
      playerState.loop = true;
      applyLoop(song);
      drawLoopRange();
      event.preventDefault();
    });

    const endDrag = (event) => {
      if (!drag) return;
      const { start, moved, pointerId } = drag;
      drag = null;
      content.classList.remove("is-dragging");
      try {
        content.releasePointerCapture(pointerId);
      } catch {
        /* capture may already be gone */
      }
      if (moved) {
        if (playerState.loopEnd - playerState.loopStart < 0.2) {
          playerState.loop = false;
          applyLoop(song);
          seekPlayer(song, start);
        } else {
          seekPlayer(song, playerState.loopStart);
        }
      } else {
        // A plain click outside an existing loop should go exactly there.
        if (playerState.loop && (start < playerState.loopStart || start > playerState.loopEnd)) {
          playerState.loop = false;
          applyLoop(song);
        }
        seekPlayer(song, start);
      }
      event.preventDefault();
    };
    content.addEventListener("pointerup", endDrag);
    content.addEventListener("pointercancel", () => {
      drag = null;
      content.classList.remove("is-dragging");
    });
  }

  const timeline = document.getElementById("timeline");
  if (timeline) {
    let timelineDrag = null;

    timeline.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const marker = event.target.closest(".timeline-entry");
      if (event.altKey || event.shiftKey) {
        if (marker) removeTimelineEntry(song, Number(marker.dataset.index));
        else {
          const time = timeAtTimelinePoint(song, event);
          if (time !== null) addTimelineEntry(song, time);
        }
        event.preventDefault();
        return;
      }
      if (marker) {
        const time = Number(marker.dataset.time);
        if (Number.isFinite(time)) {
          if (playerState.loop && (time < playerState.loopStart || time > playerState.loopEnd)) {
            playerState.loop = false;
            applyLoop(song);
          }
          seekPlayer(song, time);
        }
        event.preventDefault();
        return;
      }
      const time = timeAtTimelinePoint(song, event);
      if (time === null) return;
      timelineDrag = {
        start: time,
        x: event.clientX,
        y: event.clientY,
        moved: false,
        pointerId: event.pointerId,
      };
      try {
        timeline.setPointerCapture(event.pointerId);
      } catch {
        /* capture is optional */
      }
    });

    timeline.addEventListener("pointermove", (event) => {
      if (!timelineDrag) return;
      if (event.pointerType === "touch") {
        if (Math.hypot(event.clientX - timelineDrag.x, event.clientY - timelineDrag.y) > 8) {
          timelineDrag = null;
          timeline.classList.remove("is-dragging");
        }
        return;
      }
      if (!timelineDrag.moved && Math.abs(event.clientX - timelineDrag.x) < 5) return;
      timelineDrag.moved = true;
      const time = timeAtTimelinePoint(song, event);
      if (time === null) return;
      playerState.loopStart = Math.min(timelineDrag.start, time);
      playerState.loopEnd = Math.max(timelineDrag.start, time);
      playerState.loop = true;
      applyLoop(song);
      drawLoopRange();
      event.preventDefault();
    });

    const endTimelineDrag = (event) => {
      if (!timelineDrag) return;
      const { start, moved, pointerId } = timelineDrag;
      timelineDrag = null;
      timeline.classList.remove("is-dragging");
      try {
        timeline.releasePointerCapture(pointerId);
      } catch {
        /* capture may already be gone */
      }
      if (moved) {
        if (playerState.loopEnd - playerState.loopStart < 0.2) {
          playerState.loop = false;
          applyLoop(song);
          seekPlayer(song, start);
        } else {
          seekPlayer(song, playerState.loopStart);
        }
      } else {
        if (playerState.loop && (start < playerState.loopStart || start > playerState.loopEnd)) {
          playerState.loop = false;
          applyLoop(song);
        }
        seekPlayer(song, start);
      }
      event.preventDefault();
    };
    timeline.addEventListener("pointerup", endTimelineDrag);
    timeline.addEventListener("pointercancel", () => {
      timelineDrag = null;
      timeline.classList.remove("is-dragging");
    });
    timeline.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const duration = ensureParsed(song).duration;
      const position = playerState.status === "playing" ? tabPlayer.elapsed() : tabPlayer.position;
      seekPlayer(song, Math.max(0, Math.min(duration - 0.05, position + (event.key === "ArrowRight" ? 1 : -1))));
    });
  }

  const addEntryButton = document.getElementById("timeline-add-entry");
  if (addEntryButton) {
    addEntryButton.addEventListener("click", () => {
      const time = playerState.status === "playing" ? tabPlayer.elapsed() : tabPlayer.position;
      addTimelineEntry(song, time);
    });
  }

  updatePlayerBar();
  drawLoopRange();

}

function transcribeView() {
  return `
    <main class="ws transcribe-page">
      <section class="hero">
        <p class="crumb">Tool</p>
        <h1>From audio to chords or tab</h1>
        <p class="hero-sub">Load a recording you own. <strong>Chords</strong> folds the spectrum into 12 pitch classes, scores them against major, minor, 7th, m7, sus4 and dim shapes, estimates the tempo and writes a chord chart. <strong>Solo</strong> follows one pitch at a time and writes a tab, best for melodies and lead lines.</p>
        <p class="hero-sub dim">Audio never leaves this browser: nothing is uploaded, and the app never downloads from YouTube or Spotify.</p>
      </section>

      <div class="transcribe-card">
        <div class="tr-row">
          <div class="tr-modes" role="group" aria-label="Output">
            <button class="pill is-on" id="tr-mode-chords" aria-pressed="true">Chords</button>
            <button class="pill" id="tr-mode-solo" aria-pressed="false">Solo → tab</button>
          </div>
          <label>Tuning <input id="tr-tuning" value="E A D G B E" /></label>
        </div>
        <div class="tr-row">
          <label class="pill file-pill">Load audio<input id="tr-file" type="file" accept="audio/*" class="sr-only" /></label>
          <label>Tempo <input id="tr-bpm" type="number" min="40" max="240" step="1" value="100" /></label>
        </div>
        <div class="tr-progress" id="tr-progress" hidden><span id="tr-fill"></span></div>
        <p class="tr-status dim"><span class="tr-spinner" id="tr-spinner" hidden></span><span id="tr-status">Ready — load an audio file.</span></p>
        <div class="tr-facts" id="tr-facts" hidden>
          <span id="tr-fact-key">Key <strong id="tr-key">–</strong></span>
          <span id="tr-fact-tempo">Tempo <strong id="tr-tempo">–</strong></span>
          <span id="tr-fact-bars">Bars <strong id="tr-bars">–</strong></span>
        </div>
        <textarea id="tr-output" rows="12" spellcheck="false" placeholder="The result appears here…"></textarea>
        <div class="tr-row">
          <button class="pill primary" id="tr-open">Open in reader</button>
          <button class="pill" id="tr-copy">Copy</button>
        </div>
      </div>
    </main>`;
}

function wireTranscribe() {
  const file = document.getElementById("tr-file");
  if (!file) return;
  const status = document.getElementById("tr-status");
  const output = document.getElementById("tr-output");
  const spinner = document.getElementById("tr-spinner");
  const progress = document.getElementById("tr-progress");
  const fill = document.getElementById("tr-fill");
  const facts = document.getElementById("tr-facts");
  const keyOut = document.getElementById("tr-key");
  const tempoOut = document.getElementById("tr-tempo");
  const barsOut = document.getElementById("tr-bars");
  const factKey = document.getElementById("tr-fact-key");
  const factBars = document.getElementById("tr-fact-bars");
  const modeButtons = {
    chords: document.getElementById("tr-mode-chords"),
    solo: document.getElementById("tr-mode-solo"),
  };

  let mode = "chords";
  let source = null;
  let currentName = "audio";
  let result = null;

  const setBusy = (busy) => {
    if (spinner) spinner.hidden = !busy;
    if (progress && !busy) {
      progress.hidden = true;
      if (fill) fill.style.width = "0%";
    }
  };

  const tuningValue = () => String(document.getElementById("tr-tuning").value || "").trim() || "E A D G B E";
  const bpmValue = () => clampBpm(Number(document.getElementById("tr-bpm").value) || 100);

  const progressReporter = (startedAt, verb) => (fraction) => {
    const percent = Math.round(fraction * 100);
    if (fill) fill.style.width = `${percent}%`;
    status.textContent = `${verb}… ${percent}% · ${((performance.now() - startedAt) / 1000).toFixed(1)}s`;
  };

  const analyse = async (blob, label) => {
    source = blob;
    currentName = label;
    result = null;
    if (facts) facts.hidden = true;
    setBusy(true);
    status.textContent = `Decoding ${label}…`;
    const startedAt = performance.now();
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctor();
      const buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
      const samples = buffer.getChannelData(0);
      if (progress) progress.hidden = false;

      status.textContent = `Detecting tempo of ${buffer.duration.toFixed(1)}s…`;
      await new Promise((resolve) => setTimeout(resolve, 20));
      const tempo = estimateTempo(samples, buffer.sampleRate);
      let detectedBpm = bpmValue();
      if (tempo.bpm >= 40 && tempo.confidence > 0.2) {
        detectedBpm = tempo.bpm;
        document.getElementById("tr-bpm").value = String(detectedBpm);
      }

      if (mode === "chords") {
        const found = await estimateChordsAsync(samples, buffer.sampleRate, { bpm: detectedBpm }, progressReporter(startedAt, "Reading chords"));
        result = found;
        const cellsPerBar = found.cellsPerBar || 1;
        const barCount = Math.ceil(found.bars.length / cellsPerBar);
        output.value = chordsToChart(found.bars, { cellsPerBar });
        document.getElementById("tr-bpm").value = String(found.bpm || detectedBpm);

        const root = (found.key.match(/^[A-G]#?/) || ["C"])[0];
        const shownBpm = found.bpm || detectedBpm;
        if (facts) facts.hidden = false;
        if (factKey) factKey.hidden = false;
        if (factBars) factBars.hidden = false;
        if (keyOut) keyOut.textContent = found.key || "–";
        if (tempoOut) tempoOut.textContent = `${shownBpm} BPM`;
        if (barsOut) barsOut.textContent = String(barCount);

        const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
        const chordCount = new Set(found.bars).size;
        status.textContent = `${barCount} bars · ${chordCount} chords · key ${root} · ${shownBpm} BPM · ${seconds}s`;
      } else {
        const notes = await detectNotesAsync(samples, buffer.sampleRate, {}, progressReporter(startedAt, "Reading notes"));
        result = { notes, bpm: detectedBpm };
        output.value = notesToTab(notes, { bpm: detectedBpm, tuning: tuningValue() });

        if (facts) facts.hidden = false;
        if (factKey) factKey.hidden = true;
        if (factBars) factBars.hidden = true;
        if (tempoOut) tempoOut.textContent = `${detectedBpm} BPM`;

        const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
        status.textContent = `${notes.length} notes · tempo ${detectedBpm} BPM · ${seconds}s`;
      }
      ctx.close().catch(() => {});
    } catch (error) {
      status.textContent = `Could not read that audio (${error.message || error.name}).`;
    } finally {
      setBusy(false);
    }
  };

  const setMode = (next) => {
    mode = next;
    for (const [name, button] of Object.entries(modeButtons)) {
      if (!button) continue;
      button.classList.toggle("is-on", name === mode);
      button.setAttribute("aria-pressed", String(name === mode));
    }
    if (source) analyse(source, currentName);
  };

  if (modeButtons.chords) modeButtons.chords.addEventListener("click", () => setMode("chords"));
  if (modeButtons.solo) modeButtons.solo.addEventListener("click", () => setMode("solo"));

  file.addEventListener("change", () => {
    const chosen = file.files && file.files[0];
    if (chosen) analyse(chosen, chosen.name);
    file.value = "";
  });

  document.getElementById("tr-open").addEventListener("click", () => {
    const body = output.value.trim();
    if (!body || !result) {
      status.textContent = "Nothing to open yet — load an audio file first.";
      return;
    }
    const song = {
      id: `imported-${Date.now().toString(36)}`,
      imported: true,
      title: `Transcribed — ${currentName}`,
      artist: "From audio",
      type: mode === "chords" ? "chords" : "tabs",
      key: mode === "chords" ? (result.key.match(/^[A-G]#?/) || ["C"])[0] : "C",
      tuning: tuningValue(),
      capo: "No capo",
      bpm: bpmValue(),
      difficulty: "intermediate",
      body,
    };
    imported = [song, ...imported];
    persistImported();
    go(`#/song/${encodeURIComponent(song.id)}`);
  });

  document.getElementById("tr-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(output.value);
      status.textContent = mode === "chords" ? "Chart copied." : "Tab copied.";
    } catch {
      status.textContent = "Copy failed — select the text instead.";
    }
  });
}

// --- accounts -----------------------------------------------------------

function emptyState(snapshot) {
  const practiceSeconds = Object.values(snapshot.practice || {}).reduce(
    (sum, row) => sum + (row?.seconds || 0),
    0,
  );
  return (
    !snapshot.saved?.length &&
    !snapshot.imported?.length &&
    !snapshot.playlists?.length &&
    !practiceSeconds
  );
}

function snapshotState() {
  return {
    saved: [...state.saved],
    imported,
    playlists: state.playlists,
    practice: loadPractice(),
    ratings: state.ratings,
    tempos: state.tempos,
    videos: state.videos,
  };
}

function applyState(remote) {
  applyingRemote = true;
  imported = Array.isArray(remote.imported) ? remote.imported : [];
  persistImported();
  const known = (id) => Boolean(findSong(id));
  state.saved = new Set((Array.isArray(remote.saved) ? remote.saved : []).filter(known));
  persistSaved();
  state.playlists = Array.isArray(remote.playlists) ? remote.playlists : [];
  savePlaylists();
  persistPractice(remote.practice && typeof remote.practice === "object" ? remote.practice : {});
  const remoteRatings = remote.ratings && typeof remote.ratings === "object" ? remote.ratings : {};
  state.ratings = Object.fromEntries(
    Object.entries(remoteRatings).filter(
      ([id, value]) => findSong(id) && Number.isInteger(value) && value >= 1 && value <= 5,
    ),
  );
  persistRatings(state.ratings);
  const remoteTempos = remote.tempos && typeof remote.tempos === "object" ? remote.tempos : {};
  state.tempos = Object.fromEntries(
    Object.entries(remoteTempos).filter(
      ([, value]) => Number.isInteger(value) && value >= 40 && value <= 240,
    ),
  );
  persistTempos(state.tempos);
  state.videos = remote.videos && typeof remote.videos === "object" && !Array.isArray(remote.videos)
    ? remote.videos
    : {};
  persistVideos(state.videos);
  applyingRemote = false;
}

function clearLocalState() {
  applyingRemote = true;
  imported = [];
  state.saved = new Set();
  state.playlists = [];
  state.videos = {};
  state.ratings = {};
  state.tempos = {};
  state.entries = {};
  localStorage.removeItem(SAVED_KEY);
  localStorage.removeItem(IMPORTED_KEY);
  localStorage.removeItem("osr.playlists.v1");
  localStorage.removeItem("osr.videos.v1");
  localStorage.removeItem("osr.ratings.v1");
  localStorage.removeItem("osr.tempos.v1");
  localStorage.removeItem("osr.entries.v1");
  persistPractice({});
  applyingRemote = false;
}

async function afterAuth(user) {
  state.user = user;
  state.authAvailable = true;
  state.authError = "";
  state.authBusy = false;
  state.authDraft = null;

  const remote = await pullState();
  if (remote.state && !emptyState(remote.state)) {
    // The account wins: this browser now mirrors it.
    applyState(remote.state);
  } else {
    // Fresh account: adopt whatever this browser already had.
    const local = snapshotState();
    if (!emptyState(local)) await pushState(local);
  }

  if (route().view === "auth") {
    go("#/");
  } else {
    render();
  }
}

async function doLogout() {
  // Drop the session locally first: nothing queued after this can write the
  // previous account's state back, even if the network call is slow.
  state.user = null;
  state.authBusy = false;
  state.authError = "";
  syncPending = false;
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  stopAutoScroll();
  stopMetronome();
  stopPractice();
  clearLocalState();
  render();
  go("#/");
  await apiLogout();
}

async function initAuth() {
  const result = await probe();
  state.authAvailable = result.available;
  // Nothing about the header changes for a guest, so do not re-render and
  // invalidate handlers bound by the first render — except on the auth pages,
  // where the "accounts need the server" notice depends on the probe.
  if (!result.user) {
    if (route().view === "auth") render();
    return;
  }
  state.user = result.user;
  const remote = await pullState();
  if (remote.state && !emptyState(remote.state)) applyState(remote.state);
  render();
}

function authView(mode) {
  if (state.user) {
    return `
      <main class="ws auth-page">
        <section class="hero">
          <p class="crumb">Account</p>
          <h1>You're signed in</h1>
          <p class="hero-sub">${esc(state.user.name)} · ${esc(state.user.email)}</p>
        </section>
        <div class="auth-card">
          <p>Saved tabs, playlists and practice time are stored on this server and loaded on every device you sign in from.</p>
          <div class="pl-actions">
            <button class="pill danger" data-logout>Log out</button>
            <a class="pill" href="#/">Back to the catalog</a>
          </div>
        </div>
      </main>`;
  }

  const signupMode = mode === "signup";
  return `
    <main class="ws auth-page">
      <section class="hero">
        <p class="crumb">Account</p>
        <h1>${signupMode ? "Create your account" : "Log in"}</h1>
        <p class="hero-sub">${
          signupMode
            ? "Your saved tabs, playlists and practice time follow the account."
            : "Welcome back — pick up where you left off."
        }</p>
      </section>

      ${
        state.authAvailable === false
          ? `<p class="auth-notice">Accounts need the local server. Start it with <code>python3 server.py</code> and open <code>http://127.0.0.1:4173</code>.</p>`
          : ""
      }

      <form class="auth-card" id="auth-form" novalidate>
        ${
          signupMode
            ? `<label>Name
                 <input name="name" autocomplete="name" maxlength="40" required value="${esc(
                   state.authDraft?.name || "",
                 )}" />
               </label>`
            : ""
        }
        <label>Email
          <input name="email" type="email" autocomplete="email" maxlength="254" required
                 value="${esc(state.authDraft?.email || "")}" />
        </label>
        <label>Password
          <input name="password" type="password" autocomplete="${
            signupMode ? "new-password" : "current-password"
          }" minlength="10" maxlength="200" required />
        </label>
        ${
          signupMode
            ? `<p class="auth-hint dim">At least 10 characters. Stored as an scrypt hash, never in plain text.</p>`
            : ""
        }
        <p class="auth-error" id="auth-error" role="alert">${esc(state.authError)}</p>
        <div class="auth-actions">
          <button class="pill primary" type="submit" ${state.authBusy ? "disabled" : ""}>
            ${state.authBusy ? "Working…" : signupMode ? "Create account" : "Log in"}
          </button>
          <a class="auth-switch" href="#/${signupMode ? "login" : "signup"}">${
            signupMode ? "I already have an account" : "Create an account"
          }</a>
        </div>
      </form>
    </main>`;
}


// --- playlists ----------------------------------------------------------

function pickerRows(list, query = "") {
  const q = query.trim().toLowerCase();
  const rows = catalogue()
    .filter((s) => !q || s.title.toLowerCase().includes(q) || s.artist.toLowerCase().includes(q))
    .slice(0, 40);
  if (!rows.length) return `<p class="dim">Nothing matches that filter.</p>`;
  return rows
    .map((s) => {
      const inList = list.songIds.includes(s.id);
      return `<div class="picker-row">
        <div class="picker-main"><strong>${esc(s.title)}</strong> <span class="dim">${esc(s.artist)}</span></div>
        <button class="pill ${inList ? "is-on" : ""}" data-list-add="${s.id}" data-target="${list.id}">${inList ? "Added" : "Add"}</button>
      </div>`;
    })
    .join("");
}

function playlistsView() {
  const totals = practiceTotals();
  return `
    <main class="ws">
      <section class="hero">
        <p class="crumb">Pro</p>
        <h1>Playlists</h1>
        <p class="hero-sub">Set lists for lessons and rehearsals — add tabs from any song page, then step through them with the metronome.</p>
      </section>

      <form class="new-list" id="playlist-create">
        <label>New playlist <input name="name" placeholder="Tuesday lesson" maxlength="60" required autocomplete="off" /></label>
        <button class="pill primary" type="submit">Create playlist</button>
      </form>

      <p class="result-count">${state.playlists.length} playlist${state.playlists.length === 1 ? "" : "s"} · ${totals.minutes} practice minute${totals.minutes === 1 ? "" : "s"} logged</p>

      <div class="playlist-grid">
        ${
          state.playlists.length
            ? state.playlists
                .map((p) => {
                  const items = listSongs(p);
                  return `<article class="playlist-card">
                    <div class="playlist-card-head">
                      <h3><a href="#/playlist/${encodeURIComponent(p.id)}">${esc(p.name)}</a></h3>
                      <span class="badge">${items.length} song${items.length === 1 ? "" : "s"}</span>
                    </div>
                    <p class="dim playlist-preview">${
                      items.length
                        ? items
                            .slice(0, 4)
                            .map((s) => esc(s.title))
                            .join(" · ") + (items.length > 4 ? ` +${items.length - 4}` : "")
                        : "Empty — add tabs from a song page."
                    }</p>
                    <div class="pl-actions">
                      ${items.length ? `<a class="pill primary" href="${songHref(items[0], p.id)}"><span class="ico">▶</span> Play all</a>` : ""}
                      <a class="pill" href="#/playlist/${encodeURIComponent(p.id)}">Open</a>
                      <button class="pill danger" data-list-delete="${p.id}">Delete</button>
                    </div>
                  </article>`;
                })
                .join("")
            : `<p class="empty">No playlists yet. Create one above, or open a tab and use <strong>Playlists</strong>.</p>`
        }
      </div>
    </main>`;
}

function playlistView(id) {
  const list = playlistOf(state.playlists, id);
  if (!list) {
    return `<main class="ws"><p class="empty">That playlist does not exist. <a href="#/playlists">All playlists</a>.</p></main>`;
  }
  const items = listSongs(list);
  return `
    <main class="ws">
      <section class="hero">
        <p class="crumb"><a href="#/playlists">Playlists</a></p>
        <h1>${esc(list.name)}</h1>
        <p class="hero-sub">${items.length} song${items.length === 1 ? "" : "s"} · stored on this device</p>
      </section>

      <div class="pl-actions pl-top">
        ${items.length ? `<a class="pill primary" href="${songHref(items[0], list.id)}"><span class="ico">▶</span> Play all</a>` : ""}
        <form class="rename-form" id="rename-form">
          <input name="name" value="${esc(list.name)}" maxlength="60" required aria-label="Playlist name" />
          <button class="pill" type="submit">Rename</button>
        </form>
        <button class="pill danger" id="delete-list">Delete playlist</button>
      </div>

      <ol class="list-songs">
        ${
          items
            .map(
              (s, i) => `<li class="list-song">
                <span class="list-num">${i + 1}</span>
                <a class="list-main" href="${songHref(s, list.id)}">
                  <strong>${esc(s.title)}</strong>
                  <span class="dim">${esc(s.artist)} · ${TYPE_LABEL[s.type] || "Tab"} · Key ${esc(s.key)}</span>
                </a>
                <button class="pill sq" data-list-remove="${s.id}" title="Remove from playlist" aria-label="Remove ${esc(s.title)}">✕</button>
              </li>`,
            )
            .join("") || `<li class="empty">Nothing here yet — add tabs with the picker below.</li>`
        }
      </ol>

      <section class="picker">
        <h2>Add songs</h2>
        <input id="picker-filter" type="search" placeholder="Filter the catalog" autocomplete="off" aria-label="Filter the catalog" value="${esc(state.picker)}" />
        <div class="picker-list" id="picker-list">${pickerRows(list, state.picker)}</div>
      </section>
    </main>`;
}

// --- pro ----------------------------------------------------------------

function proView() {
  const map = loadPractice();
  const totals = practiceTotals(map);
  const duration = (seconds) =>
    seconds < 60 ? `${Math.round(seconds)} s` : `${Math.round(seconds / 60)} min`;
  const rows = practiceBySong(map)
    .slice(0, 6)
    .map((row) => ({ ...row, song: findSong(row.id) }))
    .filter((row) => row.song);
  return `
    <main class="ws">
      <section class="hero">
        <p class="crumb">Pro</p>
        <h1>Your practice room</h1>
        <p class="hero-sub">Playlists, metronome time, tab exports and backups — all stored in this browser.</p>
      </section>

      <div class="stats-grid">
        <div class="stat"><span class="stat-value">${totals.minutes}</span><span class="stat-label">practice minute${totals.minutes === 1 ? "" : "s"}</span></div>
        <div class="stat"><span class="stat-value">${totals.songs}</span><span class="stat-label">tabs practised</span></div>
        <div class="stat"><span class="stat-value">${state.saved.size}</span><span class="stat-label">saved tabs</span></div>
        <div class="stat"><span class="stat-value">${state.playlists.length}</span><span class="stat-label">playlists</span></div>
      </div>

      <section class="pro-block">
        <h2>Most practised</h2>
        ${
          rows.length
            ? `<ol class="practice-list">
                 ${rows
                   .map(
                     (row) => `<li>
                       <a href="${songHref(row.song)}">${esc(row.song.title)}</a>
                       <span class="dim">${esc(row.song.artist)}</span>
                       <span class="practice-time">${duration(row.seconds)}</span>
                     </li>`,
                   )
                   .join("")}
               </ol>`
            : `<p class="empty">Start the metronome or autoscroll on any tab and its minutes show up here.</p>`
        }
      </section>

      <section class="pro-block">
        <h2>Backup &amp; restore</h2>
        <p class="dim">Saved tabs, playlists, imported sheets and practice stats travel in one JSON file.</p>
        <div class="pl-actions">
          <button class="pill primary" id="backup-export">Export backup</button>
          <label class="pill file-pill">Restore backup<input type="file" id="backup-import" class="sr-only" accept="application/json,.json" /></label>
        </div>
        <p class="backup-note dim" id="backup-note">${esc(state.backupNote)}</p>
      </section>

      <section class="pro-block">
        <h2>What Pro adds</h2>
        <ul class="pro-features">
          <li><strong>Playlists</strong> — build set lists and step through them from the reader.</li>
          <li><strong>Metronome</strong> — 40–240 BPM, 2/3/4/6 beats per bar, tap tempo, accented downbeat.</li>
          <li><strong>Tuner</strong> — chromatic microphone tuning with reference tones. <a class="learn-link" href="#/tuner">Open the tuner</a></li>
          <li><strong>Practice log</strong> — minutes counted while the metronome or autoscroll runs.</li>
          <li><strong>Tab export</strong> — one-click .txt of any tab, plus a full JSON backup.</li>
          <li><strong>Print / PDF</strong> — the reader's print stylesheet, now with the Pro chrome stripped.</li>
        </ul>
      </section>
    </main>`;
}


// --- import -------------------------------------------------------------

function importView() {
  // A song page can hand us its title/artist/key so pasting is one step.
  const params = new URLSearchParams((location.hash.split("?")[1] || "").trim());
  const pre = (name, fallback = "") => esc(params.get(name) || fallback);
  const type = params.get("type") || "tabs";
  const typeOptions = ["tabs", "chords", "ukulele", "bass"]
    .map((t) => `<option value="${t}" ${t === type ? "selected" : ""}>${TYPE_LABEL[t]}</option>`)
    .join("");

  return `
    <main class="ws">
      <section class="hero">
        <h1>Import music</h1>
        <p class="hero-sub">Load a MusicXML or MIDI score, or paste a chord sheet / ASCII tab. Everything runs in this browser — transpose, playback, autoscroll and print all work.</p>
      </section>

      <section class="score-import">
        <h2>Sheet music</h2>
        <p class="dim">Import MusicXML (<code>.musicxml</code> / <code>.xml</code>), compressed MusicXML (<code>.mxl</code>) or MIDI (<code>.mid</code> / <code>.midi</code>). The score is drawn, played note by note and followed while it plays.</p>
        <p class="dim">PDFs of printed staves are <strong>not</strong> read directly — that needs optical music recognition. Convert the PDF to MusicXML with <a href="https://audiveris.github.io/audiveris/" target="_blank" rel="noopener noreferrer">Audiveris</a> (free) or export MusicXML from the notation app, then load the <code>.musicxml</code> / <code>.mxl</code> here.</p>
        <div class="tr-row">
          <label class="pill file-pill">Load score<input id="score-file" type="file"
            accept=".xml,.musicxml,.mxl,.mid,.midi,.pdf,audio/midi,application/xml,text/xml,application/pdf" class="sr-only" /></label>
          <span class="dim" id="score-status">No file loaded.</span>
        </div>
      </section>

      <form class="import-form" id="import-form">
        <div class="field-row">
          <label>Title <input name="title" required placeholder="Can't Stop" value="${pre("title")}" /></label>
          <label>Artist <input name="artist" placeholder="Red Hot Chili Peppers" value="${pre("artist")}" /></label>
        </div>
        <div class="field-row">
          <label>Type
            <select name="type">${typeOptions}</select>
          </label>
          <label>Key <input name="key" placeholder="Em" size="6" value="${pre("key")}" /></label>
          <label>Tuning <input name="tuning" placeholder="E A D G B E" value="${pre("tuning", "E A D G B E")}" /></label>
          <label>Capo <input name="capo" placeholder="No capo" value="${pre("capo", "No capo")}" /></label>
          <label>Tempo <input name="bpm" type="number" min="40" max="240" step="1" placeholder="100" value="${pre("bpm", "100")}" /></label>
        </div>
        <label class="body-field">Tab text
          <textarea name="body" required rows="14" spellcheck="false"
            placeholder="[Intro]&#10;Em  D  Bm  C&#10;&#10;e|------------------|&#10;B|------------------|&#10;G|-7-7-9-7-9-7-9----|&#10;D|------------------|&#10;A|------------------|&#10;E|------------------|"></textarea>
        </label>
        <label class="split-row">
          <input type="checkbox" name="split" id="split-album" />
          <span>Split into separate tracks <span class="dim" id="split-hint">(paste an album tab to enable)</span></span>
        </label>
        <div class="import-actions">
          <button class="pill primary" type="submit">Open in reader</button>
          <span class="dim">Saved in this browser only (localStorage) — never committed to the repo.</span>
        </div>
      </form>

      ${
        imported.length
          ? `<h2 class="rail-title">Already imported</h2>
             <div class="results">${imported.map(songCard).join("")}</div>`
          : `<p class="empty">Nothing imported yet.</p>`
      }
    </main>`;
}

// --- practice clock -----------------------------------------------------

function startPractice(songId) {
  if (!songId) return;
  if (practiceSong === songId && practiceTimer) return;
  stopPractice();
  practiceSong = songId;
  practiceTimer = setInterval(() => {
    if (practiceSong) {
      addPractice(practiceSong, 1);
      queueSync();
    }
  }, 1000);
}

function stopPractice() {
  if (practiceTimer) clearInterval(practiceTimer);
  practiceTimer = null;
  practiceSong = null;
}

// A metronome or autoscroll run is what counts as practice; plain reading does not.
function syncPractice(songId) {
  if (songId && (metro.on || state.playing)) startPractice(songId);
  else stopPractice();
}

// --- metronome ----------------------------------------------------------

function paintBeat(index) {
  document.querySelectorAll("#beat-dots .dot").forEach((dot) => {
    dot.classList.toggle("is-hit", Number(dot.dataset.beat) === index);
  });
}

function startMetronome() {
  metro.start(paintBeat);
  if (!metro.on) return; // no Web Audio on this browser
  syncPractice(route().view === "song" ? route().id : null);
}

function stopMetronome() {
  metro.stop();
  document.querySelectorAll("#beat-dots .dot").forEach((dot) => dot.classList.remove("is-hit"));
}

// Tap tempo: average the last few taps, so an uneven tap does not jump the BPM.
let tapTimes = [];
function tapTempo() {
  const now = performance.now();
  tapTimes = [...tapTimes.filter((t) => now - t < 2500), now].slice(-5);
  if (tapTimes.length < 2) return null;
  const spans = tapTimes.slice(1).map((t, i) => t - tapTimes[i]);
  const average = spans.reduce((a, b) => a + b, 0) / spans.length;
  metro.setBpm(60000 / average);
  return metro.bpm;
}

// --- autoscroll ---------------------------------------------------------

function stopAutoScroll() {
  state.playing = false;
  if (autoScrollRaf) cancelAnimationFrame(autoScrollRaf);
  autoScrollRaf = null;
}

function startAutoScroll() {
  state.playing = true;
  let last = performance.now();
  const step = (now) => {
    const dt = (now - last) / 1000;
    last = now;
    window.scrollBy(0, state.speed * 140 * dt);
    const atBottom =
      window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
    if (atBottom) {
      stopAutoScroll();
      render();
      return;
    }
    autoScrollRaf = requestAnimationFrame(step);
  };
  autoScrollRaf = requestAnimationFrame(step);
}

// --- render -------------------------------------------------------------

function render() {
  const app = document.getElementById("app");
  const r = route();
  const scrollY = window.scrollY;
  let body = "";
  if (r.view === "song") body = songView(r.id);
  else if (r.view === "saved") body = savedView();
  else if (r.view === "import") body = importView();
  else if (r.view === "playlists") body = playlistsView();
  else if (r.view === "playlist") body = playlistView(r.id);
  else if (r.view === "pro") body = proView();
  else if (r.view === "artists") body = artistsView();
  else if (r.view === "artist") body = artistView(r.slug);
  else if (r.view === "charts") body = chartsView();
  else if (r.view === "tuner") body = tunerView();
  else if (r.view === "transcribe") body = transcribeView();
  else if (r.view === "learn") body = learnView();
  else if (r.view === "auth") body = authView(r.mode);
  else body = exploreView();

  app.innerHTML = header() + body + siteFooter();
  wire();
  syncPractice(r.view === "song" ? r.id : null);

  if (r.view === "song") window.scrollTo(0, scrollY);
}

function siteFooter() {
  return `
    <footer class="site-footer">
      <span>Ofer's School of Rock Pro</span>
      <span class="dim">build 2026-11-12 · tempo &amp; follow</span>
    </footer>`;
}

function wire() {
  document.getElementById("search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    state.query = document.getElementById("search-input").value.trim();
    if (route().view !== "explore") go("#/explore");
    else render();
  });

  const heroSearch = document.getElementById("hero-search");
  if (heroSearch) {
    heroSearch.addEventListener("submit", (event) => {
      event.preventDefault();
      state.query = document.getElementById("hero-search-input").value.trim();
      render();
    });
  }

  const sort = document.getElementById("sort");
  if (sort) {
    sort.addEventListener("change", () => {
      state.sort = sort.value;
      state.sortDir = sort.value === "title" ? "asc" : "desc";
      render();
    });
  }

  document.querySelectorAll("[data-layout]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.layout = btn.dataset.layout;
      localStorage.setItem("osr.layout", state.layout);
      render();
    });
  });

  document.querySelectorAll("[data-sort]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.sort;
      if (state.sort === key) state.sortDir = state.sortDir === "desc" ? "asc" : "desc";
      else {
        state.sort = key;
        state.sortDir = key === "title" ? "asc" : "desc";
      }
      render();
    });
  });

  document.querySelectorAll("[data-type]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.type = btn.dataset.type;
      render();
    });
  });

  document.querySelectorAll("[data-save]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      toggleSave(btn.dataset.save);
    });
  });

  wireImport();
  wirePlaylists();
  wirePro();
  wireAuth();
  wireTuner();
  wireTranscribe();

  const song = route().view === "song" ? findSong(route().id) : null;
  if (!song) return;


  const deleteImport = document.getElementById("delete-import");
  if (deleteImport) {
    deleteImport.addEventListener("click", () => {
      imported = imported.filter((s) => s.id !== song.id);
      persistImported();
      state.saved.delete(song.id);
      persistSaved();
      go("#/import");
    });
  }

  const autoscroll = document.getElementById("autoscroll");
  autoscroll.addEventListener("click", () => {
    if (state.playing) stopAutoScroll();
    else startAutoScroll();
    render();
  });

  document.getElementById("speed").addEventListener("click", () => {
    state.speed = Math.round((state.speed + 0.1) * 10) / 10;
    if (state.speed > 1.0) state.speed = 0.1;
    if (state.playing) {
      stopAutoScroll();
      startAutoScroll();
    }
    render();
  });

  document.getElementById("simplify")?.addEventListener("click", () => {
    state.simplify = !state.simplify;
    render();
  });

  document.getElementById("flats")?.addEventListener("click", () => {
    state.flats = !state.flats;
    render();
  });

  document.getElementById("down")?.addEventListener("click", () => {
    state.transpose = Math.max(-11, state.transpose - 1);
    render();
  });

  document.getElementById("up")?.addEventListener("click", () => {
    state.transpose = Math.min(11, state.transpose + 1);
    render();
  });

  document.getElementById("font-down")?.addEventListener("click", () => {
    state.fontScale = Math.max(0.8, Math.round((state.fontScale - 0.1) * 10) / 10);
    render();
  });

  document.getElementById("font-up")?.addEventListener("click", () => {
    state.fontScale = Math.min(1.8, Math.round((state.fontScale + 0.1) * 10) / 10);
    render();
  });

  document.querySelectorAll("[data-display]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.display;
      if (state.display === mode) return;
      state.display = mode;
      localStorage.setItem("osr.display", mode);
      stopPlayer();
      render();
    });
  });

  document.getElementById("save").addEventListener("click", () => toggleSave(song.id));
  document.getElementById("print").addEventListener("click", () => window.print());

  document.getElementById("video-toggle")?.addEventListener("click", () => {
    state.showVideo = !state.showVideo;
    state.videoEditing = false;
    state.videoError = "";
    render();
  });

  const videoForm = document.getElementById("video-form");
  if (videoForm) {
    videoForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(videoForm);
      const id = youtubeId(data.get("url"));
      if (!id) {
        state.videoError = "That does not look like a YouTube link or video id.";
        render();
        return;
      }
      const title = String(data.get("title") || "").trim().slice(0, 120);
      state.videos = {
        ...state.videos,
        [song.id]: { id, title, addedAt: new Date().toISOString() },
      };
      persistVideos(state.videos);
      queueSync();
      state.videoEditing = false;
      state.videoError = "";
      state.showVideo = true;
      render();
    });
  }

  const editVideo = document.getElementById("video-edit");
  if (editVideo) {
    editVideo.addEventListener("click", () => {
      state.videoEditing = true;
      state.videoError = "";
      render();
    });
  }

  const cancelVideo = document.getElementById("video-cancel");
  if (cancelVideo) {
    cancelVideo.addEventListener("click", () => {
      state.videoEditing = false;
      state.videoError = "";
      render();
    });
  }

  const removeVideo = document.getElementById("video-remove");
  if (removeVideo) {
    removeVideo.addEventListener("click", () => {
      const next = { ...state.videos };
      delete next[song.id];
      state.videos = next;
      persistVideos(next);
      queueSync();
      state.videoEditing = false;
      state.showVideo = false;
      render();
    });
  }

  const playVideo = document.querySelector("[data-video-play]");
  if (playVideo) {
    playVideo.addEventListener("click", () => {
      const frame = document.getElementById("video-frame");
      const id = frame?.dataset.videoId;
      if (!frame || !id || !YOUTUBE_ID.test(id)) return;
      frame.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0"
        title="Song video"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
        allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
    });
  }

  const setCapo = (value) => {
    const next = clampCapo(value);
    state.capos = { ...state.capos, [song.id]: next };
    persistCapos(state.capos);
    render();
  };
  const capoDown = document.getElementById("capo-down");
  if (capoDown) capoDown.addEventListener("click", () => setCapo(clampCapo(state.capos[song.id]) - 1));
  const capoUp = document.getElementById("capo-up");
  if (capoUp) capoUp.addEventListener("click", () => setCapo(clampCapo(state.capos[song.id]) + 1));

  const tempoInput = document.getElementById("tempo-input");
  if (tempoInput) {
    tempoInput.addEventListener("change", () => {
      const bpm = clampBpm(Number(tempoInput.value) || 100);
      state.tempos = { ...state.tempos, [song.id]: bpm };
      persistTempos(state.tempos);
      queueSync();
      playerState.tempoSongId = song.id;
      playerState.bpm = bpm;
      metro.setBpm(bpm);
      const metroValue = document.getElementById("bpm-value");
      if (metroValue) metroValue.textContent = String(bpm);
      if (playerState.status !== "stopped") stopPlayer();
      buildTimeline(song);
      drawLoopRange();
      updatePlayerBar();
      tempoInput.value = String(bpm);
    });
  }

  document.querySelectorAll("[data-rate]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const value = Number(btn.dataset.rate);
      const current = Number(state.ratings[song.id]) || 0;
      const next = { ...state.ratings };
      if (current === value) delete next[song.id];
      else next[song.id] = value;
      state.ratings = next;
      persistRatings(next);
      queueSync();
      render();
    });
  });

  wireComments(song);
  wirePlayer(song);

  document.getElementById("export-tab")?.addEventListener("click", () =>
    downloadText(`${slug(song.artist)}-${slug(song.title)}.txt`, tabText(song)),
  );

  const addList = document.getElementById("add-list-form");
  addList.addEventListener("submit", (e) => {
    e.preventDefault();
    const data = new FormData(addList);
    const name = String(data.get("new") || "").trim();
    if (name) {
      const list = newPlaylist(name);
      list.songIds = [song.id];
      state.playlists = [list, ...state.playlists];
      savePlaylists();
      render();
      return;
    }
    const target = String(data.get("list") || "");
    if (target) togglePlaylistSong(target, song.id);
  });

  document.getElementById("metro").addEventListener("click", () => {
    if (metro.on) {
      stopMetronome();
      syncPractice(null);
    } else {
      startMetronome();
    }
    render();
  });

  document.getElementById("bpm-down").addEventListener("click", () => {
    metro.setBpm(metro.bpm - 5);
    render();
  });

  document.getElementById("bpm-up").addEventListener("click", () => {
    metro.setBpm(metro.bpm + 5);
    render();
  });

  document.getElementById("beats").addEventListener("change", (e) => {
    metro.setBeats(e.target.value);
    render();
  });

  document.getElementById("tap-tempo").addEventListener("click", () => {
    tapTempo();
    render();
  });
}

function wirePlaylists() {
  const create = document.getElementById("playlist-create");
  if (create) {
    create.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = String(new FormData(create).get("name") || "").trim();
      if (!name) return;
      const list = newPlaylist(name);
      state.playlists = [list, ...state.playlists];
      savePlaylists();
      go(`#/playlist/${encodeURIComponent(list.id)}`);
    });
  }

  document.querySelectorAll("[data-list-delete]").forEach((btn) => {
    btn.addEventListener("click", () => {
      deletePlaylist(btn.dataset.listDelete);
      render();
    });
  });

  const rename = document.getElementById("rename-form");
  if (rename) {
    rename.addEventListener("submit", (e) => {
      e.preventDefault();
      const list = playlistOf(state.playlists, route().id);
      const name = String(new FormData(rename).get("name") || "").trim();
      if (!list || !name) return;
      state.playlists = state.playlists.map((p) => (p.id === list.id ? { ...p, name } : p));
      savePlaylists();
      render();
    });
  }

  const remove = document.getElementById("delete-list");
  if (remove) {
    remove.addEventListener("click", () => {
      deletePlaylist(route().id);
      go("#/playlists");
    });
  }

  document.querySelectorAll("[data-list-remove]").forEach((btn) => {
    btn.addEventListener("click", () => togglePlaylistSong(route().id, btn.dataset.listRemove));
  });

  const filter = document.getElementById("picker-filter");
  const picker = document.getElementById("picker-list");
  if (filter && picker) {
    filter.value = state.picker;
    filter.addEventListener("input", () => {
      state.picker = filter.value;
      const list = playlistOf(state.playlists, route().id);
      if (list) picker.innerHTML = pickerRows(list, state.picker);
    });
    picker.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-list-add]");
      if (btn) togglePlaylistSong(btn.dataset.target, btn.dataset.listAdd);
    });
  }
}

function wirePro() {  const exportBtn = document.getElementById("backup-export");
  if (exportBtn) {
    exportBtn.addEventListener("click", () => {
      const backup = buildBackup({
        saved: state.saved,
        imported,
        playlists: state.playlists,
        practice: loadPractice(),
      });
      downloadText(
        `osr-pro-backup-${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify(backup, null, 2),
        "application/json",
      );
    });
  }

  const input = document.getElementById("backup-import");
  if (input) {
    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const result = readBackup(await file.text());
      if (result.error) {
        state.backupNote = result.error;
        input.value = "";
        render();
        return;
      }
      const backup = result.backup;
      imported = backup.imported;
      persistImported();
      const known = (id) => Boolean(findSong(id));
      state.saved = new Set(backup.saved.filter(known));
      persistSaved();
      state.playlists = backup.playlists;
      savePlaylists();
      persistPractice(backup.practice);
      queueSync();
      state.backupNote = `Restored ${state.saved.size} saved tab${state.saved.size === 1 ? "" : "s"}, ${
        state.playlists.length
      } playlist${state.playlists.length === 1 ? "" : "s"} and ${imported.length} imported sheet${
        imported.length === 1 ? "" : "s"
      }.`;
      input.value = "";
      render();
    });
  }
}

function wireAuth() {
  document.querySelectorAll("[data-logout]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      await doLogout();
    });
  });

  const form = document.getElementById("auth-form");
  if (!form) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.authBusy) return;

    const data = new FormData(form);
    const email = String(data.get("email") || "").trim();
    const password = String(data.get("password") || "");
    const name = String(data.get("name") || "").trim();
    const signupMode = route().mode === "signup";
    state.authDraft = { email, name };

    const fail = (message) => {
      state.authError = message;
      render();
    };

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail("Enter a valid email address.");
    if (signupMode && (name.length < 1 || name.length > 40))
      return fail("Enter your name (1–40 characters).");
    if (password.length < 10) return fail("Password must be at least 10 characters.");
    if (password.trim() !== password) return fail("Password cannot start or end with a space.");

    state.authBusy = true;
    state.authError = "";
    render();

    const result = signupMode
      ? await apiSignup({ name, email, password })
      : await apiLogin({ email, password });

    if (result.user) {
      await afterAuth(result.user);
      return;
    }

    state.authBusy = false;
    state.authError = result.message || "Could not sign you in.";
    render();
  });
}

function wireComments(song) {
  const list = document.getElementById("comments-list");
  const form = document.getElementById("comment-form");
  const login = document.getElementById("comment-login");
  const error = document.getElementById("comment-error");
  const count = document.getElementById("comment-count");
  if (!list) return;

  // The Pages build has no accounts server, so do not request a thread that
  // cannot exist.
  if (document.querySelector('meta[name="osr-static"]')) {
    list.innerHTML = `<p class="dim">Comments are stored by the local accounts server. This static copy runs in guest mode.</p>`;
    if (form) form.hidden = true;
    if (login) login.hidden = true;
    return;
  }

  const paint = (data) => {
    const items = data.comments || [];
    if (count) count.textContent = items.length ? `(${items.length})` : "";
    if (data.error) {
      list.innerHTML = `<p class="dim">${esc(data.error)}</p>`;
      return;
    }
    if (!items.length) {
      list.innerHTML = `<p class="dim">No comments yet${
        data.authenticated ? " — add the first one." : " — log in to start the conversation."
      }</p>`;
    } else {
      list.innerHTML = items
        .map(
          (comment) => `<article class="comment" data-comment="${comment.id}">
            <header>
              <strong>${esc(comment.author)}</strong>
              <time datetime="${esc(comment.createdAt)}">${esc(
                new Date(comment.createdAt).toLocaleString(),
              )}</time>
              ${comment.mine ? `<button class="pill danger tiny" data-comment-delete="${comment.id}">Delete</button>` : ""}
            </header>
            <p>${esc(comment.body)}</p>
          </article>`,
        )
        .join("");
    }
    if (form) form.hidden = !data.authenticated;
    if (login) login.hidden = Boolean(data.authenticated);
  };

  const refresh = async () => {
    const data = await listComments(song.id);
    if (route().view !== "song" || route().id !== song.id) return;
    paint(data);
  };

  if (form) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const body = String(new FormData(form).get("body") || "").trim();
      if (!body) return;
      if (error) error.textContent = "";
      const button = form.querySelector("button[type=submit]");
      if (button) button.disabled = true;
      const result = await addComment(song.id, body);
      if (button) button.disabled = false;
      if (result.error) {
        if (error) error.textContent = result.error;
        return;
      }
      form.reset();
      refresh();
    });
  }

  list.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-comment-delete]");
    if (!button) return;
    button.disabled = true;
    const result = await deleteComment(button.dataset.commentDelete);
    if (result.error) {
      if (error) error.textContent = result.error;
      button.disabled = false;
      return;
    }
    refresh();
  });

  refresh();
}

function wireTuner() {
  const toggle = document.getElementById("tuner-toggle");
  if (!toggle) return;

  // Query on use: the card must survive the permission prompt even if the page
  // re-renders while the browser dialog is open.
  const el = (id) => document.getElementById(id);

  const setRunning = (running) => {
    const button = el("tuner-toggle");
    if (button) {
      button.textContent = running ? "Stop listening" : "Start listening";
      button.setAttribute("aria-pressed", String(running));
    }
    const readout = el("tuner-readout");
    if (readout) readout.classList.toggle("is-live", running);
  };
  setRunning(tunerRunning);

  const paintPegs = (reading) => {
    document.querySelectorAll(".string-peg").forEach((peg) => {
      peg.classList.remove("is-heard", "is-tuned", "is-suggested");
    });
    if (reading.stringIndex === undefined) return;
    const heard = document.querySelector(`.string-peg[data-string="${reading.stringIndex}"]`);
    if (heard) heard.classList.add("is-heard");
    if (heard && Math.abs(reading.stringCents) <= 5) heard.classList.add("is-tuned");
    if (reading.wrongString && reading.suggestedIndex !== undefined) {
      const suggested = document.querySelector(`.string-peg[data-string="${reading.suggestedIndex}"]`);
      if (suggested) suggested.classList.add("is-suggested");
    }
  };

  const paint = (reading) => {
    const noteEl = el("tuner-note");
    const octaveEl = el("tuner-octave");
    const marker = el("tuner-marker");
    const statusEl = el("tuner-status");
    const hzEl = el("tuner-hz");
    const targetEl = el("tuner-target");
    const readout = el("tuner-readout");

    // With a string in play the needle follows the distance to that string;
    // in chromatic mode it follows the nearest semitone.
    const shown = reading.stringCents ?? reading.cents;
    if (noteEl) noteEl.textContent = reading.name;
    if (octaveEl) octaveEl.textContent = reading.octave;
    const markerCents = Math.max(-50, Math.min(50, shown));
    if (marker) marker.style.left = `${50 + markerCents}%`;
    const abs = Math.abs(shown);
    if (readout) {
      readout.classList.toggle("is-in-tune", abs <= 5);
      readout.classList.toggle("is-close", abs > 5 && abs <= 15);
    }
    if (statusEl) {
      statusEl.textContent = reading.wrongString
        ? `That sounds like ${reading.wrongString} — check the string`
        : abs <= 5
          ? "In tune"
          : abs <= 15
            ? shown > 0
              ? `Slightly sharp (+${shown}¢)`
              : `Slightly flat (${shown}¢)`
            : shown > 0
              ? "Sharp"
              : "Flat";
    }
    if (targetEl) {
      targetEl.textContent = reading.stringName
        ? `String ${reading.stringName} · ${shown > 0 ? "+" : ""}${shown}¢`
        : state.tunerMode === "chromatic"
          ? "Chromatic — play any note"
          : "Auto — play any string";
    }
    if (hzEl) hzEl.textContent = `${reading.frequency.toFixed(1)} Hz · ${reading.cents > 0 ? "+" : ""}${reading.cents}¢`;
    paintPegs(reading);
  };

  const currentTuning = () => TUNINGS[state.tunerTuning] || TUNINGS.guitar;
  const applyConfig = () =>
    tuner.configure({
      mode: state.tunerMode,
      strings: currentTuning().strings,
      stringIndex: state.tunerString,
    });

  const updateModeUi = () => {
    const autoButton = el("tuner-mode-auto");
    const chromaticButton = el("tuner-mode-chromatic");
    const auto = state.tunerMode === "auto";
    const chromatic = state.tunerMode === "chromatic";
    if (autoButton) {
      autoButton.classList.toggle("is-on", auto);
      autoButton.setAttribute("aria-pressed", String(auto));
    }
    if (chromaticButton) {
      chromaticButton.classList.toggle("is-on", chromatic);
      chromaticButton.setAttribute("aria-pressed", String(chromatic));
    }
    document.querySelectorAll(".string-peg").forEach((peg) => {
      const selected = state.tunerMode === "string" && Number(peg.dataset.string) === state.tunerString;
      peg.classList.toggle("is-selected", selected);
      peg.setAttribute("aria-pressed", String(selected));
    });
    const targetEl = el("tuner-target");
    if (targetEl) {
      const pinned = state.tunerMode === "string" ? currentTuning().strings[state.tunerString] : null;
      targetEl.textContent = pinned
        ? `Target ${pinned[0]} — tap the peg again for auto`
        : chromatic
          ? "Chromatic — play any note"
          : "Auto — play any string";
    }
  };

  const chooseMode = (mode) => {
    state.tunerMode = mode;
    state.tunerString = -1;
    localStorage.setItem("osr.tunermode.v1", mode);
    applyConfig();
    updateModeUi();
  };

  const autoMode = el("tuner-mode-auto");
  if (autoMode) autoMode.addEventListener("click", () => chooseMode("auto"));
  const chromaticMode = el("tuner-mode-chromatic");
  if (chromaticMode) chromaticMode.addEventListener("click", () => chooseMode("chromatic"));

  const headstock = el("tuner-headstock");
  if (headstock) {
    headstock.addEventListener("click", (event) => {
      const peg = event.target.closest("[data-string]");
      if (!peg) return;
      const index = Number(peg.dataset.string);
      const pinned = state.tunerMode === "string" && state.tunerString === index;
      state.tunerMode = pinned ? "auto" : "string";
      state.tunerString = pinned ? -1 : index;
      localStorage.setItem("osr.tunermode.v1", state.tunerMode);
      applyConfig();
      updateModeUi();
    });
  }

  updateModeUi();

  toggle.addEventListener("click", async () => {
    if (tunerRunning) {
      stopTuner();
      setRunning(false);
      const statusEl = el("tuner-status");
      if (statusEl) statusEl.textContent = "Stopped.";
      return;
    }

    const errorEl = el("tuner-error");
    if (errorEl) errorEl.textContent = "";
    const statusEl = el("tuner-status");
    if (statusEl) statusEl.textContent = "Waiting for microphone permission…";
    toggle.disabled = true;

    applyConfig();
    const outcome = await Promise.race([
      tuner.start({
        onResult: paint,
        onError: (message) => {
          const target = el("tuner-error");
          if (target) target.textContent = message;
          const note = el("tuner-status");
          if (note) note.textContent = "Press start and play a note.";
        },
      }),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 10000)),
    ]);

    const button = el("tuner-toggle");
    if (button) button.disabled = false;

    if (outcome === "timeout") {
      tuner.stop();
      tunerRunning = false;
      setRunning(false);
      const target = el("tuner-error");
      if (target) target.textContent = "No microphone answered. Check the browser's microphone permission and try again.";
      const note = el("tuner-status");
      if (note) note.textContent = "Press start and play a note.";
      return;
    }

    tunerRunning = Boolean(outcome);
    setRunning(tunerRunning);
    if (outcome) {
      const note = el("tuner-status");
      if (note) note.textContent = "Listening… play a note.";
    }
  });

  const select = document.getElementById("tuning-select");
  if (select) {
    select.addEventListener("change", (event) => {
      state.tunerTuning = event.target.value;
      state.tunerString = -1;
      if (state.tunerMode === "string") state.tunerMode = "auto";
      localStorage.setItem("osr.tuning.v1", state.tunerTuning);
      localStorage.setItem("osr.tunermode.v1", state.tunerMode);
      stopTuner();
      render();
    });
  }

  const tones = document.getElementById("tone-row");
  if (tones) {
    tones.addEventListener("click", (event) => {
      const button = event.target.closest("[data-tone]");
      if (!button) return;
      const hz = Number(button.dataset.tone);
      if (!Number.isFinite(hz)) return;
      button.classList.add("is-playing");
      setTimeout(() => button.classList.remove("is-playing"), 500);
      tuner.reference(hz);
    });
  }
}

// Album tabs mark each song with a line like "number 3" (Ultimate Guitar), and
// often list the titles at the top as "3.song name".
const OPEN_TUNINGS = {
  "open g": "D G D G B D",
  "open d": "D A D F# A D",
  "open e": "E B E G# B E",
  "open c": "C G C G C E",
  "drop d": "D A D G B E",
};

// Album tabs often print the tuning per song ("Open G Tuning", "Tuning: D G D G B D").
function trackTuning(body, fallback) {
  const open = body.match(/\bopen\s+([a-g])\b/i);
  if (open) {
    const key = `open ${open[1].toLowerCase()}`;
    if (OPEN_TUNINGS[key]) return OPEN_TUNINGS[key];
  }
  const explicit = body.match(/\btuning\s*[:\-]?\s*([A-G][#b]?(?:\s+[A-G][#b]?){3,5})/i);
  if (explicit) return explicit[1].toUpperCase();
  const paren = body.match(/\btuning[^\n]*\(([A-G][#b]?(?:\s+[A-G][#b]?){3,5})\)/i);
  if (paren) return paren[1].toUpperCase();
  return fallback;
}

function splitAlbum(body) {
  const lines = String(body).split("\n");
  const markers = [];
  lines.forEach((line, index) => {
    const match = line.trim().match(/^(?:number|track|song|part)\s+(\d{1,2})$/i);
    if (match) markers.push({ index, number: Number(match[1]) });
  });
  if (markers.length < 2) return null;

  const names = new Map();
  for (let i = 0; i < markers[0].index; i++) {
    const match = lines[i].trim().match(/^(\d{1,2})[.)]\s*(.+)$/);
    if (match) names.set(Number(match[1]), match[2].trim());
  }

  return markers
    .map((marker, i) => {
      const start = marker.index + 1;
      const end = i + 1 < markers.length ? markers[i + 1].index : lines.length;
      return {
        number: marker.number,
        name: names.get(marker.number) || `Track ${marker.number}`,
        body: lines.slice(start, end).join("\n").trim(),
      };
    })
    .filter((track) => track.body);
}

function detectTempo(text) {
  const match = String(text).match(/\b(?:tempo|bpm)\s*[:=]?\s*(\d{2,3})\b/i);
  const value = match ? Number(match[1]) : 0;
  return value >= 40 && value <= 240 ? value : 0;
}

function wireImport() {
  const form = document.getElementById("import-form");

  const scoreFile = document.getElementById("score-file");
  if (scoreFile) {
    scoreFile.addEventListener("change", async () => {
      const chosen = scoreFile.files && scoreFile.files[0];
      scoreFile.value = "";
      if (!chosen) return;
      const status = document.getElementById("score-status");
      const name = chosen.name.replace(/\.[^.]+$/, "");
      const extension = (chosen.name.split(".").pop() || "").toLowerCase();
      if (status) status.textContent = `Reading ${chosen.name}…`;
      try {
        let notation;
        if (extension === "xml" || extension === "musicxml") {
          notation = parseMusicXml(await chosen.text(), name);
        } else if (extension === "mxl") {
          notation = await parseMxl(await chosen.arrayBuffer(), name);
        } else if (extension === "mid" || extension === "midi") {
          notation = parseMidi(await chosen.arrayBuffer(), name);
        } else if (extension === "pdf") {
          throw new Error(
            "PDF staves need OMR. Convert the PDF to MusicXML/MXL with Audiveris or MuseScore, then load that file.",
          );
        } else {
          throw new Error("Use a .musicxml/.xml/.mxl score or a .mid/.midi file.");
        }
        const song = {
          id: `imported-${Date.now().toString(36)}`,
          imported: true,
          title: notation.title || name || "Imported score",
          artist: notation.composer || "Imported score",
          type: "notation",
          key: notation.key || "C",
          tuning: "—",
          capo: "—",
          bpm: clampBpm(notation.bpm || 100),
          difficulty: "intermediate",
          body: "",
          notation,
        };
        if (JSON.stringify(song).length > 1_200_000) {
          throw new Error("That score is too large to keep in this browser (about 1.2 MB).");
        }
        imported = [song, ...imported];
        persistImported();
        state.query = "";
        state.type = "all";
        go(`#/song/${encodeURIComponent(song.id)}`);
      } catch (error) {
        if (status) status.textContent = `Could not read that score: ${error.message || error}`;
      }
    });
  }

  if (!form) return;

  const bodyField = form.querySelector("[name=body]");
  const bpmField = form.querySelector("[name=bpm]");
  let bpmTouched = false;
  if (bpmField) bpmField.addEventListener("input", () => { bpmTouched = true; });
  const splitBox = document.getElementById("split-album");
  const splitHint = document.getElementById("split-hint");
  const updateSplit = () => {
    if (bpmField && !bpmTouched) {
      const detected = detectTempo(bodyField.value);
      if (detected) bpmField.value = String(detected);
    }
    const tracks = splitAlbum(bodyField.value);
    if (!tracks) {
      splitBox.checked = false;
      splitBox.disabled = true;
      splitHint.textContent = "(paste an album tab to enable)";
      return;
    }
    splitBox.disabled = false;
    splitHint.textContent = `(${tracks.length} tracks found — one song each, in a playlist)`;
  };
  bodyField.addEventListener("input", updateSplit);
  updateSplit();

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const body = String(data.get("body") || "").replace(/\r\n/g, "\n").trim();
    if (!body) return;
    const text = (name, fallback) => {
      const value = String(data.get(name) || "").trim();
      return value || fallback;
    };

    const title = text("title", "Untitled");
    const artist = text("artist", "Unknown artist");
    const type = text("type", "tabs");
    const key = text("key", "C");
    const tuning = text("tuning", "E A D G B E");
    const capo = text("capo", "No capo");
    const bpm = clampBpm(Number(data.get("bpm")) || detectTempo(body) || 100);

    const tracks = data.get("split") ? splitAlbum(body) : null;
    if (tracks && tracks.length > 1) {
      const stamp = Date.now().toString(36);
      const songs = tracks.map((track, i) => ({
        id: `imported-${stamp}-${i}`,
        imported: true,
        title: track.name,
        artist,
        type,
        key,
        tuning: trackTuning(track.body, tuning),
        capo,
        bpm: detectTempo(track.body) || bpm,
        difficulty: "intermediate",
        body: track.body,
      }));
      imported = [...songs, ...imported];
      persistImported();
      const list = newPlaylist(title);
      list.songIds = songs.map((song) => song.id);
      state.playlists = [list, ...state.playlists];
      savePlaylists();
      state.query = "";
      state.type = "all";
      go(`#/playlist/${encodeURIComponent(list.id)}`);
      return;
    }

    const song = {
      id: `imported-${Date.now().toString(36)}`,
      imported: true,
      title,
      artist,
      type,
      key,
      tuning,
      capo,
      bpm,
      difficulty: "intermediate",
      body,
    };
    imported = [song, ...imported];
    persistImported();
    state.query = "";
    state.type = "all";
    go(`#/song/${encodeURIComponent(song.id)}`);
  });
}

function toggleSave(id) {
  if (state.saved.has(id)) state.saved.delete(id);
  else state.saved.add(id);
  persistSaved();
  render();
}

applyRouteType();
render();
initAuth();
