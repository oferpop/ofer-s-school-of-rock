// Pro layer: playlists, practice tracking, the metronome engine and backups.
// Everything stays in this browser — there is no account and no server.

const PLAYLISTS_KEY = "osr.playlists.v1";
const PRACTICE_KEY = "osr.practice.v1";
const VIDEOS_KEY = "osr.videos.v1";
const RATINGS_KEY = "osr.ratings.v1";
const TEMPOS_KEY = "osr.tempos.v1";

// --- playlists ----------------------------------------------------------

export function loadPlaylists() {
  try {
    const list = JSON.parse(localStorage.getItem(PLAYLISTS_KEY) || "[]");
    return Array.isArray(list) ? list.filter((p) => p && p.id) : [];
  } catch {
    return [];
  }
}

export function persistPlaylists(playlists) {
  localStorage.setItem(PLAYLISTS_KEY, JSON.stringify(playlists));
}

export function newPlaylist(name) {
  return {
    id: `list-${Date.now().toString(36)}`,
    name: String(name).trim() || "Untitled playlist",
    createdAt: new Date().toISOString(),
    songIds: [],
  };
}

export function playlistOf(playlists, id) {
  return playlists.find((p) => p.id === id) || null;
}

// --- tempo overrides ----------------------------------------------------

export function loadTempos() {
  try {
    const map = JSON.parse(localStorage.getItem(TEMPOS_KEY) || "{}");
    return map && typeof map === "object" && !Array.isArray(map) ? map : {};
  } catch {
    return {};
  }
}

export function persistTempos(map) {
  localStorage.setItem(TEMPOS_KEY, JSON.stringify(map));
}

// --- ratings ------------------------------------------------------------

export function loadRatings() {
  try {
    const map = JSON.parse(localStorage.getItem(RATINGS_KEY) || "{}");
    return map && typeof map === "object" && !Array.isArray(map) ? map : {};
  } catch {
    return {};
  }
}

export function persistRatings(map) {
  localStorage.setItem(RATINGS_KEY, JSON.stringify(map));
}

// --- videos -------------------------------------------------------------

export function loadVideos() {
  try {
    const map = JSON.parse(localStorage.getItem(VIDEOS_KEY) || "{}");
    return map && typeof map === "object" && !Array.isArray(map) ? map : {};
  } catch {
    return {};
  }
}

export function persistVideos(map) {
  localStorage.setItem(VIDEOS_KEY, JSON.stringify(map));
}

// --- practice tracking --------------------------------------------------

export function loadPractice() {
  try {
    const map = JSON.parse(localStorage.getItem(PRACTICE_KEY) || "{}");
    return map && typeof map === "object" && !Array.isArray(map) ? map : {};
  } catch {
    return {};
  }
}

export function persistPractice(map) {
  localStorage.setItem(PRACTICE_KEY, JSON.stringify(map));
}

// Called once per active second from the reader: a metronome or autoscroll run
// is what counts as practice, so idle reading does not inflate the numbers.
export function addPractice(songId, seconds) {
  const map = loadPractice();
  const row = map[songId] || { seconds: 0, lastAt: null };
  row.seconds += seconds;
  row.lastAt = new Date().toISOString();
  map[songId] = row;
  persistPractice(map);
  return map;
}

export function practiceTotals(map = loadPractice()) {
  const rows = Object.values(map);
  const seconds = rows.reduce((sum, row) => sum + (row.seconds || 0), 0);
  return { seconds, minutes: Math.round(seconds / 60), songs: rows.length };
}

export function practiceBySong(map = loadPractice()) {
  return Object.entries(map)
    .map(([id, row]) => ({ id, seconds: row.seconds || 0, lastAt: row.lastAt || null }))
    .sort((a, b) => b.seconds - a.seconds);
}

// --- metronome ----------------------------------------------------------

const BPM_MIN = 40;
const BPM_MAX = 240;
const BEAT_CHOICES = [2, 3, 4, 6];

