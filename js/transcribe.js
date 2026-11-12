// Local transcription: turn recorded or loaded audio into a monophonic tab.
// No model download, no network: the same YIN detector as the tuner runs over
// short frames, notes are grouped, quantised to a grid and mapped to strings.

import { detectPitch, noteFromFrequency } from "./tuner.js?v=20261112n";
import { tuningToMidi } from "./player.js?v=20261112n";

const STRING_NAMES = ["e", "B", "G", "D", "A", "E"];
const MAX_FRET = 17;

export function detectNotes(samples, sampleRate, { frameSize = 2048, hop = 512, minRms = 0.01, minDuration = 0.06 } = {}) {
  const notes = [];
  let current = null;
  let silent = 0;

  const flush = () => {
    if (!current) return;
    if (current.end - current.start >= minDuration && current.readings.length) {
      const sorted = [...current.readings].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      notes.push({
        start: current.start,
        end: current.end,
        midi: Math.round(median),
        frequency: 440 * 2 ** ((median - 69) / 12),
      });
    }
    current = null;
  };

  for (let at = 0; at + frameSize <= samples.length; at += hop) {
    const slice = samples.subarray(at, at + frameSize);
    let energy = 0;
    for (let i = 0; i < frameSize; i++) energy += slice[i] * slice[i];
    const rms = Math.sqrt(energy / frameSize);
    const time = at / sampleRate;
    const pitched = rms >= minRms ? detectPitch(slice, sampleRate) : null;

    if (pitched) {
      const note = noteFromFrequency(pitched.frequency);
      const midiFloat = note.midi + note.cents / 100;
      const continues =
        current && Math.abs(current.readings[current.readings.length - 1] - midiFloat) < 0.7 && time - current.lastFrame < 0.12;

      if (continues) {
        current.end = time + frameSize / sampleRate;
        current.lastFrame = time;
        current.readings.push(midiFloat);
      } else {
        flush();
        current = {
          start: time,
          end: time + frameSize / sampleRate,
          lastFrame: time,
          readings: [midiFloat],
        };
      }
      silent = 0;
    } else {
      silent += 1;
      if (current && (silent * hop) / sampleRate > 0.08) flush();
    }
  }
  flush();
  return notes;
}

// --- polyphonic analysis ------------------------------------------------

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let j = 0; j < len / 2; j++) {
        const uRe = re[i + j];
        const uIm = im[i + j];
        const vRe = re[i + j + len / 2] * curRe - im[i + j + len / 2] * curIm;
        const vIm = re[i + j + len / 2] * curIm + im[i + j + len / 2] * curRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + len / 2] = uRe - vRe;
        im[i + j + len / 2] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

const windowCache = new Map();
function hann(size) {
  if (!windowCache.has(size)) {
    const w = new Float32Array(size);
    for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
    windowCache.set(size, w);
  }
  return windowCache.get(size);
}

function spectrum(samples, at, size) {
  const win = hann(size);
  const re = new Float32Array(size);
  const im = new Float32Array(size);
  for (let i = 0; i < size; i++) re[i] = (samples[at + i] || 0) * win[i];
  fft(re, im);
  const mags = new Float32Array(size / 2);
  for (let i = 0; i < size / 2; i++) mags[i] = Math.hypot(re[i], im[i]);
  return mags;
}

function binAt(mags, freq, sampleRate, size) {
  const bin = (freq * size) / sampleRate;
  const lo = Math.floor(bin);
  if (lo < 1 || lo + 1 >= mags.length) return 0;
  const frac = bin - lo;
  return mags[lo] * (1 - frac) + mags[lo + 1] * frac;
}

// Score how well a fundamental explains the spectrum. The fundamental itself
// must be present, otherwise a low subharmonic can "explain" a chord through
// its upper harmonics.
function harmonicScore(mags, f0, sampleRate, size, minFundamental) {
  const fundamental = binAt(mags, f0, sampleRate, size);
  if (fundamental < minFundamental) return 0;
  let score = fundamental * 2.2;
  for (let h = 2; h <= 5; h++) score += binAt(mags, f0 * h, sampleRate, size) / (h * 1.4);
  return score;
}

