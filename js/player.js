// Plays the written tab: parses the chord sheet or ASCII tablature into timed
// events and synthesises them with Web Audio (Karplus-Strong plucks).

import {
  parseChord,
  chordToneIndexes,
  bassIndex,
  chordTokensByLine,
  transposeChord,
  simplifyChord,
} from "./chords.js?v=20261111f";

const NOTE_PC = {
  C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5,
  "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11,
};

// Low string first, matching the `tuning` field.
const TUNINGS = {
  "E A D G B E": [40, 45, 50, 55, 59, 64],
  "D A D G B E": [38, 45, 50, 55, 59, 64],
  "E A D G B": [40, 45, 50, 55, 59],
  "E A D G": [28, 33, 38, 43],
  "G C E A": [67, 60, 64, 69],
};

// Standard guitar intervals for a tuning we do not have a table for.
const STRING_PC = { E: 4, A: 9, D: 2, G: 7, B: 11, C: 0 };

function tuningMidi(tuning) {
  const key = String(tuning || "").replace(/\s+/g, " ").trim().toUpperCase();
  if (TUNINGS[key]) return TUNINGS[key];
  const names = key.split(" ").filter(Boolean);
  if (names.length < 4) return TUNINGS["E A D G B E"];
  const isBass = names.length === 4;
  let octave = isBass ? 1 : 2;
  let previous = -1;
  return names.map((name) => {
    const pc = NOTE_PC[name[0] + (name[1] === "#" || name[1] === "b" ? name[1] : "")] ?? STRING_PC[name[0]] ?? 4;
    if (pc <= previous) octave += 1;
    previous = pc;
    return 12 * (octave + 1) + pc;
  });
}

function chordNotes(token) {
  const pcs = chordToneIndexes(token);
  const root = pcs[0];
  const bass = bassIndex(token);
  const notes = [12 * 3 + bass];
  for (const pc of pcs) notes.push(12 * 4 + pc);
  if (root !== bass) notes.push(12 * 3 + root);
  return [...new Set(notes)];
}

const LABELED_TAB = /^[A-Ga-g]\|/;
const UG_ROW = /^[0-9|\-/\\~hpbxX()\s]+$/i;

function isUgRow(line) {
  const text = line.trim();
  return text.length >= 8 && /[-|]/.test(text) && UG_ROW.test(text);
}

/**
 * Last line of a tablature block starting at `start`, or -1.
 * Handles labelled blocks (`e|--0--`) and unlabelled Ultimate Guitar style
 * blocks of 4–6 numeric rows.
 */
export function tabBlockEnd(lines, start) {
  const first = lines[start].trim();
  if (LABELED_TAB.test(first)) {
    let end = start;
    while (end + 1 < lines.length && LABELED_TAB.test(lines[end + 1].trim())) end += 1;
    return end > start ? end : -1;
  }

  if (!isUgRow(first)) return -1;
  let end = start;
  while (end + 1 < lines.length && isUgRow(lines[end + 1])) end += 1;
  const rows = lines.slice(start, end + 1);
  const count = rows.length;
  if (count < 4 || count > 6) return -1;

  const lengths = rows.map((row) => row.trim().length);
  if (Math.max(...lengths) - Math.min(...lengths) > 2) return -1;
  if (!rows.some((row) => /\d/.test(row))) return -1;
  return end;
}

const TAB_LINE = /^[A-Ga-g]\|/;
const FRET_TOKEN = /\d+/g;

function tabBlockAt(lines, start) {
  const end = tabBlockEnd(lines, start);
  return end === -1 ? null : { start, end };
}

/**
 * Turn a song into timed events.
 *
 * If the sheet has ASCII tablature, that is played (one character ≈ a 16th
 * note). Otherwise the chord lines are played, one bar per chord.
 */
