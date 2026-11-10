import { songs, byId, versionsOf } from "./data.js";
import {
  isChordToken,
  chordTokensByLine,
  transposeChord,
  simplifyChord,
  diagramSVG,
  uniqueChords,
} from "./chords.js";
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
  practiceTotals,
  practiceBySong,
  clampBpm,
  beatChoices,
  Metronome,
  downloadText,
  buildBackup,
  readBackup,
} from "./pro.js";

import {
  probe,
  signup as apiSignup,
  login as apiLogin,
  logout as apiLogout,
  pullState,
  pushState,
} from "./auth.js";
import { listComments, addComment, deleteComment } from "./comments.js";

const SAVED_KEY = "ugclone.saved.v1";
const IMPORTED_KEY = "osr.imported.v1";

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
  picker: "",
  backupNote: "",
  showVideo: false,
  videoEditing: false,
  videoError: "",
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

let autoScrollRaf = null;
let practiceTimer = null;
let practiceSong = null;
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
  if (parts[0] === "learn") return { view: "learn" };
  if (parts[0] === "login") return { view: "auth", mode: "login" };
  if (parts[0] === "signup") return { view: "auth", mode: "signup" };
  return { view: "explore", q: params.get("q") || state.query };
}

function go(path) {
  location.hash = path;
}

window.addEventListener("hashchange", () => {
  stopAutoScroll();
  stopMetronome();
  stopPractice();
  state.picker = "";
  state.backupNote = "";
  state.showVideo = false;
  state.videoEditing = false;
  state.videoError = "";
  state.transpose = 0;
  state.simplify = false;
  render();
});

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
    const matchesType = state.type === "all" || s.type === state.type;
    const matchesQuery =
      !q ||
      s.title.toLowerCase().includes(q) ||
      s.artist.toLowerCase().includes(q) ||
      s.key.toLowerCase() === q;
    return matchesType && matchesQuery;
  });
  if (state.sort === "rating") list = [...list].sort((a, b) => b.rating - a.rating);
  else if (state.sort === "views") list = [...list].sort((a, b) => b.views - a.views);
  return list;
}

const TYPE_LABEL = { chords: "Chords", tabs: "Tab", ukulele: "Ukulele", bass: "Bass" };

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
              ? `<li class="dim">${song.body.split("\n").length} lines</li><li class="dim">Key ${esc(song.key)}</li>`
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

function exploreView() {
  const list = filteredSongs();
  const types = ["all", "chords", "tabs", "ukulele", "bass"];
  return `
    <main class="ws">
      <section class="hero">
        <h1>Explore tab catalog</h1>
        <p class="hero-sub">${fmt(songs.length)} songs · chords, tabs and ukulele arrangements${
          imported.length ? ` · ${imported.length} imported tab${imported.length === 1 ? "" : "s"}` : ""
        } · <a class="learn-link" href="#/learn">new here? start with the lessons</a></p>
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
        <label class="sort">
          Sort
          <select id="sort">
            <option value="relevance" ${state.sort === "relevance" ? "selected" : ""}>Relevance</option>
            <option value="rating" ${state.sort === "rating" ? "selected" : ""}>Rating</option>
            <option value="views" ${state.sort === "views" ? "selected" : ""}>Views</option>
          </select>
        </label>
      </div>

      <p class="result-count">${list.length} result${list.length === 1 ? "" : "s"}${
        state.query ? ` for “${esc(state.query)}”` : ""
      }</p>

      <div class="results">
        ${list.length ? list.map(songCard).join("") : `<p class="empty">No tabs match that search yet.</p>`}
      </div>
    </main>`;
}

// --- sheet --------------------------------------------------------------