function estimatePitches(mags, sampleRate, size) {
  const peaks = [];
  let max = 0;
  for (let i = 1; i < mags.length - 1; i++) {
    if (mags[i] > mags[i - 1] && mags[i] >= mags[i + 1] && mags[i] > max) max = mags[i];
  }
  if (max <= 0) return [];
  for (let i = 1; i < mags.length - 1; i++) {
    if (mags[i] > mags[i - 1] && mags[i] >= mags[i + 1] && mags[i] > max * 0.06) {
      const freq = (i * sampleRate) / size;
      if (freq >= 60 && freq <= 2200) peaks.push({ freq, mag: mags[i] });
    }
  }

  const candidates = new Map();
  for (const peak of peaks) {
    for (let harmonic = 1; harmonic <= 4; harmonic++) {
      const f0 = peak.freq / harmonic;
      if (f0 < 70 || f0 > 1200) continue;
      const score = harmonicScore(mags, f0, sampleRate, size, max * 0.07);
      const midi = Math.round(69 + 12 * Math.log2(f0 / 440));
      const current = candidates.get(midi);
      if (!current || current.score < score) candidates.set(midi, { midi, score });
    }
  }

  const ranked = [...candidates.values()].sort((a, b) => b.score - a.score);
  if (!ranked.length) return [];
  const best = ranked[0].score;
  const chosen = [];
  for (const candidate of ranked) {
    if (candidate.score < best * 0.3) continue;
    // Do not keep the same pitch class twice in one chord.
    if (chosen.some((other) => Math.abs(((other - candidate.midi) % 12 + 12) % 12) < 1)) continue;
    chosen.push(candidate.midi);
    if (chosen.length >= 4) break;
  }
  return chosen.sort((a, b) => a - b);
}

/**
 * Onset-based polyphonic events. Every attack starts an event; the pitches in
 * that event are read from the spectrum just after it.
 */
export async function detectChordsAsync(samples, sampleRate, options = {}, onProgress) {
  const { frameSize = 4096, hop = 1024, minRms = 0.012, minDuration = 0.07 } = options;
  const frames = Math.max(1, Math.floor((samples.length - frameSize) / hop));
  const events = [];
  const energies = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    const at = i * hop;
    for (let j = 0; j < frameSize; j++) sum += samples[at + j] * samples[at + j];
    energies[i] = Math.sqrt(sum / frameSize);
  }

  let current = null;
  let avg = 0;
  for (let i = 0; i < frames; i++) {
    const time = (i * hop) / sampleRate;
    const level = energies[i];
    const onset = level > minRms && (level > avg * 1.55 || (i > 0 && energies[i - 1] < minRms));
    avg = avg * 0.85 + level * 0.15;

    if (onset) {
      const mags = spectrum(samples, i * hop, frameSize);
      const midis = estimatePitches(mags, sampleRate, frameSize);
      if (current) current.end = time;
      current = midis.length ? { start: time, end: time, midis } : null;
      if (current && events.length && current.start - events[events.length - 1].end < 0.02) {
        // Merge a re-attack of the same chord.
        const previous = events[events.length - 1];
        if (previous.midis.join("-") === current.midis.join("-")) {
          current = previous;
          current.end = time;
          continue;
        }
      }
      if (current) events.push(current);
    }

    if (current) current.end = Math.max(current.end, time + hop / sampleRate);
    if (level < minRms * 0.6 && current) {
      current = null;
    }

    if (i % 200 === 0) {
      onProgress?.(i / frames);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  onProgress?.(1);
  return events.filter((event) => event.end - event.start >= minDuration && event.midis.length);
}

// Estimate the pulse from the energy flux (onset envelope autocorrelation).
export function estimateTempo(samples, sampleRate, { minBpm = 60, maxBpm = 200 } = {}) {
  const frame = 1024;
  const hop = 256;
  const frames = Math.floor((samples.length - frame) / hop);
  if (frames < 24) return { bpm: 0, confidence: 0 };

  const energy = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    const at = i * hop;
    for (let j = 0; j < frame; j++) sum += samples[at + j] * samples[at + j];
    energy[i] = Math.sqrt(sum / frame);
  }

  const flux = new Float32Array(frames);
  for (let i = 1; i < frames; i++) flux[i] = Math.max(0, energy[i] - energy[i - 1]);
  let mean = 0;
  for (let i = 0; i < frames; i++) mean += flux[i];
  mean /= frames;
  for (let i = 0; i < frames; i++) flux[i] -= mean;

  let variance = 0;
  for (let i = 0; i < frames; i++) variance += flux[i] * flux[i];

  const fps = sampleRate / hop;
  const minLag = Math.max(1, Math.floor((fps * 60) / maxBpm));
  const maxLag = Math.min(frames - 2, Math.ceil((fps * 60) / minBpm));
  let best = 0;
  let bestLag = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < frames; i++) sum += flux[i] * flux[i + lag];
    if (sum > best) {
      best = sum;
      bestLag = lag;
    }
  }
  if (!bestLag || variance <= 0) return { bpm: 0, confidence: 0 };

  let bpm = (60 * fps) / bestLag;
  while (bpm < 70) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  return { bpm: Math.round(bpm), confidence: Math.min(1, best / variance) };
}

