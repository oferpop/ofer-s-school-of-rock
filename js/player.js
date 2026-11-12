// Plays the written tab: parses the chord sheet or ASCII tablature into timed
// events and synthesises them with Web Audio (Karplus-Strong plucks).

import {
  parseChord,
  chordToneIndexes,
  bassIndex,
  chordTokensByLine,
  transposeChord,
  simplifyChord,
} from "./chords.js?v=20261112bh";
import { notationToParsed } from "./notation.js?v=20261112bh";

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

export function tuningToMidi(tuning) {
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

const LABELED_TAB = /^\s*(?:[A-Ga-g][#b]?|[1-9])\s*\|/;
// Letters are techniques (h/p/b/r/v/t/x), not words. `^`, `+`, `*`, `$`, `@`
// appear in real tabs for bends, harmonics and pick noise.
const UG_ROW = /^[0-9|\-/\\~hpbxrvt<>()^*+$@%\s]+$/i;

function isUgRow(line) {
  const text = line.trim();
  return text.length >= 6 && /[-|]/.test(text) && UG_ROW.test(text);
}

// Safety net for exports that put words inside the row (PM, (Em), tr~~~) or use
// characters the strict matcher does not know. A real tab row has a bar line,
// several dashes and at least one fret number.
function looksLikeTabRow(line) {
  const text = line.trim();
  if (text.length < 6 || !text.includes("|") || !/\d/.test(text)) return false;
  return (text.match(/-/g) || []).length >= 4;
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

  if (!isUgRow(first) && !looksLikeTabRow(first)) return -1;
  let end = start;
  while (end + 1 < lines.length && (isUgRow(lines[end + 1]) || looksLikeTabRow(lines[end + 1]))) end += 1;
  const rows = lines.slice(start, end + 1);
  const count = rows.length;
  // 4- to 8-string instruments (guitar, 7/8-string, bass) are all tablature.
  if (count < 4 || count > 12) return -1;

  const lengths = rows.map((row) => row.trim().length);
  if (Math.max(...lengths) - Math.min(...lengths) > 3) return -1;
  if (!rows.some((row) => /\d/.test(row))) return -1;
  return end;
}

const TAB_LINE = /^\s*(?:[A-Ga-g][#b]?|[1-9])\s*\|/;
// A fret, optionally followed by a technique and its target fret: 7b9, 7b(9),
// 7/9, 9\7, 7h9, 7p9, 7~.
const TAB_TOKEN = /(\d+)(?:[ ]*([bhp/\\~^vV])[ ]*\(?(\d+)?\)?)?(?:[ ]*r[ ]*\(?(\d+)?\)?)?[ ]*(~*[vV]*)/;
const TAB_TAP = /^[tT](\d+)(?:[ ]*([bhp/\\~^])[ ]*\(?(\d+)\)?)?/;
const TAB_HARMONIC = /^<(\d+)>/;
const HARMONIC_OFFSET = { 12: 12, 7: 19, 5: 24, 4: 28, 3: 31, 2: 34, 9: 16 };

// Bend arrows written above a tab block: )1/2, )f, )1/2_, )full.
function bendSemitones(text) {
  const value = text.toLowerCase().replace(/\s+/g, "");
  if (value === "1/2") return 1;
  if (value === "11/2") return 3;
  if (value === "1/4") return 1;
  if (value === "1") return 2;
  return 2; // f / full
}

function parseBendAnnotations(lines) {
  const found = [];
  const pattern = /\)\s*(1\s*1\/2|1\/2|1\/4|full|f|1)\s*(_?)/gi;
  lines.forEach((line) => {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(line))) {
      found.push({ index: match.index, semis: bendSemitones(match[1]), release: match[2] === "_" });
    }
  });
  return found;
}

// Split one tablature row into notes: frets, taps (t12), harmonics (<7>) and
// dead notes (x).
function tokenizeTabRow(body) {
  const tokens = [];
  let index = 0;
  while (index < body.length) {
    const rest = body.slice(index);
    const harmonic = TAB_HARMONIC.exec(rest);
    if (harmonic) {
      tokens.push({ index, kind: "harmonic", fret: Number(harmonic[1]), length: harmonic[0].length });
      index += harmonic[0].length;
      continue;
    }
    // (0), (12) or (x): a tied/ghost note. It is held, not picked again, so it
    // must not create a new attack.
    const ghost = /^\((\d{1,2}|x|X)\)/.exec(rest);
    if (ghost) {
      tokens.push({ index, kind: "tie", fret: ghost[1].toLowerCase() === "x" ? null : Number(ghost[1]), length: ghost[0].length });
      index += ghost[0].length;
      continue;
    }
    if (body[index] === "x" || body[index] === "X") {
      tokens.push({ index, kind: "dead", length: 1 });
      index += 1;
      continue;
    }
    if (body[index] === "t" || body[index] === "T") {
      const tap = TAB_TAP.exec(rest);
      if (tap) {
        tokens.push({
          index,
          kind: "tap",
          fret: Number(tap[1]),
          technique: tap[2] || null,
          target: tap[3] !== undefined ? Number(tap[3]) : null,
          length: tap[0].length,
        });
        index += tap[0].length;
        continue;
      }
    }
    if (/\d/.test(body[index])) {
      const note = TAB_TOKEN.exec(rest);
      if (note && note.index === 0) {
        const technique = note[2] || null;
        const rawTarget = note[3] !== undefined ? Number(note[3]) : null;
        const vibratoTail = Boolean(note[5]) || technique === "v" || technique === "V";
        tokens.push({
          index,
          kind: "note",
          fret: Number(note[1]),
          technique,
          target: rawTarget,
          // 15/ with no landing note is a slide off: a gesture, not a target note.
          slideOff: rawTarget === null && (technique === "/" || technique === "\\"),
          release: note[4] !== undefined ? Number(note[4]) : null,
          vibrato: vibratoTail || technique === "~",
          length: note[0].length,
        });
        index += note[0].length;
        continue;
      }
    }
    index += 1;
  }
  return tokens;
}

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
  // Imported sheet music is already structured; no text parsing needed.
  if (song.notation) return notationToParsed(song.notation, { bpm });
  // Some publishers use en/em dashes inside tab rows.
  const lines = song.body.replace(/[\u2013\u2014]/g, "-").split("\n");
  const beat = 60 / bpm;
  const step = beat / 4;
  const tuning = tuningToMidi(song.tuning);
  const events = [];
  const tabBlocks = [];

  for (let i = 0; i < lines.length; i++) {
    const block = tabBlockAt(lines, i);
    if (!block) continue;
    tabBlocks.push(block);
    i = block.end;
  }

  const tokensByLine = chordTokensByLine(song.body);

  // Measure each block once: its column count decides how long it occupies the
  // timeline, so chord sections before and after it stay in order.
  for (const block of tabBlocks) {
    const rows = [];
    for (let i = block.start; i <= block.end; i++) {
      const raw = lines[i].trim();
      const labeled = LABELED_TAB.test(raw);
      rows.push(labeled ? raw.slice(raw.indexOf("|") + 1) : raw);
    }
    block.columns = Math.max(1, ...rows.map((row) => row.replace(/\|/g, "").length));
  }

  // A section is the text between [headers]. Inside a section that has
  // tablature the tab wins; a section without tablature plays as chords. That
  // keeps a solo in the middle of a chord sheet in its place instead of
  // dropping it and jumping straight to the next chord line.
  const sectionOf = new Array(lines.length).fill(0);
  let section = 0;
  for (let i = 0; i < lines.length; i++) {
    if (i > 0 && /^\[.*\]$/.test(lines[i].trim())) section += 1;
    sectionOf[i] = section;
  }
  const sectionHasTab = new Set();
  for (const block of tabBlocks) sectionHasTab.add(sectionOf[block.start]);

  const blockTimes = new Map();
  const chordPlans = [];
  let timeline = 0;
  for (let i = 0; i < lines.length; ) {
    const block = tabBlocks.find((candidate) => candidate.start === i);
    if (block) {
      blockTimes.set(i, timeline);
      timeline += block.columns * step;
      i = block.end + 1;
      continue;
    }
    const trimmed = lines[i].trim();
    const chords = (tokensByLine[i] || []).filter((token) => parseChord(token));
    if (
      chords.length &&
      !sectionHasTab.has(sectionOf[i]) &&
      !TAB_LINE.test(trimmed) &&
      !/^\[.*\]$/.test(trimmed)
    ) {
      const barDelimited = trimmed.includes("|");
      const bars = barDelimited
        ? trimmed
            .split("|")
            .map((part) => part.trim().split(/\s+/).filter((word) => word && parseChord(word)))
        : null;
      const barsUsed = barDelimited ? bars.filter((bar) => bar.length).length : chords.length;
      if (barsUsed) {
        chordPlans.push({ index: i, time: timeline, barDelimited, bars, chords });
        timeline += barsUsed * beat * 4;
      }
    }
    i += 1;
  }

  if (tabBlocks.length) {
    for (const [blockIndex, block] of tabBlocks.entries()) {
      const timeOffset = blockTimes.get(block.start) || 0;
      const previousEnd = blockIndex > 0 ? tabBlocks[blockIndex - 1].end + 1 : 0;
      const annotations = parseBendAnnotations(lines.slice(previousEnd, block.start));

      const rows = [];
      for (let i = block.start; i <= block.end; i++) {
        const raw = lines[i].trim();
        const labeled = LABELED_TAB.test(raw);
        rows.push({
          body: labeled ? raw.slice(raw.indexOf("|") + 1) : raw,
          letter: labeled ? raw[0] : null,
        });
      }
      const columns = new Map();
      rows.forEach((row, rowIndex) => {
        for (const token of tokenizeTabRow(row.body)) {
          // Bar lines take a character but no time: count only musical columns.
          const column = row.body.slice(0, token.index).replace(/\|/g, "").length;
          if (!columns.has(column)) columns.set(column, []);
          const marker =
            token.kind === "note"
              ? annotations.find((entry) => Math.abs(entry.index - (token.index + 2)) <= 3)
              : null;
          columns.get(column).push({
            ...token,
            rowIndex,
            bendSemis: marker?.semis ?? 0,
            bendRelease: marker?.release ?? false,
          });
        }
      });

      // A column holding only ties adds no attack. Dropping it lets the note
      // before it stay held until the next real pick instead of being cut short.
      const ordered = [...columns.entries()]
        .filter(([, tokens]) => tokens.some((token) => token.kind !== "tie"))
        .sort((a, b) => a[0] - b[0]);
      const blockColumns = Math.max(1, ...rows.map((row) => row.body.replace(/\|/g, "").length));
      const blockStart = timeOffset;
      const blockEnd = timeOffset + blockColumns * step;
      const lastOnString = new Map();
      ordered.forEach(([column, notes], index) => {
        const midi = [];
        const bend = [];
        const release = [];
        const technique = [];
        const vibrato = [];
        const dead = [];
        const harmonic = [];
        const slideOff = [];
        const slideOffAt = [];
        const slideOffDir = [];
        const played = [];

        for (const note of notes) {
          if (note.kind === "tie") continue;
          const stringMidi = tuning[tuning.length - 1 - note.rowIndex];
          if (stringMidi === undefined) continue;

          // "15vvvvvvv15/": the second 15 is the same note sliding away, not a
          // new pick. Attach the gesture to the note already sounding.
          const previous = lastOnString.get(note.rowIndex);
          if (note.slideOff && previous && previous.fret === note.fret && column - previous.column <= 16) {
            previous.event.slideOffAt[previous.index] = timeOffset + column * step;
            previous.event.slideOffDir[previous.index] = note.technique === "\\" ? -1 : 1;
            continue;
          }

          if (note.kind === "dead") {
            midi.push(stringMidi);
            bend.push(null);
            release.push(null);
            technique.push("x");
            vibrato.push(false);
            dead.push(true);
            harmonic.push(false);
            slideOff.push(false);
            slideOffAt.push(null);
            slideOffDir.push(1);
            played.push({ rowIndex: note.rowIndex, fret: note.fret });
            continue;
          }

          if (note.kind === "harmonic") {
            midi.push(stringMidi + (HARMONIC_OFFSET[note.fret] ?? 12));
            bend.push(null);
            release.push(null);
            technique.push("<");
            vibrato.push(false);
            dead.push(false);
            harmonic.push(true);
            slideOff.push(false);
            slideOffAt.push(null);
            slideOffDir.push(1);
            played.push({ rowIndex: note.rowIndex, fret: note.fret });
            continue;
          }

          midi.push(stringMidi + note.fret);
          const bendFret = note.target !== null ? note.target : note.bendSemis ? note.fret + note.bendSemis : null;
          bend.push(bendFret !== null ? stringMidi + bendFret : null);
          // A release only happens when the tab says so (r7 or the _ arrow);
          // bends and slides otherwise hold their new pitch.
          release.push(
            note.release !== null
              ? stringMidi + note.release
              : note.bendRelease
                ? stringMidi + note.fret
                : null,
          );
          technique.push(note.kind === "tap" ? "t" : note.technique);
          vibrato.push(Boolean(note.vibrato));
          dead.push(false);
          harmonic.push(false);
          slideOff.push(Boolean(note.slideOff));
          slideOffAt.push(null);
          slideOffDir.push(1);
          played.push({ rowIndex: note.rowIndex, fret: note.fret });
        }

        if (!midi.length) return;

        const next = ordered[index + 1];
        const gapColumns = next ? next[0] - column : blockColumns - column;
        const gap = Math.max(1, gapColumns) * step;
        // A phrase's last note is held for at most two beats, so it does not
        // ring over the next phrase.
        const maxDuration = next ? beat * 4 : beat * 2;
        const event = {
          time: timeOffset + column * step,
          blockStart,
          blockEnd,
          blockColumns,
          midi,
          bend,
          release,
          technique,
          vibrato,
          dead,
          harmonic,
          slideOff,
          slideOffAt,
          slideOffDir,
          duration: Math.max(0.12, Math.min(maxDuration, gap * 0.98)),
          lines: [block.start, block.end],
        };
        events.push(event);

        for (let i = 0; i < played.length; i++) {
          lastOnString.set(played[i].rowIndex, {
            event,
            index: i,
            column,
            fret: played[i].fret,
          });
        }
      });

      // Each block already has its place on the shared timeline.
    }
  }

  // Chord sections that do not contain tablature.
  for (const plan of chordPlans) {
    let time = plan.time;
    const emitChord = (token, index, length) => {
      let chord = token;
      if (transpose) chord = transposeChord(chord, transpose, flats);
      else if (flats) chord = transposeChord(chord, 0, true);
      if (simplify) chord = simplifyChord(chord);
      const midi = chordNotes(chord);
      if (midi.length) {
        events.push({
          time,
          midi,
          duration: Math.max(0.15, length * 0.9),
          lines: [index, index],
          chord,
        });
      }
      time += length;
    };

    if (plan.barDelimited) {
      // A bar-delimited line splits the bar between its chords.
      for (const bar of plan.bars) {
        if (!bar.length) continue;
        const length = (beat * 4) / bar.length;
        for (const token of bar) emitChord(token, plan.index, length);
      }
    } else {
      for (const token of plan.chords) emitChord(token, plan.index, beat * 4);
    }
  }

  events.sort((a, b) => a.time - b.time);
  const last = events[events.length - 1];
  const duration = last ? last.time + Math.max(last.duration, 0.5) : 0;
  return {
    events,
    duration,
    kind: tabBlocks.length ? "tab" : "chords",
    step,
    beats: 4,
    beatType: 4,
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

export async function countIn(bpm, beats = 4, volume = 1) {
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return;
  const ctx = new Ctor();
  if (ctx.state === "suspended") await ctx.resume();
  const beat = 60 / bpm;
  const start = ctx.currentTime + 0.05;
  const level = Math.max(0, Math.min(1, Number(volume) || 0));
  for (let i = 0; i < beats; i++) {
    const when = start + i * beat;
    const peak = (i === 0 ? 0.28 : 0.16) * level;
    if (peak <= 0.0001) continue;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = i === 0 ? 1600 : 1000;
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(peak, when + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    osc.connect(gain).connect(ctx.destination);
    osc.start(when);
    osc.stop(when + 0.06);
  }
  await new Promise((resolve) => setTimeout(resolve, beats * beat * 1000 + 80));
  ctx.close().catch(() => {});
}

// Does the played pitch land on one of the notes written at this point?
// Guitar melodies are often played an octave away from the written part, so
// Follow can accept the same pitch class in another octave.
export function matchesTargets(detectedMidi, targets, tolerance = 0.6, octaveTolerant = false) {
  return targets.some((target) => {
    const diff = Math.abs(detectedMidi - target);
    if (diff <= tolerance) return true;
    if (!octaveTolerant) return false;
    const pitchClass = Math.abs(((diff % 12) + 12) % 12);
    return pitchClass <= tolerance || Math.abs(pitchClass - 12) <= tolerance;
  });
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
    this.click = false;
    this.clickVolume = 0.55;
    this.clickGain = null;
    this.instrument = "guitar";
    this.instrumentVolume = 0.8;
    this.instrumentGain = null;
    this.pianoWaveCache = null;
  }

  load(parsed, { bpm = 100 } = {}) {
    this.stop();
    this.parsed = parsed;
    this.bpm = bpm;
    this.position = 0;
  }

  async play({
    from = this.position,
    onLine = null,
    onEvent = null,
    onEnd = null,
    onState = null,
    loop = false,
    click = this.click,
    clickVolume = this.clickVolume,
    instrument = this.instrument,
    instrumentVolume = this.instrumentVolume,
  } = {}) {
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
    this.clickVolume = Math.max(0, Math.min(1, Number(clickVolume) || 0));
    this.clickGain = this.ctx.createGain();
    this.clickGain.gain.value = this.clickVolume;
    this.clickGain.connect(this.master);
    this.instrument = instrument === "piano" ? "piano" : "guitar";
    const level = Number(instrumentVolume);
    this.instrumentVolume = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0.8;
    this.instrumentGain = this.ctx.createGain();
    this.instrumentGain.gain.value = this.instrumentVolume;
    this.instrumentGain.connect(this.master);
    this.pianoWaveCache = null;
    this.buffers.clear();

    this.onLine = onLine;
    this.onEvent = onEvent;
    this.onEnd = onEnd;
    this.onState = onState;
    this.loop = loop;
    this.click = Boolean(click);
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
      event.midi.forEach((midi, i) => {
        this.scheduleNote(
          midi,
          when,
          event.duration,
          event.bend?.[i] ?? null,
          event.technique?.[i] ?? null,
          event.release?.[i] ?? null,
          event.vibrato?.[i] ?? false,
          event.dead?.[i] ?? false,
          event.slideOff?.[i] ?? false,
          event.slideOffAt?.[i] ?? null,
          event.slideOffDir?.[i] ?? 1,
        );
      });
    }

    if (this.click) this.scheduleClicks(startAt, offset, rangeEnd);

    const remaining = Math.max(0, rangeEnd - offset);
    this.scheduleEnd(remaining);
    this.onState?.("playing");
    return true;
  }

  // 15/ or 9\\: glide away and fade, so no landing note is heard.
  slideOut(midi, when, duration, technique) {
    const ctx = this.ctx;
    if (!ctx) return;
    const cached = this.buffers.get(midi);
    const { buffer } = cached || pluckBuffer(ctx, midi);
    if (!cached) this.buffers.set(midi, { buffer });

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const length = Math.max(0.28, Math.min(0.55, duration));
    const end = when + length;
    const direction = technique === "\\" ? -1 : 1;
    source.playbackRate.setValueAtTime(1, when);
    source.playbackRate.linearRampToValueAtTime(2 ** ((direction * 2) / 12), end);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.9, when);
    gain.gain.setValueAtTime(0.9, when + Math.min(0.1, length * 0.35));
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    source.connect(gain).connect(this.instrumentGain || this.master);
    source.start(when);
    source.stop(end + 0.02);
  }

  scheduleNote(midi, when, duration, bendTo = null, technique = null, releaseTo = null, vibrato = false, dead = false, slideOff = false, slideAt = null, slideDir = 1) {
    if (this.instrument === "piano") {
      if (dead) this.thump(when, duration);
      else this.piano(midi, when, duration);
      return;
    }
    if (dead) {
      this.thump(when, duration);
      return;
    }
    if (slideOff) {
      this.slideOut(midi, when, duration, technique);
      return;
    }
    if ((technique === "h" || technique === "p") && bendTo !== null) {
      // Hammer-on / pull-off: articulate the start note, then the target.
      this.pluck(midi, when, Math.min(duration, 0.14));
      this.pluck(bendTo, when + 0.09, Math.max(0.12, duration - 0.09));
      return;
    }
    this.pluck(midi, when, duration, bendTo, technique, releaseTo, vibrato, slideAt, slideDir);
  }

  pianoWave() {
    if (this.pianoWaveCache) return this.pianoWaveCache;
    const ctx = this.ctx;
    if (!ctx) return null;
    const amps = [0, 1, 0.42, 0.2, 0.1, 0.05, 0.025];
    const real = new Float32Array(amps.length);
    const imag = Float32Array.from(amps);
    this.pianoWaveCache = ctx.createPeriodicWave(real, imag);
    return this.pianoWaveCache;
  }

  // Piano tone: a bright harmonic wave through a fast attack and a long
  // exponential decay. It is generated live, so no samples are downloaded.
  piano(midi, when, duration) {
    const ctx = this.ctx;
    if (!ctx) return;
    const wave = this.pianoWave();
    if (!wave) return;
    const frequency = 440 * 2 ** ((midi - 69) / 12);
    const gain = ctx.createGain();
    const end = when + Math.max(0.45, Math.min(3.4, duration + 0.45));
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(0.18, when + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    for (const cents of [0, 2.5]) {
      const osc = ctx.createOscillator();
      osc.setPeriodicWave(wave);
      osc.frequency.value = frequency;
      osc.detune.value = cents;
      osc.connect(gain);
      osc.start(when);
      osc.stop(end + 0.02);
    }
    gain.connect(this.instrumentGain || this.master);
  }

  // Dead note: a short muted thump with no pitch.
  thump(when, duration) {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!this.thumpBuffer) {
      const seconds = 0.12;
      const size = Math.ceil(ctx.sampleRate * seconds);
      const buffer = ctx.createBuffer(1, size, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < size; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.025));
      }
      this.thumpBuffer = buffer;
    }
    const source = ctx.createBufferSource();
    source.buffer = this.thumpBuffer;
    const gain = ctx.createGain();
    const end = when + Math.max(0.05, Math.min(0.14, duration));
    gain.gain.setValueAtTime(0.35, when);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    source.connect(gain).connect(this.instrumentGain || this.master);
    source.start(when);
    source.stop(end + 0.01);
  }

  pluck(midi, when, duration, bendTo = null, technique = null, releaseTo = null, vibrato = false, slideAt = null, slideDir = 1) {
    const ctx = this.ctx;
    if (!ctx) return;
    const cached = this.buffers.get(midi);
    const { buffer } = cached || pluckBuffer(ctx, midi);
    if (!cached) this.buffers.set(midi, { buffer });
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    // A slide attached to a sounding note (15...15/): the note keeps ringing
    // and glides away at that moment instead of being picked again.
    const glideAt = slideAt !== null && slideAt !== undefined ? Math.max(when + 0.04, slideAt) : null;
    const end = glideAt ? glideAt + 0.32 : when + Math.max(0.15, Math.min(2.7, duration));

    // Bend or slide: glide the playback rate from the written note to the
    // target fret, so the pitch rises to the note the tab names.
    if (bendTo !== null && midi !== bendTo && technique !== "h" && technique !== "p") {
      const semitones = bendTo - midi;
      const targetRate = 2 ** (semitones / 12);
      const glide = Math.min(0.2, Math.max(0.07, duration * 0.55));
      source.playbackRate.setValueAtTime(1, when);
      source.playbackRate.linearRampToValueAtTime(targetRate, when + glide);

      // 7b9r7: hold the bend, then release back near the end of the note.
      if (releaseTo !== null) {
        const releaseRate = 2 ** ((releaseTo - midi) / 12);
        const releaseAt = Math.max(when + glide + 0.06, end - Math.min(0.22, duration * 0.35));
        if (releaseAt < end - 0.03) {
          source.playbackRate.setValueAtTime(targetRate, releaseAt);
          source.playbackRate.linearRampToValueAtTime(releaseRate, Math.min(end - 0.01, releaseAt + 0.1));
        }
      }
    }

    if (glideAt) {
      source.playbackRate.setValueAtTime(1, when);
      source.playbackRate.setValueAtTime(1, glideAt);
      source.playbackRate.linearRampToValueAtTime(2 ** ((slideDir * 2) / 12), glideAt + 0.24);
    }

    // 7~: a gentle vibrato, about ±10 cents at 5.5 Hz.
    if (vibrato) {
      const lfo = ctx.createOscillator();
      const depth = ctx.createGain();
      lfo.frequency.value = 5.5;
      depth.gain.value = 0.006;
      lfo.connect(depth).connect(source.playbackRate);
      lfo.start(when + 0.06);
      lfo.stop(end);
    }

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.9, when);
    if (glideAt) {
      gain.gain.setValueAtTime(0.9, glideAt);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
    } else {
      gain.gain.setValueAtTime(0.9, Math.max(when, end - 0.06));
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
    }
    source.connect(gain).connect(this.instrumentGain || this.master);
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

  // Metronome click on every beat while the score or tab plays. The bar's
  // first beat is accented; the grid is anchored at time zero.
  scheduleClicks(startAt, offset, rangeEnd) {
    const ctx = this.ctx;
    if (!ctx) return;
    const beat = 60 / this.bpm;
    const beatsPerBar = Math.max(1, Number(this.parsed?.beats) || 4);
    const first = Math.ceil(offset / beat - 1e-6);
    for (let index = first; index * beat < rangeEnd - 1e-4; index++) {
      const when = startAt + index * beat - offset;
      if (when < ctx.currentTime - 0.01) continue;
      this.scheduleClick(when, index % beatsPerBar === 0);
    }
  }

  setInstrument(name) {
    this.instrument = name === "piano" ? "piano" : "guitar";
  }

  setInstrumentVolume(value) {
    this.instrumentVolume = Math.max(0, Math.min(1, Number(value) || 0));
    if (this.instrumentGain && this.ctx) {
      this.instrumentGain.gain.setTargetAtTime(this.instrumentVolume, this.ctx.currentTime, 0.01);
    }
  }

  // The per-beat click runs through clickGain, so changing the volume applies
  // to already-scheduled beats without restarting the player.
  setClickVolume(value) {
    this.clickVolume = Math.max(0, Math.min(1, Number(value) || 0));
    if (this.clickGain && this.ctx) {
      this.clickGain.gain.setTargetAtTime(this.clickVolume, this.ctx.currentTime, 0.01);
    }
  }

  scheduleClick(when, accent = false) {
    const ctx = this.ctx;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = accent ? 1600 : 1000;
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(accent ? 0.3 : 0.15, when + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.045);
    osc.connect(gain).connect(this.clickGain || this.master);
    osc.start(when);
    osc.stop(when + 0.05);
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
          click: this.click,
          clickVolume: this.clickVolume,
          instrument: this.instrument,
          instrumentVolume: this.instrumentVolume,
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
      click: options.click ?? this.click,
      clickVolume: options.clickVolume ?? this.clickVolume,
      instrument: options.instrument ?? this.instrument,
      instrumentVolume: options.instrumentVolume ?? this.instrumentVolume,
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
    this.clickGain = null;
    this.instrumentGain = null;
    this.pianoWaveCache = null;
    this.buffers.clear();
    this.thumpBuffer = null;
  }

  stopTimers() {
    for (const timeout of this.timeouts) clearTimeout(timeout);
    this.timeouts.clear();
  }
}