function renderSheet(song) {
  const lines = song.body.split("\n");
  const chordTokens = chordTokensByLine(song.body);
  const out = [];
  let inTabBlock = false;
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) {
      out.push(`<div class="line">&nbsp;</div>`);
      inTabBlock = false;
      return;
    }
    if (/^\[.*\]$/.test(trimmed)) {
      out.push(`<h4 class="section">${esc(trimmed.slice(1, -1))}</h4>`);
      inTabBlock = false;
      return;
    }
    if (/^[eBGDAE]\|/.test(trimmed)) inTabBlock = true;

    const allowed = new Set(chordTokens[index]);
    const tokens = line.split(/(\s+)/);
    const rendered = tokens
      .map((tok) => {
        if (!tok.trim()) return esc(tok);
        if (!isChordToken(tok)) return esc(tok);
        if (!allowed.has(tok)) return esc(tok);
        let chord = tok;
        if (state.transpose) chord = transposeChord(chord, state.transpose, state.flats);
        else if (state.flats) chord = transposeChord(chord, 0, true);
        if (state.simplify) chord = simplifyChord(chord);
        return `<span class="ch" data-chord="${esc(chord)}">${esc(chord)}</span>`;
      })
      .join("");

    out.push(`<div class="line${inTabBlock ? " tabline" : ""}">${rendered}</div>`);
  });
  return `<div class="sheet" style="--sheet-font: ${(15 * state.fontScale).toFixed(1)}px">${out.join("")}</div>`;
}

