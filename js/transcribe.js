// Local transcription: turn recorded or loaded audio into a monophonic tab.
// No model download, no network: the same YIN detector as the tuner runs over
// short frames, notes are grouped, quantised to a grid and mapped to strings.

import { detectPitch, noteFromFrequency } from "./tuner.js?v=20261112bh";
import { tuningToMidi } from "./player.js?v=20261112bh";

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

// --- chord recognition --------------------------------------------------

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const CHORD_SHAPES = [
  { suffix: "", intervals: [0, 4, 7] },
  { suffix: "m", intervals: [0, 3, 7] },
  { suffix: "7", intervals: [0, 4, 7, 10] },
  { suffix: "m7", intervals: [0, 3, 7, 10] },
  { suffix: "maj7", intervals: [0, 4, 7, 11] },
  { suffix: "sus4", intervals: [0, 5, 7] },
  { suffix: "dim", intervals: [0, 3, 6] },
  { suffix: "aug", intervals: [0, 4, 8] },
];

// Krumhansl-Schmuckler key profiles. A key estimate stops chords that are
// wildly out of key and keeps the chart musically plausible.
const KEY_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KEY_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const DIATONIC_MAJOR = [0, 2, 4, 5, 7, 9, 11];
const DIATONIC_MINOR = [0, 2, 3, 5, 7, 8, 10];

const CANDIDATES = [];
for (let root = 0; root < 12; root++) {
  for (const shape of CHORD_SHAPES) {
    const pcs = shape.intervals.map((interval) => (root + interval) % 12);
    CANDIDATES.push({
      root,
      shape: shape.suffix,
      pcs,
      pcSet: new Set(pcs),
      label: `${NOTE_NAMES[root]}${shape.suffix}`,
    });
  }
}

const clamp01 = (value) => Math.max(0, Math.min(1, value));

export function chromaAt(samples, at, sampleRate, size = 4096) {
  const mags = spectrum(samples, at, size);
  const chroma = new Float64Array(12);
  const bass = new Float64Array(12);
  let energy = 0;
  for (let bin = 1; bin < mags.length; bin++) {
    const freq = (bin * sampleRate) / size;
    if (freq < 65 || freq > 2200) continue;
    const midi = 69 + 12 * Math.log2(freq / 440);
    const pitchClass = ((Math.round(midi) % 12) + 12) % 12;
    // Bass notes say more about the root than upper harmonics do.
    const weight = freq < 260 ? 1.6 : freq < 700 ? 1 : 0.6;
    chroma[pitchClass] += mags[bin] * weight;
    if (freq <= 260) bass[pitchClass] += mags[bin];
    energy += mags[bin];
  }
  let norm = 0;
  for (let i = 0; i < 12; i++) norm += chroma[i] * chroma[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < 12; i++) chroma[i] /= norm;

  let bassNorm = 0;
  for (let i = 0; i < 12; i++) bassNorm += bass[i] * bass[i];
  bassNorm = Math.sqrt(bassNorm) || 1;
  for (let i = 0; i < 12; i++) bass[i] /= bassNorm;

  return { time: at / sampleRate, chroma, bass, energy };
}

// Low frequencies need a finer frequency grid than a 44.1/48 kHz frame can
// give. Averaging down to ~11-12 kHz makes a semitone at 65 Hz wider than one
// FFT bin, which stops bass notes leaking into neighbouring pitch classes.
export function downsampleForChroma(samples, sampleRate, targetRate = 11025) {
  if (sampleRate <= targetRate * 1.15) return { samples, sampleRate };
  const factor = Math.max(1, Math.round(sampleRate / targetRate));
  const length = Math.floor(samples.length / factor);
  const output = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    let sum = 0;
    const start = i * factor;
    for (let j = 0; j < factor; j++) sum += samples[start + j];
    output[i] = sum / factor;
  }
  return { samples: output, sampleRate: sampleRate / factor };
}

export function chromaFrames(samples, sampleRate, { frameSize = 4096, hop = 1024, targetRate = 11025 } = {}) {
  const down = downsampleForChroma(samples, sampleRate, targetRate);
  const frames = [];
  for (let at = 0; at + frameSize <= down.samples.length; at += hop) {
    frames.push(chromaAt(down.samples, at, down.sampleRate, frameSize));
  }
  return frames;
}

