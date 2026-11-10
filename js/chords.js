// Chord math: parsing, transposition, simplification, shapes and SVG diagrams.

const SHARP_NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT_NAMES = { "C#": "Db", "D#": "Eb", "F#": "Gb", "G#": "Ab", "A#": "Bb" };

const TONES = {
  "": [0, 4, 7],
  m: [0, 3, 7],
  5: [0, 7],
  7: [0, 4, 7, 10],
  m7: [0, 3, 7, 10],
  maj7: [0, 4, 7, 11],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  add9: [0, 4, 7, 14],
  m6: [0, 3, 7, 9],
  6: [0, 4, 7, 9],
  "9": [0, 4, 7, 10, 14],
  m9: [0, 3, 7, 10, 14],
};

// Matches things like C, Am, F#m7, Bb/D, C#4/E is not a chord (octave), Gsus4, Emaj7
const CHORD_TOKEN = /^[A-G](?:#|b)?(?:maj|min|sus|add|dim|aug|m|M|\+|-|°|ø)?\d{0,2}(?:[#b]\d)?(?:\/[A-G](?:#|b)?)?$/;
const CHORD_LINE = /^[\s|:()./\-]*[A-G](?:#|b)?[^\s]*/;

export function isChordToken(token) {
  if (!token || token.length > 8) return false;
  if (!CHORD_TOKEN.test(token)) return false;
  // Reject bare single letters that are far more often lyrics than chords in prose,
  // but keep them when they appear in a chord-only line (handled by caller).
  return true;
}

function noteIndex(name) {
  return SHARP_NOTES.indexOf(name);
}

export function parseChord(input) {
  const m = /^([A-G](?:#|b)?)(.*)$/.exec(input);
  if (!m) return null;
  const [, root, rest] = m;
  const slash = rest.split("/");
  const quality = slash[0];
  const bass = slash[1] || null;
  return { root, quality, bass, raw: input };
}

function prefer(note, useFlats) {
  if (!useFlats) return note;
  return FLAT_NAMES[note] || note;
}

export function transposeChord(input, semitones, useFlats = false) {
  const parsed = parseChord(input);
  if (!parsed) return input;
  const shift = (note) => {
    const i = noteIndex(note);
    if (i < 0) return note;
    return prefer(SHARP_NOTES[(i + semitones + 120) % 12], useFlats);
  };
  let out = shift(parsed.root) + parsed.quality;
  if (parsed.bass) out += "/" + shift(parsed.bass);
  return out;
}

// "Simplify" strips extensions and slash basses, leaving the plain triad.
export function simplifyChord(input) {
  const parsed = parseChord(input);
  if (!parsed) return input;
  let quality = parsed.quality;
  if (/^(maj7|maj|M)/.test(quality)) quality = "";
  else if (/^m(in)?/.test(quality)) quality = "m";
  else if (/^(7|9|6|add9)/.test(quality)) quality = "";
  else if (/^m(in)?(7|9|6)/.test(quality)) quality = "m";
  else if (/^sus/.test(quality)) quality = "";
  else if (/^(dim|°|ø)/.test(quality)) quality = "m";
  else if (/^(aug|\+)/.test(quality)) quality = "";
  else if (quality === "5") quality = "";
  else quality = "";
  return parsed.root + quality;
}

export function chordToneIndexes(input) {
  const parsed = parseChord(input);
  if (!parsed) return [0];
  const root = noteIndex(parsed.root);
  const simple = simplifyChord(input);
  const quality = simple.slice(simple.indexOf(parsed.root) + parsed.root.length);
  const intervals = TONES[quality] ?? TONES[""];
  return intervals.map((i) => (root + i) % 12);
}

export function chordRootIndex(input) {
  const parsed = parseChord(input);
  return parsed ? noteIndex(parsed.root) : 0;
}

export function bassIndex(input) {
  const parsed = parseChord(input);
  if (parsed?.bass) return noteIndex(parsed.bass);
  return parsed ? noteIndex(parsed.root) : 0;
}

// --- Shapes -------------------------------------------------------------

// string order: low E, A, D, G, B, high e. -1 = muted, 0 = open.
const CURATED = {
  C: [-1, 3, 2, 0, 1, 0],
  Cm: [-1, 3, 5, 5, 4, 3],
  C7: [-1, 3, 2, 3, 1, 0],
  D: [-1, -1, 0, 2, 3, 2],
  Dm: [-1, -1, 0, 2, 3, 1],
  D7: [-1, -1, 0, 2, 1, 2],
  E: [0, 2, 2, 1, 0, 0],
  Em: [0, 2, 2, 0, 0, 0],
  E7: [0, 2, 0, 1, 0, 0],
  F: [1, 3, 3, 2, 1, 1],
  Fm: [1, 3, 3, 1, 1, 1],
  G: [3, 2, 0, 0, 3, 3],
  G7: [3, 2, 0, 0, 0, 1],
  A: [-1, 0, 2, 2, 2, 0],
  Am: [-1, 0, 2, 2, 1, 0],
  A7: [-1, 0, 2, 0, 2, 0],
  B: [-1, 2, 4, 4, 4, 2],
  Bm: [-1, 2, 4, 4, 3, 2],
  B7: [-1, 2, 1, 2, 0, 2],
  "F#m": [2, 4, 4, 2, 2, 2],
  "C#m": [-1, 4, 6, 6, 5, 4],
  "G#m": [4, 6, 6, 4, 4, 4],
  "D#": [-1, 6, 5, 3, 4, 3],
  "Bb": [-1, 1, 3, 3, 3, 1],
  "Eb": [-1, 6, 5, 3, 4, 3],
  "Ab": [4, 6, 6, 5, 4, 4],
  "Db": [-1, 4, 6, 6, 6, 4],
  Cadd9: [-1, 3, 2, 0, 3, 0],
  Em7: [0, 2, 2, 0, 3, 0],
  Am7: [-1, 0, 2, 0, 1, 0],
  Dm7: [-1, -1, 0, 2, 1, 1],
  Fmaj7: [-1, -1, 3, 2, 1, 0],
  Cmaj7: [-1, 3, 2, 0, 0, 0],
  Gmaj7: [3, 2, 0, 0, 0, 2],
  Amaj7: [-1, 0, 2, 1, 2, 0],
  Asus4: [-1, 0, 2, 2, 3, 0],
  Dsus4: [-1, -1, 0, 2, 3, 3],
  Esus4: [0, 2, 2, 2, 0, 0],
  Gsus4: [3, 3, 0, 0, 1, 3],
};

const OPEN_STRING_NOTES = [4, 9, 2, 7, 11, 4]; // E A D G B e

function scoreShape(frets, baseFret, chord) {
  const tones = chordToneIndexes(chord);
  const bass = bassIndex(chord);
  const root = chordRootIndex(chord);
  const slashBass = chord.includes("/") ? bass : null;
  let sounding = 0;
  let muted = 0;
  let span = 0;
  let lowest = null;
  let hasThird = false;
  let hasRoot = false;

  for (let s = 0; s < 6; s++) {
    const f = frets[s];
    if (f === -1) {
      muted++;
      continue;
    }
    sounding++;
    const abs = baseFret === 0 ? f : baseFret + f;
    span = Math.max(span, abs);
    const note = (OPEN_STRING_NOTES[s] + abs) % 12;
    // A slash bass may sit outside the chord's own tones (e.g. C/B), but every
    // other sounding string must belong to the chord.
    const allowed = tones.includes(note) || (slashBass !== null && note === slashBass);
    if (!allowed) return null;
    if (lowest === null) lowest = note;
    if (note === root) hasRoot = true;
    if (tones.length > 1 && note === (tones[1] ?? -1)) hasThird = true;
  }
  if (sounding < 4) return null;
  if (lowest !== bass) return null;
  if (tones.length > 2 && !hasThird) return null;
  if (!hasRoot) return null;
  const base = baseFret === 0 ? 0 : baseFret;
  const width = base === 0 ? span : span - baseFret;
  if (width > 4) return null;

  let score = 100;
  score -= muted * 3;
  score -= width * 2;
  score += sounding * 2;
  if (base === 0) score += 12;
  const maxFret = Math.max(...frets);
  if (base === 0 && maxFret <= 3) score += 10;
  // Prefer barre-friendly shapes high on the neck over cramped ones.
  return { frets: [...frets], baseFret: base, score };
}

function generateShape(chord) {
  let best = null;
  for (let base = 0; base <= 9; base++) {
    const pool = base === 0 ? [-1, 0, 1, 2, 3, 4] : [-1, 0, 1, 2, 3, 4];
    const total = Math.pow(pool.length, 6);
    for (let n = 0; n < total; n++) {
      let k = n;
      const frets = new Array(6);
      for (let s = 0; s < 6; s++) {
        frets[s] = pool[k % pool.length];
        k = Math.floor(k / pool.length);
      }
      const result = scoreShape(frets, base, chord);
      if (result && (!best || result.score > best.score)) best = result;
    }
  }
  return best;
}

const shapeCache = new Map();

export function shapeFor(chord) {
  const key = chord;
  if (shapeCache.has(key)) return shapeCache.get(key);
  let shape = null;
  const plain = simplifyChord(chord);
  const hasSlashBass = chord.includes("/");
  if (!hasSlashBass && CURATED[chord]) {
    shape = { frets: CURATED[chord], baseFret: 0 };
    if (Math.max(...shape.frets) > 4) shape.baseFret = 1;
  } else if (!hasSlashBass && CURATED[plain]) {
    shape = { frets: CURATED[plain], baseFret: 0 };
    if (Math.max(...shape.frets) > 4) shape.baseFret = 1;
  } else {
    // Slash chords go through the generator so the bass note is enforced.
    const generated = generateShape(chord) || generateShape(plain);
    if (generated) shape = { frets: generated.frets, baseFret: generated.baseFret };
    else if (CURATED[plain]) shape = { frets: CURATED[plain], baseFret: 0 };
  }
  shapeCache.set(key, shape);
  return shape;
}

export function diagramSVG(chord, size = 76) {
  const shape = shapeFor(chord);
  const padX = 10;
  const padTop = 16;
  const stringGap = (size - padX * 2) / 5;
  const fretGap = (size - padTop - 8) / 4;
  const w = size;
  const h = size + 12;
  const parts = [];

  parts.push(`<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${chord} chord diagram">`);

  if (!shape) {
    parts.push(
      `<text x="${w / 2}" y="${h / 2}" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.5">no shape</text>`,
    );
    parts.push("</svg>");
    return parts.join("");
  }

  const { frets, baseFret } = shape;
  const top = padTop;
  const bottom = padTop + fretGap * 4;
  const left = padX;
  const right = w - padX;

  // nut / fretboard
  for (let i = 0; i <= 4; i++) {
    const y = top + fretGap * i;
    const isNut = i === 0 && baseFret === 0;
    parts.push(
      `<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="currentColor" stroke-width="${isNut ? 3 : 1}" opacity="${isNut ? 0.9 : 0.35}"/>`,
    );
  }
  for (let s = 0; s < 6; s++) {
    const x = left + stringGap * s;
    parts.push(
      `<line x1="${x}" y1="${top}" x2="${x}" y2="${bottom}" stroke="currentColor" stroke-width="1" opacity="0.35"/>`,
    );
  }

  if (baseFret > 0) {
    parts.push(
      `<text x="${left - 2}" y="${top + fretGap * 0.8}" font-size="8" fill="currentColor" opacity="0.7">${baseFret}fr</text>`,
    );
  }

  for (let s = 0; s < 6; s++) {
    const f = frets[s];
    const x = left + stringGap * s;
    if (f === -1) {
      parts.push(
        `<text x="${x}" y="${top - 5}" font-size="8" text-anchor="middle" fill="currentColor" opacity="0.55">x</text>`,
      );
      continue;
    }
    if (f === 0) {
      parts.push(
        `<circle cx="${x}" cy="${top - 8}" r="2.4" fill="none" stroke="currentColor" stroke-width="1" opacity="0.7"/>`,
      );
      continue;
    }
    const relFret = baseFret === 0 ? f : f;
    const y = top + fretGap * (relFret - 0.5);
    parts.push(`<circle cx="${x}" cy="${y}" r="3.6" fill="currentColor" opacity="0.9"/>`);
  }

  parts.push("</svg>");
  return parts.join("");
}

// A line made only of chords and bar markers, e.g. "G   G7  |  C  D7"
export function isChordLine(line) {
  const tokens = line
    .trim()
    .split(/\s+/)
    .filter((t) => t && !/^[|:()./\-\u2013\u2014]+$/.test(t));
  if (!tokens.length) return false;
  return tokens.every((t) => isChordToken(t));
}

function lineTokens(line) {
  return line
    .split(/\s+/)
    .map((raw) => raw.replace(/[|:,()\[\]]/g, "").trim())
    .filter(Boolean);
}

// Chord tokens for every line of a sheet. A token counts as a chord when the
// whole line is chords, or when it sits in a mixed chord-over-lyric line and
// (a) is longer than one character — a lone "A" is nearly always the word —
// and (b) has already been proven a chord by some chord-only line. Rule (b)
// keeps prose like "the F# on the D string" out of the chord panel.
export function chordTokensByLine(body) {
  const lines = body.split("\n");
  const chordOnly = lines.map(isChordLine);
  const known = new Set();
  lines.forEach((line, i) => {
    if (!chordOnly[i]) return;
    for (const token of lineTokens(line)) if (isChordToken(token)) known.add(token);
  });
  return lines.map((line, i) => {
    const out = [];
    for (const token of lineTokens(line)) {
      if (!isChordToken(token)) continue;
      if (!chordOnly[i]) {
        if (token.length < 2) continue;
        if (known.size && !known.has(token)) continue;
      }
      out.push(token);
    }
    return out;
  });
}

export function extractChords(body) {
  const found = new Map();
  for (const tokens of chordTokensByLine(body)) {
    for (const token of tokens) found.set(token, (found.get(token) || 0) + 1);
  }
  return found;
}

export function uniqueChords(text) {
  return [...extractChords(text).entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
}
