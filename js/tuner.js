// Chromatic tuner: microphone pitch detection and reference tones.
// Everything runs in the page; no audio is recorded or uploaded.

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export const TUNINGS = {
  guitar: {
    label: "Guitar · standard",
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
    strings: [
      ["Eb2", 77.78],
      ["Ab2", 103.83],
      ["Db3", 138.59],
      ["Gb3", 185.0],
      ["Bb3", 233.08],
      ["Eb4", 311.13],
    ],
  },
  bass: {
    label: "Bass · 4 string",
    strings: [
      ["E1", 41.2],
      ["A1", 55.0],
      ["D2", 73.42],
      ["G2", 98.0],
    ],
  },
  ukulele: {
    label: "Ukulele · standard",
    strings: [
      ["G4", 392.0],
      ["C4", 261.63],
      ["E4", 329.63],
      ["A4", 440.0],
    ],
  },
};

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
function detectPitch(buffer, sampleRate) {
  const size = buffer.length;
  let energy = 0;
  for (let i = 0; i < size; i++) energy += buffer[i] * buffer[i];
  if (Math.sqrt(energy / size) < 0.008) return null;

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
  const period = candidate + Math.max(-0.5, Math.min(0.5, shift));
  const frequency = sampleRate / period;
  return Number.isFinite(frequency) && frequency > 30 ? frequency : null;
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
    const loop = () => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      const now = performance.now();
      if (now - this.lastRead < 70) return; // ~14 readings per second
      this.lastRead = now;
      this.analyser.getFloatTimeDomainData(this.buffer);
      const frequency = detectPitch(this.buffer, this.ctx.sampleRate);
      if (frequency) this.onResult?.(noteFromFrequency(frequency));
    };
    this.raf = requestAnimationFrame(loop);
    return true;
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
