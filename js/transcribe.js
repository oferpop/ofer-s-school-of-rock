// Local transcription: turn recorded or loaded audio into a monophonic tab.
// No model download, no network: the same YIN detector as the tuner runs over
// short frames, notes are grouped, quantised to a grid and mapped to strings.

import { detectPitch, noteFromFrequency } from "./tuner.js?v=20261112av";
import { tuningToMidi } from "./player.js?v=20261112av";

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
  { suffix: "sus4", intervals: [0, 5, 7] },
  { suffix: "dim", intervals: [0, 3, 6] },
];

export function chromaAt(samples, at, sampleRate, size = 4096) {
  const mags = spectrum(samples, at, size);
  const chroma = new Float64Array(12);
  let energy = 0;
  for (let bin = 1; bin < mags.length; bin++) {
    const freq = (bin * sampleRate) / size;
    if (freq < 65 || freq > 2200) continue;
    const midi = 69 + 12 * Math.log2(freq / 440);
    const pitchClass = ((Math.round(midi) % 12) + 12) % 12;
    // Bass notes say more about the root than upper harmonics do.
    const weight = freq < 260 ? 1.6 : freq < 700 ? 1 : 0.6;
    chroma[pitchClass] += mags[bin] * weight;
    energy += mags[bin];
  }
  let norm = 0;
  for (let i = 0; i < 12; i++) norm += chroma[i] * chroma[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < 12; i++) chroma[i] /= norm;
  return { time: at / sampleRate, chroma, energy };
}

export function chromaFrames(samples, sampleRate, { frameSize = 4096, hop = 2048 } = {}) {
  const frames = [];
  for (let at = 0; at + frameSize <= samples.length; at += hop) {
    frames.push(chromaAt(samples, at, sampleRate, frameSize));
  }
  return frames;
}