// Async version of detectNotes: yields to the page and reports progress.
export async function detectNotesAsync(samples, sampleRate, options = {}, onProgress) {
  const { frameSize = 2048, hop = 512, minRms = 0.01, minDuration = 0.06 } = options;
  const total = Math.max(1, Math.floor((samples.length - frameSize) / hop));
  const notes = [];
  let current = null;
  let silent = 0;
  let processed = 0;

  const flush = () => {
    if (!current) return;
    if (current.end - current.start >= minDuration && current.readings.length) {
      const sorted = [...current.readings].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      notes.push({
        start: current.start,
        end: current.end,
        midi: Math.round(median),
        frequency: 440 * 2 ** ((median - 69) / 12),
      });
    }
    current = null;
  };

  for (let at = 0; at + frameSize <= samples.length; at += hop) {
    const slice = samples.subarray(at, at + frameSize);
    let energy = 0;
    for (let i = 0; i < frameSize; i++) energy += slice[i] * slice[i];
    const rms = Math.sqrt(energy / frameSize);
    const time = at / sampleRate;
    const pitched = rms >= minRms ? detectPitch(slice, sampleRate) : null;

    if (pitched) {
      const note = noteFromFrequency(pitched.frequency);
      const midiFloat = note.midi + note.cents / 100;
      const continues =
        current && Math.abs(current.readings[current.readings.length - 1] - midiFloat) < 0.7 && time - current.lastFrame < 0.12;
      if (continues) {
        current.end = time + frameSize / sampleRate;
        current.lastFrame = time;
        current.readings.push(midiFloat);
      } else {
        flush();
        current = { start: time, end: time + frameSize / sampleRate, lastFrame: time, readings: [midiFloat] };
      }
      silent = 0;
    } else {
      silent += 1;
      if (current && (silent * hop) / sampleRate > 0.08) flush();
    }

    processed += 1;
    if (processed % 160 === 0) {
      onProgress?.(Math.min(1, processed / total));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  flush();
  onProgress?.(1);
  return notes;
}

// Place the pitches of one event on distinct strings, highest note first so a
// chord keeps its top voice and each note gets its own string.
function placeChord(midis, tuning) {
  const used = new Set();
  const placed = [];
  for (const midi of [...midis].sort((a, b) => b - a)) {
    const candidates = [];
    tuning.forEach((openMidi, index) => {
      const stringIndex = tuning.length - 1 - index;
      const fret = midi - openMidi;
      if (fret >= 0 && fret <= MAX_FRET && !used.has(stringIndex)) {
        candidates.push({ stringIndex, fret });
      }
    });
    if (!candidates.length) continue;
    candidates.sort((a, b) => a.fret - b.fret || a.stringIndex - b.stringIndex);
    used.add(candidates[0].stringIndex);
    placed.push({ midi, ...candidates[0] });
  }
  return placed;
}

export function notesToTab(notes, { bpm = 100, tuning = "E A D G B E", barsPerLine = 4, columnsPerBar = 16 } = {}) {
  if (!notes.length) return "";
  const openMidis = tuningToMidi(tuning);
  const step = 60 / bpm / 4; // one 16th
  const placed = [];
  for (const note of notes) {
    const spots = placeChord(note.midis || [note.midi], openMidis);
    for (const spot of spots) {
      placed.push({
        column: Math.max(0, Math.round(note.start / step)),
        stringIndex: spot.stringIndex,
        fret: spot.fret,
      });
    }
  }
  if (!placed.length) return "";

  const lastColumn = Math.max(...placed.map((note) => note.column));
  const columnsPerLine = barsPerLine * columnsPerBar;
  const lines = Math.ceil((lastColumn + 2) / columnsPerLine);
  const parts = [];

  for (let line = 0; line < lines; line++) {
    const from = line * columnsPerLine;
    const rows = STRING_NAMES.map((name) => ({
      name,
      cells: Array.from({ length: columnsPerLine }, () => "-"),
    }));

    for (const note of placed) {
      const local = note.column - from;
      if (local < 0 || local >= columnsPerLine) continue;
      const row = rows[note.stringIndex];
      const text = String(note.fret);
      row.cells[local] = text[0];
      if (text.length > 1 && local + 1 < columnsPerLine) row.cells[local + 1] = text[1];
    }

    for (const row of rows) {
      for (let bar = 1; bar < barsPerLine; bar++) row.cells[bar * columnsPerBar - 1] = "|";
      parts.push(`${row.name}|${row.cells.join("")}|`);
    }
    parts.push("");
  }

  return parts.join("\n").trim();
}