// Same analysis, but yields to the page and reports progress so a whole song
// does not freeze the tab.
export async function estimateChordsAsync(samples, sampleRate, { bpm = 100, frameSize = 4096, hop = 1024 } = {}, onProgress) {
  const down = downsampleForChroma(samples, sampleRate);
  const frames = [];
  const total = Math.max(1, Math.floor((down.samples.length - frameSize) / hop));
  const yieldEvery = Math.max(1, Math.floor(total / 40));
  let count = 0;
  for (let at = 0; at + frameSize <= down.samples.length; at += hop) {
    frames.push(chromaAt(down.samples, at, down.sampleRate, frameSize));
    count += 1;
    if (count % yieldEvery === 0) {
      onProgress?.(count / total);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  onProgress?.(1);
  return chordsFromFrames(frames, down.sampleRate, bpm);
}

function detectKey(frames) {
  const sum = new Float64Array(12);
  for (const frame of frames) {
    // Loud frames carry more harmony than silence/noise.
    const weight = frame.energy || 0;
    for (let i = 0; i < 12; i++) sum[i] += frame.chroma[i] * weight;
  }
  let best = { root: 0, mode: "major", score: -Infinity };
  for (const mode of ["major", "minor"]) {
    const profile = mode === "major" ? KEY_MAJOR : KEY_MINOR;
    for (let root = 0; root < 12; root++) {
      let dot = 0;
      let norm = 0;
      for (let i = 0; i < 12; i++) {
        const value = profile[(i - root + 12) % 12];
        dot += sum[i] * value;
        norm += value * value;
      }
      const score = dot / Math.sqrt(norm || 1);
      if (score > best.score) best = { root, mode, score };
    }
  }
  return { ...best, label: `${NOTE_NAMES[best.root]}${best.mode === "minor" ? "m" : ""}` };
}

function keyDiatonic(key) {
  const scale = key.mode === "major" ? DIATONIC_MAJOR : DIATONIC_MINOR;
  const set = new Set(scale.map((step) => (step + key.root) % 12));
  if (key.mode === "minor") set.add((key.root + 11) % 12); // harmonic minor leading tone
  return set;
}

function scoreCandidates(frame, diatonic) {
  const chroma = frame.chroma;
  const bass = frame.bass || chroma;
  const scores = new Float32Array(CANDIDATES.length);
  for (let index = 0; index < CANDIDATES.length; index++) {
    const candidate = CANDIDATES[index];
    let tone = 0;
    for (const pc of candidate.pcs) tone += chroma[pc];
    tone /= candidate.pcs.length;

    let outside = 0;
    let outsideCount = 0;
    for (let pc = 0; pc < 12; pc++) {
      if (!candidate.pcSet.has(pc)) {
        outside += chroma[pc];
        outsideCount += 1;
      }
    }
    outside /= outsideCount || 1;

    const diatonicChord = candidate.pcs.every((pc) => diatonic.has(pc));
    let score = tone - 0.3 * outside + 0.4 * bass[candidate.root];
    score += diatonicChord ? 0.02 : -0.035;
    // Rootless diminished/augmented shapes are easy to hallucinate from a
    // dominant seventh; require a little more evidence for them.
    if (candidate.shape === "dim" || candidate.shape === "aug") score -= 0.1;
    // Triads win ties; a seventh has to be clearly present to be chosen.
    if (candidate.pcs.length === 4 && chroma[candidate.pcs[3]] > tone * 0.55) score += 0.03;
    score -= 0.012 * (candidate.pcs.length - 3);
    scores[index] = score;
  }
  return scores;
}

function transitionTable() {
  const size = CANDIDATES.length;
  const table = new Float32Array(size * size);
  for (let i = 0; i < size; i++) {
    const left = CANDIDATES[i];
    for (let j = 0; j < size; j++) {
      if (i === j) continue;
      const right = CANDIDATES[j];
      let shared = 0;
      for (const pc of right.pcs) if (left.pcSet.has(pc)) shared += 1;
      // Changing harmony costs a little; unrelated jumps cost more. This
      // removes one-frame flips without freezing a real chord change.
      table[i * size + j] = shared >= 2 ? -0.018 : shared >= 1 ? -0.04 : -0.085;
    }
  }
  return table;
}

const TRANSITIONS = transitionTable();

function mergeShortSegments(input, minDuration = 0.24) {
  let list = input.map((segment) => ({ ...segment }));
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const segment = list[i];
      if (segment.end - segment.start >= minDuration || list.length < 2) {
        out.push(segment);
        continue;
      }
      const previous = out[out.length - 1];
      const next = list[i + 1];
      if (previous && next && previous.label === next.label) {
        previous.end = next.end;
        i += 1;
        changed = true;
        continue;
      }
      const target =
        previous && (!next || previous.end - previous.start >= next.end - next.start) ? previous : next;
      if (!target) {
        out.push(segment);
        continue;
      }
      target.start = Math.min(target.start, segment.start);
      target.end = Math.max(target.end, segment.end);
      changed = true;
    }
    list = out;
    if (!changed) break;
  }

  const merged = [];
  for (const segment of list) {
    const last = merged[merged.length - 1];
    if (last && last.label === segment.label) last.end = segment.end;
    else merged.push(segment);
  }
  return merged;
}