export const clampBpm = (bpm) => Math.min(BPM_MAX, Math.max(BPM_MIN, Math.round(bpm)));
export const beatChoices = () => BEAT_CHOICES.slice();

export class Metronome {
  constructor() {
    this.on = false;
    this.bpm = 90;
    this.beats = 4;
    this.ac = null;
    this.timer = null;
    this.nextTime = 0;
    this.beat = 0;
    this.onBeat = null;
  }

  ensureAudio() {
    if (!this.ac) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return false;
      this.ac = new Ctor();
    }
    if (this.ac.state === "suspended") this.ac.resume();
    return true;
  }

  start(onBeat) {
    if (this.on) return;
    if (!this.ensureAudio()) return;
    this.on = true;
    this.onBeat = onBeat;
    this.beat = 0;
    this.nextTime = this.ac.currentTime + 0.08;
    this.timer = setInterval(() => this.tick(), 25);
  }

  stop() {
    this.on = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setBpm(bpm) {
    this.bpm = clampBpm(bpm);
  }

  setBeats(beats) {
    const next = Number(beats);
    if (!BEAT_CHOICES.includes(next)) return;
    this.beats = next;
    this.beat = 0;
  }

  tick() {
    if (!this.ac) return;
    const horizon = this.ac.currentTime + 0.12;
    while (this.nextTime < horizon) this.schedule(this.nextTime);
  }

  schedule(time) {
    const index = this.beat;
    this.click(time, index === 0);
    const delay = Math.max(0, (time - this.ac.currentTime) * 1000);
    const beatIndex = index;
    setTimeout(() => {
      if (this.on && this.onBeat) this.onBeat(beatIndex);
    }, delay);
    this.beat = (index + 1) % this.beats;
    this.nextTime += 60 / this.bpm;
  }

  click(time, accent) {
    const ac = this.ac;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = "square";
    osc.frequency.value = accent ? 1600 : 1000;
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(accent ? 0.3 : 0.15, time + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.06);
    osc.connect(gain).connect(ac.destination);
    osc.start(time);
    osc.stop(time + 0.07);
  }
}

// --- export / backup ----------------------------------------------------

export function downloadText(filename, text, type = "text/plain") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function buildBackup({ saved, imported, playlists, practice }) {
  return {
    app: "ofer-school-of-rock-pro",
    version: 1,
    exportedAt: new Date().toISOString(),
    saved: [...saved],
    imported,
    playlists,
    practice,
  };
}

// Accepts only the shape this app writes; unknown keys are ignored so a
// repaired or hand-edited file cannot inject arbitrary state.
export function readBackup(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { error: "That file is not valid JSON." };
  }
  if (!data || typeof data !== "object" || data.app !== "ofer-school-of-rock-pro") {
    return { error: "That is not an Ofer's School of Rock Pro backup." };
  }
  const ids = (value) => (Array.isArray(value) ? value.filter((id) => typeof id === "string") : []);
  const imported = Array.isArray(data.imported)
    ? data.imported.filter((song) => song && typeof song.id === "string" && typeof song.body === "string")
    : [];
  const playlists = Array.isArray(data.playlists)
    ? data.playlists
        .filter((list) => list && typeof list.id === "string")
        .map((list) => ({
          id: list.id,
          name: String(list.name || "Untitled playlist"),
          createdAt: list.createdAt || new Date().toISOString(),
          songIds: ids(list.songIds),
        }))
    : [];
  const practice = {};
  if (data.practice && typeof data.practice === "object" && !Array.isArray(data.practice)) {
    for (const [id, row] of Object.entries(data.practice)) {
      if (row && typeof row.seconds === "number" && row.seconds >= 0) {
        practice[id] = { seconds: row.seconds, lastAt: row.lastAt || null };
      }
    }
  }
  return { backup: { saved: ids(data.saved), imported, playlists, practice } };
}
