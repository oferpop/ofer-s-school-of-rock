import { songs, byId, versionsOf } from "./data.js";
import {
  isChordToken,
  chordTokensByLine,
  transposeChord,
  simplifyChord,
  diagramSVG,
  uniqueChords,
} from "./chords.js";

const SAVED_KEY = "ugclone.saved.v1";

const state = {
  query: "",
  type: "all",
  sort: "relevance",
  saved: new Set(loadSaved()),
  // per-song viewer state
  transpose: 0,
  flats: false,
  simplify: false,
  fontScale: 1,
  playing: false,
  speed: 0.2,
};

let autoScrollRaf = null;

function loadSaved() {
  try {
    return JSON.parse(localStorage.getItem(SAVED_KEY) || "[]");
  } catch {
    return [];
  }
}

function persistSaved() {
  localStorage.setItem(SAVED_KEY, JSON.stringify([...state.saved]));
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const fmt = (n) => n.toLocaleString("en-US");

// --- routing ------------------------------------------------------------

function route() {
  const raw = location.hash.replace(/^#/, "") || "/";
  const [path, qs] = raw.split("?");
  const params = new URLSearchParams(qs || "");
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "song" && parts[1]) return { view: "song", id: parts[1] };
  if (parts[0] === "saved") return { view: "saved" };
  return { view: "explore", q: params.get("q") || state.query };
}

function go(path) {
  location.hash = path;
}

window.addEventListener("hashchange", () => {
  stopAutoScroll();
  state.transpose = 0;
  state.simplify = false;
  render();
});

// --- chrome -------------------------------------------------------------

function header() {
  return `
    <header class="site-header">
      <a class="brand" href="#/">
        <span class="brand-mark">OSR</span>
        <span class="brand-text"><strong>Ofer's School of Rock</strong><em>chords &amp; tabs</em></span>
      </a>
      <nav class="main-nav">
        <a href="#/" class="${route().view === "explore" ? "is-active" : ""}">Tabs</a>
        <a href="#/saved" class="${route().view === "saved" ? "is-active" : ""}">My tabs</a>
        <a href="#" class="is-muted" aria-disabled="true">Courses</a>
        <a href="#" class="is-muted" aria-disabled="true">Articles</a>
        <a href="#" class="is-muted" aria-disabled="true">Forums</a>
      </nav>
      <form class="search" id="search-form" role="search">
        <input id="search-input" type="search" placeholder="chords and tabs" autocomplete="off"
               value="${esc(state.query)}" aria-label="Search songs, artists and tabs" />
        <button type="submit" aria-label="Search">Search</button>
      </form>
    </header>`;
}

// --- explore ------------------------------------------------------------

function filteredSongs() {
  const q = state.query.trim().toLowerCase();
  let list = songs.filter((s) => {
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
      <a class="card-main" href="#/song/${song.id}">
        <div class="card-head">
          <h3>${esc(song.title)}</h3>
          <span class="badge">${TYPE_LABEL[song.type] || "Tab"}</span>
        </div>
        <p class="card-artist">${esc(song.artist)}</p>
        <ul class="meta">
          <li><span class="star">★</span> ${song.rating.toFixed(1)} <span class="dim">(${fmt(song.votes)})</span></li>
          <li class="dim">${fmt(song.views)} views</li>
          <li class="dim">Key ${esc(song.key)}</li>
          <li class="dim difficulty-${song.difficulty}">${song.difficulty}</li>
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
        <p class="hero-sub">${fmt(songs.length)} songs · chords, tabs and ukulele arrangements</p>
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

function songView(id) {
  const song = byId(id);
  if (!song) {
    return `<main class="ws"><p class="empty">That tab does not exist. <a href="#/">Back to the catalog</a>.</p></main>`;
  }
  const versions = versionsOf(song);
  const isSaved = state.saved.has(song.id);
  return `
    <main class="ws song-layout">
      <aside class="rail">
        <div class="rail-auth">
          <button class="btn-primary" disabled>Sign up</button>
          <button class="btn-ghost" disabled>Log in</button>
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
          <strong>About the author</strong>
          <p>${esc(song.author)} — ${fmt(song.saves)} saves, ${fmt(song.comments)} comments.</p>
        </div>
      </aside>

      <article class="song">
        <h1 class="song-title">${esc(song.title)} ${TYPE_LABEL[song.type] || "Tab"} <span>by</span> ${esc(song.artist)}</h1>
        <p class="stats">${fmt(song.views)} views · ${fmt(song.saves)} saves · ${fmt(song.comments)} comments</p>
        <p class="byline">
          Author: ${esc(song.author)} · <span class="difficulty-${song.difficulty}">${song.difficulty}</span>
          · <span class="star">★</span> ${song.rating.toFixed(1)}
        </p>

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
          <button class="pill" id="print">Print</button>
        </div>

        <p class="tab-meta">Tuning: ${esc(song.tuning)} <span>·</span> Key: ${esc(transposeKey(song.key))} <span>·</span> Capo: ${esc(
          song.capo,
        )}</p>

        <div class="sheet-wrap">
          ${renderSheet(song)}
          ${chordPanel(song)}
        </div>
      </article>
    </main>`;
}

function savedView() {
  const list = songs.filter((s) => state.saved.has(s.id));
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
  else body = exploreView();

  app.innerHTML = header() + body;
  wire();

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

  const song = route().view === "song" ? byId(route().id) : null;
  if (!song) return;

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
}

function toggleSave(id) {
  if (state.saved.has(id)) state.saved.delete(id);
  else state.saved.add(id);
  persistSaved();
  render();
}

render();
