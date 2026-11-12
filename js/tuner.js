// Chromatic tuner: microphone pitch detection and reference tones.
// Everything runs in the page; no audio is recorded or uploaded.

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export const TUNINGS = {
  guitar: {
    label: "Guitar · standard",
    group: "Guitar",
    strings: [
      ["E2", 82.41],
      ["A2", 110.0],
      ["D3", 146.83],
      ["G3", 196.0],
      ["B3", 246.94],
      ["E4", 329.63],
    ],
  },
  dropd: {
    label: "Guitar · drop D",
    group: "Guitar",
    strings: [
      ["D2", 73.42],
      ["A2", 110.0],
      ["D3", 146.83],
      ["G3", 196.0],
      ["B3", 246.94],
      ["E4", 329.63],
    ],
  },
  halfdown: {
    label: "Guitar · half step down",
    group: "Guitar",
    strings: [
      ["Eb2", 77.78],
      ["Ab2", 103.83],
      ["Db3", 138.59],
      ["Gb3", 185.0],
      ["Bb3", 233.08],
      ["Eb4", 311.13],
    ],
  },
  wholestep: {
    label: "Guitar · whole step down",
    group: "Guitar",
    strings: [
      ["D2", 73.42],
      ["G2", 98.0],
      ["C3", 130.81],
      ["F3", 174.61],
      ["A3", 220.0],
      ["D4", 293.66],
    ],
  },
  dropc: {
    label: "Guitar · drop C",
    group: "Guitar",
    strings: [
      ["C2", 65.41],
      ["G2", 98.0],
      ["C3", 130.81],
      ["F3", 174.61],
      ["A3", 220.0],
      ["D4", 293.66],
    ],
  },
  dropb: {
    label: "Guitar · drop B",
    group: "Guitar",
    strings: [
      ["B1", 61.74],
      ["F#2", 92.5],
      ["B2", 123.47],
      ["E3", 164.81],
      ["G#3", 207.65],
      ["C#4", 277.18],
    ],
  },
  openg: {
    label: "Guitar · open G",
    group: "Guitar",
    strings: [
      ["D2", 73.42],
      ["G2", 98.0],
      ["D3", 146.83],
      ["G3", 196.0],
      ["B3", 246.94],
      ["D4", 293.66],
    ],
  },
  opend: {
    label: "Guitar · open D",
    group: "Guitar",
    strings: [
      ["D2", 73.42],
      ["A2", 110.0],
      ["D3", 146.83],
      ["F#3", 185.0],
      ["A3", 220.0],
      ["D4", 293.66],
    ],
  },
  opene: {
    label: "Guitar · open E",
    group: "Guitar",
    strings: [
      ["E2", 82.41],
      ["B2", 123.47],
      ["E3", 164.81],
      ["G#3", 207.65],
      ["B3", 246.94],
      ["E4", 329.63],
    ],
  },
  dadgad: {
    label: "Guitar · DADGAD",
    group: "Guitar",
    strings: [
      ["D2", 73.42],
      ["A2", 110.0],
      ["D3", 146.83],
      ["G3", 196.0],
      ["A3", 220.0],
      ["D4", 293.66],
    ],
  },
  bass: {
    label: "Bass · 4 string",
    group: "Bass",
    strings: [
      ["E1", 41.2],
      ["A1", 55.0],
      ["D2", 73.42],
      ["G2", 98.0],
    ],
  },
  bass5: {
    label: "Bass · 5 string",
    group: "Bass",
    strings: [
      ["B0", 30.87],
      ["E1", 41.2],
      ["A1", 55.0],
      ["D2", 73.42],
      ["G2", 98.0],
    ],
  },
  ukulele: {
    label: "Ukulele · standard",
    group: "Ukulele",
    strings: [
      ["G4", 392.0],
      ["C4", 261.63],
      ["E4", 329.63],
      ["A4", 440.0],
    ],
  },
  ukulelelow: {
    label: "Ukulele · low G",
    group: "Ukulele",
    strings: [
      ["G3", 196.0],
      ["C4", 261.63],
      ["E4", 329.63],
      ["A4", 440.0],
    ],
  },
};

// The tuner works in MIDI, so string targets are converted once per reading.
export function midiForFrequency(frequency) {
  return 69 + 12 * Math.log2(frequency / 440);
}

/**
 * Closest string to a measured pitch. Returns the string index, its name, its
 * exact MIDI target and how many cents the player is away from it.
 */