// Same analysis, but yields to the page and reports progress so a whole song
// does not freeze the tab.
export async function estimateChordsAsync(samples, sampleRate, { bpm = 100, frameSize = 4096, hop = 2048 } = {}, onProgress) {
  const frames = [];
  const total = Math.max(1, Math.floor((samples.length - frameSize) / hop));
  const yieldEvery = Math.max(1, Math.floor(total / 40));
  let count = 0;
  for (let at = 0; at + frameSize <= samples.length; at += hop) {
    frames.push(chromaAt(samples, at, sampleRate, frameSize));
    count += 1;
    if (count % yieldEvery === 0) {
      onProgress?.(count / total);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  onProgress?.(1);
  return chordsFromFrames(frames, sampleRate, bpm);
}

function bestChord(chroma) {
  let best = null;
  for (let root = 0; root < 12; root++) {
    for (const shape of CHORD_SHAPES) {
      const inChord = new Set();
      let sum = 0;
      for (const interval of shape.intervals) {
        const pc = (root + interval) % 12;
        inChord.add(pc);
        sum += chroma[pc];
      }
      // Dividing by the number of chord tones is what keeps a plain triad from
      // losing to its own seventh: an absent 7th adds nothing, so it dilutes
      // the average instead of winning.
      let score = sum / shape.intervals.length;
      for (let pc = 0; pc < 12; pc++) if (!inChord.has(pc)) score -= chroma[pc] * 0.18;
      // Prefer the root in the bass.
      score += chroma[root] * 0.2;
      if (!best || score > best.score) best = { score, root, shape: shape.suffix };
    }
  }
  return { label: `${NOTE_NAMES[best.root]}${best.shape}`, score: best.score };
}

export function estimateChords(samples, sampleRate, { bpm = 100 } = {}) {
  return chordsFromFrames(chromaFrames(samples, sampleRate), sampleRate, bpm);
}

export function chordsFromFrames(frames, sampleRate, bpm = 100) {
  if (frames.length < 4) return { segments: [], bars: [], bpm, key: "" };

  // Threshold on the loudest frame, not an absolute level, so quiet recordings
  // are still read and silent gaps are labelled N.
  let loudest = 0;
  for (const frame of frames) loudest = Math.max(loudest, frame.energy);
  const floor = Math.max(1e-9, loudest * 0.06);
  const labels = frames.map((frame) => (frame.energy > floor ? bestChord(frame.chroma).label : "N"));

  // Mode filter over five frames to stop single-frame flips.
  const smoothed = labels.map((label, index) => {
    const window = labels.slice(Math.max(0, index - 2), Math.min(labels.length, index + 3));
    const counts = new Map();
    for (const value of window) counts.set(value, (counts.get(value) || 0) + 1);
    let best = label;
    let bestCount = 0;
    for (const [value, count] of counts) {
      if (count > bestCount) {
        best = value;
        bestCount = count;
      }
    }
    return best;
  });

  const frameSeconds = 2048 / sampleRate;
  const segments = [];
  for (let i = 0; i < smoothed.length; i++) {
    const label = smoothed[i];
    if (label === "N") continue;
    const time = frames[i].time;
    const last = segments[segments.length - 1];
    if (last && last.label === label) {
      last.end = time + frameSeconds;
      continue;
    }
    if (last && time - last.end < frameSeconds * 1.5) {
      // Continue the previous segment over a tiny gap.
      if (last.label === label) {
        last.end = time + frameSeconds;
        continue;
      }
    }
    segments.push({ label, start: time, end: time + frameSeconds });
  }

  // Fold very short segments into the neighbour they came from.
  const merged = [];
  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    if (previous && segment.end - segment.start < 0.18) {
      previous.end = segment.end;
      continue;
    }
    merged.push(segment);
  }

  const tuned = refineTempo(merged, bpm);
  const barSeconds = (60 / tuned.bpm) * 4;
  const origin = merged.length ? merged[0].start : 0;
  const lastTime = frames[frames.length - 1].time + frameSeconds - origin;
  const barCount = Math.max(1, Math.ceil(lastTime / barSeconds));

  // How many chords fit in a bar? The fitted chord-change period answers that,
  // so a two-chords-per-bar song keeps both chords instead of losing one.
  const cellsPerBar = tuned.period > 0
    ? Math.min(4, Math.max(1, Math.round(barSeconds / tuned.period)))
    : 1;
  const cell = barSeconds / cellsPerBar;
  const cellCount = barCount * cellsPerBar;

  // Vote per cell by how much of the cell each chord covers.
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

  // Drop cells past the last chord before carrying anything forward.
  while (progression.length > 1 && progression[progression.length - 1] === "N") progression.pop();

  // Carry the last chord forward over gaps, and trim trailing empties.
  let running = "N";
  const filled = progression.map((label) => {
    if (label !== "N") running = label;
    return running;
  });
  while (filled.length > 1 && filled[filled.length - 1] === "N") filled.pop();

  const counts = new Map();
  for (const label of filled) if (label !== "N") counts.set(label, (counts.get(label) || 0) + 1);
  let key = "";
  let keyCount = 0;
  for (const [label, count] of counts) {
    if (count > keyCount) {
      key = label;
      keyCount = count;
    }
  }

  return { segments: merged, bars: filled, bpm: tuned.bpm, key, cellsPerBar };
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

// A chord chart only changes when the harmony changes, so a take with one
// chord per bar also exposes the bar length. When those changes are regular,
// prefer the octave of that rate closest to the onset estimate.
function refineTempo(segments, onsetBpm) {
  if (!onsetBpm || segments.length < 3) return { bpm: onsetBpm, period: 0 };
  // Fit a line through the chord-change times: the slope is the average gap
  // between changes, which is robust to one odd segment and precise enough to
  // land on the real tempo instead of one BPM below it.
  const count = segments.length;
  const meanIndex = (count - 1) / 2;
  const meanTime = segments.reduce((sum, segment) => sum + segment.start, 0) / count;
  let covariance = 0;
  let spread = 0;
  for (let i = 0; i < count; i++) {
    const di = i - meanIndex;
    covariance += di * (segments[i].start - meanTime);
    spread += di * di;
  }
  if (spread <= 0) return { bpm: onsetBpm, period: 0 };
  const period = covariance / spread;
  if (period < 0.4) return { bpm: onsetBpm, period: 0 };
  const residual = segments.reduce((sum, segment, i) => sum + Math.abs(segment.start - (meanTime + period * (i - meanIndex))), 0) / count;
  if (residual > period * 0.15) return { bpm: onsetBpm, period: 0 };

  // Fold to the octave nearest the onset estimate, then keep that estimate
  // when it agrees — it is usually the more precise of the two.
  const barRate = 240 / period;
  const octave = Math.round(Math.log2(onsetBpm / barRate));
  const candidate = barRate * 2 ** octave;
  if (candidate < 50 || candidate > 200) return { bpm: onsetBpm, period };
  const keep = Math.abs(candidate - onsetBpm) / onsetBpm <= 0.08 ? onsetBpm : Math.round(candidate);
  return { bpm: keep, period };
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