export function parseSong(song, { bpm = 100, transpose = 0, flats = false, simplify = false } = {}) {
  const lines = song.body.split("\n");
  const beat = 60 / bpm;
  const step = beat / 4;
  const tuning = tuningMidi(song.tuning);
  const events = [];
  const tabBlocks = [];

  for (let i = 0; i < lines.length; i++) {
    const block = tabBlockAt(lines, i);
    if (!block) continue;
    tabBlocks.push(block);
    i = block.end;
  }

  if (tabBlocks.length) {
    let timeOffset = 0;
    for (const block of tabBlocks) {
      const rows = [];
      for (let i = block.start; i <= block.end; i++) {
        const raw = lines[i].trim();
        const labeled = LABELED_TAB.test(raw);
        rows.push({ body: labeled ? raw.slice(2) : raw, letter: labeled ? raw[0] : null });
      }
      const columns = new Map();
      rows.forEach((row, rowIndex) => {
        FRET_TOKEN.lastIndex = 0;
        let match;
        while ((match = FRET_TOKEN.exec(row.body))) {
          const fret = Number(match[0]);
          if (!Number.isFinite(fret)) continue;
          // Bar lines take a character but no time: count only musical columns.
          const column = row.body.slice(0, match.index).replace(/\|/g, "").length;
          if (!columns.has(column)) columns.set(column, []);
          columns.get(column).push({ rowIndex, fret });
        }
      });

      const ordered = [...columns.entries()].sort((a, b) => a[0] - b[0]);
      const blockColumns = Math.max(1, ...rows.map((row) => row.body.replace(/\|/g, "").length));
      ordered.forEach(([column, notes], index) => {
        const midi = [];
        for (const { rowIndex, fret } of notes) {
          const stringMidi = tuning[tuning.length - 1 - rowIndex];
          if (stringMidi === undefined) continue;
          midi.push(stringMidi + fret);
        }
        if (!midi.length) return;
        const next = ordered[index + 1];
        const gapColumns = next ? next[0] - column : blockColumns - column;
        const gap = Math.max(1, gapColumns) * step;
        // A phrase's last note is held for at most two beats, so it does not
        // ring over the next phrase.
        const maxDuration = next ? beat * 4 : beat * 2;
        events.push({
          time: timeOffset + column * step,
          midi,
          duration: Math.max(0.12, Math.min(maxDuration, gap * 0.98)),
          lines: [block.start, block.end],
        });
      });

      // Consecutive tab blocks play one after another, never on top of each other.
      timeOffset += blockColumns * step;
    }
  } else {
    const tokensByLine = chordTokensByLine(song.body);
    let time = 0;
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed || TAB_LINE.test(trimmed) || /^\[.*\]$/.test(trimmed)) return;
      const chords = (tokensByLine[index] || []).filter((token) => parseChord(token));
      if (!chords.length) return;
      for (const token of chords) {
        let chord = token;
        if (transpose) chord = transposeChord(chord, transpose, flats);
        else if (flats) chord = transposeChord(chord, 0, true);
        if (simplify) chord = simplifyChord(chord);
        const midi = chordNotes(chord);
        if (midi.length) {
          events.push({
            time,
            midi,
            duration: beat * 3.6,
            lines: [index, index],
            chord,
          });
        }
        time += beat * 4;
      }
    });
  }

  events.sort((a, b) => a.time - b.time);
  const last = events[events.length - 1];
  const duration = last ? last.time + Math.max(last.duration, 0.5) : 0;
  return {
    events,
    duration,
    kind: tabBlocks.length ? "tab" : "chords",
    step,
  };
}

function pluckBuffer(ctx, midi) {
  const frequency = 440 * 2 ** ((midi - 69) / 12);
  const sampleRate = ctx.sampleRate;
  const seconds = 2.8;
  const size = Math.floor(sampleRate * seconds);
  const buffer = ctx.createBuffer(1, size, sampleRate);
  const data = buffer.getChannelData(0);

  // Karplus-Strong: noise burst through a damped delay line. The decay is set
  // per period so every string rings for roughly the same time (~1.2 s),
  // instead of low notes humming and high notes clicking.
  const period = Math.max(2, Math.round(sampleRate / frequency));
  const decay = Math.exp(-1 / (1.2 * frequency));
  const ring = new Float32Array(period);
  for (let i = 0; i < period; i++) ring[i] = Math.random() * 2 - 1;
  let index = 0;
  for (let i = 0; i < size; i++) {
    const current = ring[index];
    const next = ring[(index + 1) % period];
    data[i] = current;
    ring[index] = (current + next) * 0.5 * decay;
    index = (index + 1) % period;
  }
  return { buffer, frequency };
}