export function nearestString(midiFloat, strings) {
  let best = null;
  strings.forEach(([name, hz], index) => {
    const midi = midiForFrequency(hz);
    const cents = (midiFloat - midi) * 100;
    if (!best || Math.abs(cents) < Math.abs(best.cents)) {
      best = { index, name, midi, cents };
    }
  });
  return best;
}

export function midiToNote(midi) {
  const rounded = Math.round(midi);
  return {
    midi: rounded,
    name: NOTE_NAMES[((rounded % 12) + 12) % 12],
    octave: Math.floor(rounded / 12) - 1,
  };
}

export function noteFromFrequency(frequency, a4 = 440) {
  const midiFloat = 69 + 12 * Math.log2(frequency / a4);
  const midi = Math.round(midiFloat);
  const cents = Math.round((midiFloat - midi) * 100);
  return {
    midi,
    name: NOTE_NAMES[((midi % 12) + 12) % 12],
    octave: Math.floor(midi / 12) - 1,
    cents,
    frequency,
  };
}

// YIN-style pitch detection: difference function, cumulative-mean
// normalisation, then the first dip under a threshold. More reliable than raw
// autocorrelation for low guitar strings, where short lags otherwise win.
export function detectPitch(buffer, sampleRate) {
  const size = buffer.length;
  let energy = 0;
  for (let i = 0; i < size; i++) energy += buffer[i] * buffer[i];
  // Ignore pick noise, hiss and the room: a plucked string is much louder.
  if (Math.sqrt(energy / size) < 0.012) return null;

  const minLag = Math.max(2, Math.floor(sampleRate / 1200));
  const maxLag = Math.min(Math.floor(sampleRate / 38), size - 2);
  if (maxLag <= minLag) return null;

  const diff = new Float32Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    const limit = size - lag;
    for (let i = 0; i < limit; i++) {
      const delta = buffer[i] - buffer[i + lag];
      sum += delta * delta;
    }
    diff[lag] = sum;
  }

  const norm = new Float32Array(maxLag + 2);
  let running = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    running += diff[lag];
    norm[lag] = running > 0 ? (diff[lag] * (lag - minLag + 1)) / running : 1;
  }

  const threshold = 0.15;
  let candidate = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (norm[lag] < threshold) {
      while (lag + 1 <= maxLag && norm[lag + 1] < norm[lag]) lag += 1;
      candidate = lag;
      break;
    }
  }
  if (candidate === -1) {
    let best = Infinity;
    let bestLag = -1;
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (norm[lag] < best) {
        best = norm[lag];
        bestLag = lag;
      }
    }
    if (best > 0.6 || bestLag < 0) return null;
    candidate = bestLag;
  }

  const x1 = diff[candidate - 1] ?? diff[candidate];
  const x2 = diff[candidate];
  const x3 = diff[candidate + 1] ?? diff[candidate];
  const a = (x1 + x3 - 2 * x2) / 2;
  const b = (x3 - x1) / 2;
  const shift = a ? -b / (2 * a) : 0;
  const clarity = norm[candidate];
  // A dip that is not deep enough is noise or an attack transient.
  if (clarity > 0.22) return null;

  const period = candidate + Math.max(-0.5, Math.min(0.5, shift));
  const frequency = sampleRate / period;
  if (!Number.isFinite(frequency) || frequency <= 30) return null;
  return { frequency, clarity };
}