function decodeChords(frames, diatonic) {
  let loudest = 0;
  for (const frame of frames) loudest = Math.max(loudest, frame.energy);
  const floor = Math.max(1e-9, loudest * 0.055);
  const audible = frames.filter((frame) => frame.energy > floor);
  if (audible.length < 2) return [];

  // Decode at roughly 10 frames per second; a chord rarely changes faster.
  const step = Math.max(2, Math.ceil(frames.length / 2400));
  const decodedFrames = [];
  for (let index = 0; index < audible.length; index += step) decodedFrames.push(audible[index]);
  if (decodedFrames.length < 2) return [];

  const count = CANDIDATES.length;
  const emissions = decodedFrames.map((frame) => scoreCandidates(frame, diatonic));
  const dp = new Float32Array(count);
  const next = new Float32Array(count);
  const back = new Int16Array(count * decodedFrames.length);
  for (let i = 0; i < count; i++) dp[i] = emissions[0][i];

  for (let t = 1; t < decodedFrames.length; t++) {
    const previousOffset = (t - 1) * count;
    const currentOffset = t * count;
    for (let j = 0; j < count; j++) {
      let best = -Infinity;
      let bestIndex = 0;
      for (let i = 0; i < count; i++) {
        const value = dp[i] + TRANSITIONS[i * count + j];
        if (value > best) {
          best = value;
          bestIndex = i;
        }
      }
      next[j] = best + emissions[t][j];
      back[currentOffset + j] = bestIndex;
    }
    dp.set(next);
    void previousOffset;
  }

  let last = 0;
  for (let i = 1; i < count; i++) if (dp[i] > dp[last]) last = i;
  const path = new Int16Array(decodedFrames.length);
  path[path.length - 1] = last;
  for (let t = decodedFrames.length - 1; t > 0; t--) {
    path[t - 1] = back[t * count + path[t]];
  }

  const frameStep = decodedFrames.length > 1 ? decodedFrames[1].time - decodedFrames[0].time : 0.1;
  const segments = [];
  let current = null;
  for (let t = 0; t < decodedFrames.length; t++) {
    const label = CANDIDATES[path[t]].label;
    const start = decodedFrames[t].time;
    const end = decodedFrames[t + 1]?.time ?? start + frameStep;
    if (current && current.label === label) current.end = end;
    else {
      if (current) segments.push(current);
      current = { label, start, end };
    }
  }
  if (current) segments.push(current);
  return mergeShortSegments(segments);
}

export function estimateChords(samples, sampleRate, { bpm = 100 } = {}) {
  return chordsFromFrames(chromaFrames(samples, sampleRate), sampleRate, bpm);
}

