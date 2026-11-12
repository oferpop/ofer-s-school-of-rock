// Local transcription: turn recorded or loaded audio into a monophonic tab.
// No model download, no network: the same YIN detector as the tuner runs over
// short frames, notes are grouped, quantised to a grid and mapped to strings.

import { detectPitch, noteFromFrequency } from "./tuner.js?v=20261112l";
import { tuningToMidi } from "./player.js?v=20261112l";

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

// Place a pitch on the highest string that can reach it without a big stretch.
function placeNote(midi, tuning) {
  const candidates = [];
  tuning.forEach((openMidi, index) => {
    const fret = midi - openMidi;
    if (fret >= 0 && fret <= MAX_FRET) {
      // Highest string first (index 0 is the thinnest string in tuning arrays
      // low→high, so reverse it), then the lowest fret.
      candidates.push({ stringIndex: tuning.length - 1 - index, fret });
    }
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.stringIndex - b.stringIndex || a.fret - b.fret);
  return candidates[0];
}

export function notesToTab(notes, { bpm = 100, tuning = "E A D G B E", barsPerLine = 4, columnsPerBar = 16 } = {}) {
  if (!notes.length) return "";
  const openMidis = tuningToMidi(tuning);
  const step = 60 / bpm / 4; // one 16th
  const placed = [];
  for (const note of notes) {
    const spot = placeNote(note.midi, openMidis);
    if (!spot) continue;
    placed.push({
      column: Math.max(0, Math.round(note.start / step)),
      stringIndex: spot.stringIndex,
      fret: spot.fret,
    });
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