function chordPanel(song) {
  const chords = uniqueChords(song.body)
    .map((c) => {
      let chord = c;
      if (state.transpose) chord = transposeChord(chord, state.transpose, state.flats);
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
  const video = state.videos[song.id];
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
            <span class="video-sub">Play video · YouTube loads only when pressed</span>
          </button>
        </div>
        <div class="video-actions">
          <button class="pill" id="video-edit">Replace video</button>
          <button class="pill danger" id="video-remove">Remove</button>
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
        <div class="rail-auth">
          ${
            state.user
              ? `<p class="rail-account-label">Signed in</p>
                 <strong class="rail-account-name">${esc(state.user.name)}</strong>
                 <p class="rail-account-email">${esc(state.user.email)}</p>
                 <button class="btn-ghost" data-logout>Log out</button>`
              : `<a class="btn-primary" href="#/signup">Sign up</a>
                 <a class="btn-ghost" href="#/login">Log in</a>`
          }
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
              ? `<strong>Imported tab</strong>
                 <p>Stored in this browser only — not part of the catalog in the repo.</p>
                 <button class="pill danger" id="delete-import">Delete this tab</button>`
              : `<strong>About the author</strong>
                 <p>${esc(song.author)} — ${fmt(song.saves)} saves, ${fmt(song.comments)} comments.</p>`
          }
        </div>
      </aside>

      <article class="song">
        <h1 class="song-title">${esc(song.title)} ${TYPE_LABEL[song.type] || "Tab"} <span>by</span> ${esc(song.artist)}</h1>
        ${
          importedSong
            ? `<p class="stats">Imported on this device · ${song.body.split("\n").length} lines</p>`
            : `<p class="stats">${fmt(song.views)} views · ${fmt(song.saves)} saves · ${fmt(song.comments)} comments</p>`
        }
        <p class="byline">
          ${
            importedSong
              ? `Pasted into this browser · <span class="badge badge-import">Imported</span>`
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
          <button class="pill ${isSaved ? "is-on" : ""}" id="save" aria-pressed="${isSaved}">${isSaved ? "Saved" : "Save"}</button>
          <button class="pill ${state.showVideo ? "is-on" : ""}" id="video-toggle" aria-pressed="${state.showVideo}">Video</button>
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
          <button class="pill" id="export-tab">Export .txt</button>
          <button class="pill" id="print">Print / PDF</button>
          ${
            importedSong
              ? ""
              : `<a class="pill" href="#/import?title=${encodeURIComponent(song.title)}&artist=${encodeURIComponent(
                  song.artist,
                )}&key=${encodeURIComponent(song.key)}&type=${encodeURIComponent(song.type)}">Add a tab for this song</a>`
          }
        </div>

        <p class="tab-meta">Tuning: ${esc(song.tuning)} <span>·</span> Key: ${esc(transposeKey(song.key))} <span>·</span> Capo: ${esc(
          song.capo,
        )}</p>

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

        <div class="sheet-wrap">
          ${renderSheet(song)}
          ${chordPanel(song)}
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
  localStorage.removeItem(SAVED_KEY);
  localStorage.removeItem(IMPORTED_KEY);
  localStorage.removeItem("osr.playlists.v1");
  localStorage.removeItem("osr.videos.v1");
  localStorage.removeItem("osr.ratings.v1");
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
  if (result.user) {
    state.user = result.user;
    const remote = await pullState();
    if (remote.state && !emptyState(remote.state)) applyState(remote.state);
  }
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
        <h1>Import a tab</h1>
        <p class="hero-sub">Paste a chord sheet or ASCII tab and read it here — transpose, diagrams, autoscroll and print all work.</p>
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
        </div>
        <label class="body-field">Tab text
          <textarea name="body" required rows="14" spellcheck="false"
            placeholder="[Intro]&#10;Em  D  Bm  C&#10;&#10;e|------------------|&#10;B|------------------|&#10;G|-7-7-9-7-9-7-9----|&#10;D|------------------|&#10;A|------------------|&#10;E|------------------|"></textarea>
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
  else if (r.view === "learn") body = learnView();
  else if (r.view === "auth") body = authView(r.mode);
  else body = exploreView();

  app.innerHTML = header() + body;
  wire();
  syncPractice(r.view === "song" ? r.id : null);

  if (r.view === "song") window.scrollTo(0, scrollY);
}

function wire() {
  document.getElementById("search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    state.query = document.getElementById("search-input").value.trim();
    if (route().view !== "explore") go("#/explore");
    else render();
  });

  const sort = document.getElementById("sort");
  if (sort) {
    sort.addEventListener("change", () => {
      state.sort = sort.value;
      render();
    });
  }

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

  document.getElementById("simplify").addEventListener("click", () => {
    state.simplify = !state.simplify;
    render();
  });

  document.getElementById("flats").addEventListener("click", () => {
    state.flats = !state.flats;
    render();
  });

  document.getElementById("down").addEventListener("click", () => {
    state.transpose = Math.max(-11, state.transpose - 1);
    render();
  });

  document.getElementById("up").addEventListener("click", () => {
    state.transpose = Math.min(11, state.transpose + 1);
    render();
  });

  document.getElementById("font-down").addEventListener("click", () => {
    state.fontScale = Math.max(0.8, Math.round((state.fontScale - 0.1) * 10) / 10);
    render();
  });

  document.getElementById("font-up").addEventListener("click", () => {
    state.fontScale = Math.min(1.8, Math.round((state.fontScale + 0.1) * 10) / 10);
    render();
  });

  document.getElementById("save").addEventListener("click", () => toggleSave(song.id));
  document.getElementById("print").addEventListener("click", () => window.print());

  document.getElementById("video-toggle").addEventListener("click", () => {
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

  document
    .getElementById("export-tab")
    .addEventListener("click", () =>
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

function wireImport() {
  const form = document.getElementById("import-form");
  if (!form) return;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const body = String(data.get("body") || "").replace(/\r\n/g, "\n").trim();
    if (!body) return;
    const text = (name, fallback) => {
      const value = String(data.get(name) || "").trim();
      return value || fallback;
    };
    const song = {
      id: `imported-${Date.now().toString(36)}`,
      imported: true,
      title: text("title", "Untitled"),
      artist: text("artist", "Unknown artist"),
      type: text("type", "tabs"),
      key: text("key", "C"),
      tuning: text("tuning", "E A D G B E"),
      capo: text("capo", "No capo"),
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

render();
initAuth();