export function chordsFromFrames(frames, sampleRate, bpm = 100) {
  if (frames.length < 4) return { segments: [], bars: [], bpm, key: "", cellsPerBar: 1 };
  const safeBpm = Math.max(20, Math.min(240, Number(bpm) || 100));
  const key = detectKey(frames);
  const merged = decodeChords(frames, keyDiatonic(key));
  if (!merged.length) return { segments: [], bars: [], bpm: safeBpm, key: key.label, cellsPerBar: 1 };

  const barSeconds = (60 / safeBpm) * 4;
  const origin = merged[0].start;
  const lastTime = frames[frames.length - 1].time + 0.05 - origin;
  const barCount = Math.max(1, Math.ceil(lastTime / barSeconds));

  const durations = merged
    .map((segment) => segment.end - segment.start)
    .filter((duration) => duration >= 0.35)
    .sort((a, b) => a - b);
  const period = durations.length ? durations[Math.floor(durations.length / 2)] : 0;
  const cellsPerBar = period > 0
    ? Math.min(4, Math.max(1, Math.round(barSeconds / period)))
    : 1;
  const cell = barSeconds / cellsPerBar;
  const cellCount = barCount * cellsPerBar;

  const votes = Array.from({ length: cellCount }, () => new Map());
  for (const segment of merged) {
    const from = Math.max(0, Math.floor((segment.start - origin) / cell));
    const to = Math.min(cellCount - 1, Math.floor((segment.end - 1e-6 - origin) / cell));
    for (let index = from; index <= to; index++) {
      const overlap =
        Math.min(segment.end, origin + (index + 1) * cell) - Math.max(segment.start, origin + index * cell);
      if (overlap > 0) votes[index].set(segment.label, (votes[index].get(segment.label) || 0) + overlap);
    }
  }

  const progression = votes.map((cells) => {
    let top = "N";
    let topTime = 0;
    for (const [label, time] of cells) {
      if (time > topTime) {
        top = label;
        topTime = time;
      }
    }
    return top;
  });

  while (progression.length > 1 && progression[progression.length - 1] === "N") progression.pop();

  let running = "N";
  const filled = progression.map((label) => {
    if (label !== "N") running = label;
    return running;
  });
  while (filled.length > 1 && filled[filled.length - 1] === "N") filled.pop();

  return { segments: merged, bars: filled, bpm: safeBpm, key: key.label, cellsPerBar };
}

export function chordsToChart(bars, { cellsPerBar = 1, barsPerLine = 4 } = {}) {
  const perBar = Math.max(1, cellsPerBar);
  const barCount = Math.ceil(bars.length / perBar);
  const lines = [];
  for (let start = 0; start < barCount; start += barsPerLine) {
    let line = "";
    for (let bar = start; bar < Math.min(barCount, start + barsPerLine); bar++) {
      const cells = [];
      for (let index = 0; index < perBar; index++) {
        const label = bars[bar * perBar + index];
        cells.push((!label || label === "N" ? "-" : label).padEnd(5, " "));
      }
      line += `| ${cells.join("")}`;
    }
    lines.push(`${line.trimEnd()} |`);
  }
  return lines.join("\n");
}

// Estimate the pulse from the energy flux (onset envelope autocorrelation).
// Candidates are scored with their own harmonics (a comb) and softened by a
// gentle prior around 110 BPM, which is what stops the classic double/half
// tempo octave errors on steady material.
export function estimateTempo(samples, sampleRate, { minBpm = 30, maxBpm = 200 } = {}) {
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
  if (variance <= 0) return { bpm: 0, confidence: 0 };

  const fps = sampleRate / hop;
  const acf = (lag) => {
    if (lag < 1 || lag >= frames) return 0;
    let sum = 0;
    let count = 0;
    for (let i = 0; i + lag < frames; i++) {
      sum += flux[i] * flux[i + lag];
      count += 1;
    }
    return count ? sum / count : 0;
  };

  const minLag = Math.max(1, Math.floor((fps * 60) / maxBpm));
  const maxLag = Math.min(frames - 2, Math.ceil((fps * 60) / minBpm));

  let best = -Infinity;
  let bestBpm = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * fps) / lag;
    const prior = Math.exp(-((Math.log2(bpm / 110)) ** 2) / 1.2);
    const score = (acf(lag) + 0.6 * acf(lag * 2) + 0.3 * acf(lag * 3)) * prior;
    if (score > best) {
      best = score;
      bestBpm = bpm;
    }
  }
  if (!bestBpm) return { bpm: 0, confidence: 0 };

  let bpm = bestBpm;
  while (bpm < 70) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  return { bpm: Math.round(bpm), confidence: Math.min(1, best / (variance / frames)) };
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