export async function countIn(bpm, beats = 4) {
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return;
  const ctx = new Ctor();
  if (ctx.state === "suspended") await ctx.resume();
  const beat = 60 / bpm;
  const start = ctx.currentTime + 0.05;
  for (let i = 0; i < beats; i++) {
    const when = start + i * beat;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = i === 0 ? 1600 : 1000;
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(i === 0 ? 0.28 : 0.16, when + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    osc.connect(gain).connect(ctx.destination);
    osc.start(when);
    osc.stop(when + 0.06);
  }
  await new Promise((resolve) => setTimeout(resolve, beats * beat * 1000 + 80));
  ctx.close().catch(() => {});
}

export class TabPlayer {
  constructor() {
    this.ctx = null;
    this.parsed = null;
    this.bpm = 100;
    this.position = 0;
    this.playing = false;
    this.paused = false;
    this.loop = false;
    this.master = null;
    this.buffers = new Map();
    this.timeouts = new Set();
    this.visual = null;
    this.onLine = null;
    this.onEvent = null;
    this.onEnd = null;
    this.onState = null;
    this.wallStart = 0;
    this.startPosition = 0;
    this.loopStart = 0;
    this.loopEnd = 0;
  }

  load(parsed, { bpm = 100 } = {}) {
    this.stop();
    this.parsed = parsed;
    this.bpm = bpm;
    this.position = 0;
  }

  async play({ from = this.position, onLine = null, onEvent = null, onEnd = null, onState = null, loop = false } = {}) {
    if (!this.parsed || !this.parsed.events.length) return false;
    this.stopTimers();
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return false;

    if (this.ctx) this.ctx.close().catch(() => {});
    this.ctx = new Ctor();
    if (this.ctx.state === "suspended") await this.ctx.resume();

    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);
    this.buffers.clear();

    this.onLine = onLine;
    this.onEvent = onEvent;
    this.onEnd = onEnd;
    this.onState = onState;
    this.loop = loop;
    this.playing = true;
    this.paused = false;
    const rangeEnd = this.loop && this.loopEnd > this.loopStart ? Math.min(this.loopEnd, this.parsed.duration) : this.parsed.duration;
    this.rangeEnd = rangeEnd;
    const start = this.loop && this.loopEnd > this.loopStart ? Math.max(this.loopStart, Math.min(from, rangeEnd)) : from;
    this.startPosition = Math.max(0, Math.min(start, rangeEnd - 0.05));
    this.wallStart = performance.now();

    const startAt = this.ctx.currentTime + 0.06;
    const offset = this.startPosition;

    for (const event of this.parsed.events) {
      if (event.time < offset) continue;
      if (event.time >= rangeEnd) break;
      const when = startAt + (event.time - offset);
      const delay = (when - this.ctx.currentTime) * 1000;
      this.scheduleVisual(delay, event);
      for (const midi of event.midi) this.scheduleNote(midi, when, event.duration);
    }

    const remaining = Math.max(0, rangeEnd - offset);
    this.scheduleEnd(remaining);
    this.onState?.("playing");
    return true;
  }

  scheduleNote(midi, when, duration) {
    const ctx = this.ctx;
    if (!ctx) return;
    const cached = this.buffers.get(midi);
    const { buffer } = cached || pluckBuffer(ctx, midi);
    if (!cached) this.buffers.set(midi, { buffer });
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    const end = when + Math.max(0.15, Math.min(2.7, duration));
    gain.gain.setValueAtTime(0.9, when);
    gain.gain.setValueAtTime(0.9, Math.max(when, end - 0.06));
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    source.connect(gain).connect(this.master);
    source.start(when);
    source.stop(end + 0.02);
  }

  scheduleVisual(delay, event) {
    const timeout = setTimeout(() => {
      this.timeouts.delete(timeout);
      if (this.onLine) this.onLine(event.lines);
      if (this.onEvent) this.onEvent(event);
    }, Math.max(0, delay));
    this.timeouts.add(timeout);
  }

  scheduleEnd(delay) {
    const timeout = setTimeout(() => {
      this.timeouts.delete(timeout);
      if (!this.playing) return;
      if (this.loop) {
        const restart = () => this.play({
          from: this.loopEnd > this.loopStart ? this.loopStart : 0,
          onLine: this.onLine,
          onEvent: this.onEvent,
          onEnd: this.onEnd,
          onState: this.onState,
          loop: true,
        });
        restart();
        return;
      }
      this.position = this.rangeEnd ?? this.parsed.duration;
      this.playing = false;
      this.paused = false;
      this.onState?.("ended");
      this.onEnd?.();
    }, Math.max(0, delay * 1000));
    this.timeouts.add(timeout);
  }

  elapsed() {
    if (!this.playing) return this.position;
    return this.startPosition + (performance.now() - this.wallStart) / 1000;
  }

  pause() {
    if (!this.playing) return false;
    this.position = Math.min(this.elapsed(), this.rangeEnd ?? this.parsed.duration);
    this.playing = false;
    this.paused = true;
    this.closeAudio();
    this.onState?.("paused");
    return true;
  }

  resume(options = {}) {
    if (!this.paused) return false;
    return this.play({
      from: this.position,
      onLine: this.onLine,
      onEvent: this.onEvent,
      onEnd: this.onEnd,
      onState: this.onState,
      loop: options.loop ?? this.loop,
    });
  }

  stop() {
    this.playing = false;
    this.paused = false;
    this.position = 0;
    this.closeAudio();
    this.onState?.("stopped");
  }

  closeAudio() {
    this.stopTimers();
    if (this.ctx) this.ctx.close().catch(() => {});
    this.ctx = null;
    this.master = null;
    this.buffers.clear();
  }

  stopTimers() {
    for (const timeout of this.timeouts) clearTimeout(timeout);
    this.timeouts.clear();
  }
}