export class Tuner {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.buffer = null;
    this.stream = null;
    this.raf = null;
    this.running = false;
    this.lastRead = 0;
    this.onResult = null;
    this.onError = null;
    this.refCtx = null;
    this.session = 0;
    // Drum-style string targeting: "auto" follows the nearest string,
    // "string" pins one string, "chromatic" ignores the tuning entirely.
    this.mode = "auto";
    this.strings = [];
    this.stringIndex = -1;
    this.currentString = null;
  }

  configure({ mode = this.mode, strings = this.strings, stringIndex = this.stringIndex } = {}) {
    this.mode = mode;
    this.strings = strings;
    this.stringIndex = stringIndex;
    this.currentString = null;
    this.history = [];
    this.stable = null;
    this.pending = 0;
  }

  async start({ onResult, onError }) {
    if (this.running) return true;
    const session = ++this.session;
    this.onResult = onResult;
    this.onError = onError;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      onError?.("This browser cannot open a microphone.");
      return false;
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch (error) {
      const name = error && error.name;
      const denied = name === "NotAllowedError" || name === "SecurityError";
      onError?.(
        denied
          ? "Microphone permission was blocked. Allow it for this page and press start again."
          : "No microphone was found on this device.",
      );
      return false;
    }

    // stop() during the permission prompt: drop the stream that just arrived.
    if (session !== this.session) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
      return false;
    }

    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) {
      onError?.("This browser has no Web Audio support.");
      this.stop();
      return false;
    }

    this.ctx = new Ctor();
    if (this.ctx.state === "suspended") await this.ctx.resume();
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0;
    source.connect(this.analyser);
    this.buffer = new Float32Array(this.analyser.fftSize);

    this.running = true;
    this.lastRead = 0;
    this.history = [];
    this.stable = null;
    this.pending = 0;
    this.currentString = null;
    this.lastEmit = 0;
    const loop = () => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      const now = performance.now();
      if (now - this.lastRead < 70) return; // ~14 readings per second
      this.lastRead = now;
      this.analyser.getFloatTimeDomainData(this.buffer);
      const result = detectPitch(this.buffer, this.ctx.sampleRate);
      if (result) this.pushReading(result);
      else this.markSilence();
    };
    this.raf = requestAnimationFrame(loop);
    return true;
  }

  // Median of the last few readings, and two agreeing readings before the
  // note may change: stops the display jumping between neighbours/octaves.
  pushReading({ frequency, clarity }) {
    const note = noteFromFrequency(frequency);
    const midi = note.midi + note.cents / 100;
    const confidence = Math.max(0, Math.min(1, 1 - (clarity ?? 0.15)));
    const now = performance.now();
    if (now - (this.lastReadingAt || 0) > 300) this.history = [];
    this.lastReadingAt = now;
    this.history.push(midi);
    if (this.history.length > 5) this.history.shift();
    if (this.history.length < 3) return;

    const sorted = [...this.history].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (sorted[sorted.length - 1] - sorted[0] > 1.5) return;

    if (this.stable === null || this.stable === undefined || Math.abs(median - this.stable) > 0.9) {
      this.pending = (this.pending || 0) + 1;
      if (this.pending < 2) return;
      this.pending = 0;
    }
    this.stable = median;

    if (now - (this.lastEmit || 0) < 90) return;
    this.lastEmit = now;
    const smoothed = 440 * 2 ** ((median - 69) / 12);
    const reading = noteFromFrequency(smoothed);
    reading.clarity = clarity ?? 0.15;

    if (this.strings.length && this.mode !== "chromatic") {
      const nearest = nearestString(median, this.strings);
      let target = nearest;

      if (this.mode === "string" && this.stringIndex >= 0 && this.stringIndex < this.strings.length) {
        const [name, hz] = this.strings[this.stringIndex];
        target = { index: this.stringIndex, name, midi: midiForFrequency(hz) };
      } else if (this.currentString !== null) {
        // Hysteresis: a string that is already ringing wins while the pitch is
        // still within a semitone of it. That stops the display hopping
        // between neighbours during vibrato.
        const [name, hz] = this.strings[this.currentString] || [];
        if (hz && Math.abs(median - midiForFrequency(hz)) <= 0.7) {
          target = { index: this.currentString, name, midi: midiForFrequency(hz) };
        }
      }

      if (this.mode === "auto") this.currentString = target.index;
      const cents = Math.round((median - target.midi) * 100);
      reading.stringIndex = target.index;
      reading.stringName = target.name;
      reading.stringMidi = target.midi;
      reading.stringCents = cents;
      reading.inTuneRatio = Math.max(0, Math.min(1, confidence * Math.max(0, 1 - Math.abs(cents) / 50)));
      // Pinned to one string but the pitch clearly belongs to another one.
      reading.wrongString =
        this.mode === "string" && Math.abs(cents) > 120 && Math.abs(nearest.cents) <= 40 ? nearest.name : "";
      reading.suggestedIndex = nearest.index;
    }

    this.onResult?.(reading);
  }

  markSilence() {
    if (performance.now() - (this.lastReadingAt || 0) > 250) {
      this.history = [];
      this.stable = null;
      this.pending = 0;
      this.currentString = null;
    }
  }

  stop() {
    this.session += 1;
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
    if (this.stream) this.stream.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.ctx) this.ctx.close().catch(() => {});
    this.ctx = null;
    this.analyser = null;
    this.buffer = null;
  }

  async reference(frequency, seconds = 1.4) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return false;
    if (!this.refCtx) this.refCtx = new Ctor();
    const ctx = this.refCtx;
    if (ctx.state === "suspended") await ctx.resume();

    const at = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.22, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + seconds + 0.05);
    return true;
  }
}
