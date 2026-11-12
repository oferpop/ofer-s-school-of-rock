// Sheet-music reader: imports MusicXML or MIDI, draws a score and turns it
// into the same timed events the tab player already understands.
// Everything runs in the page; files are never uploaded.

const STEPS = ["C", "D", "E", "F", "G", "A", "B"];
const SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const TYPE_QUARTERS = {
  whole: 4,
  half: 2,
  quarter: 1,
  eighth: 0.5,
  "16th": 0.25,
  "32nd": 0.125,
  "64th": 0.0625,
  breve: 8,
  "long": 16,
};
const QUARTERS_TYPE = [
  [4, "whole", 0],
  [2, "half", 0],
  [1, "quarter", 0],
  [0.5, "eighth", 0],
  [0.25, "16th", 0],
  [0.125, "32nd", 0],
  [0.0625, "64th", 0],
];
// Diatonic positions on the treble staff, C0 = 0 (C4 = 28).
const LETTER_POS = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
const SHARP_ORDER = ["F", "C", "G", "D", "A", "E", "B"];
const FLAT_ORDER = ["B", "E", "A", "D", "G", "C", "F"];
const SHARP_POS = [38, 35, 39, 36, 33, 37, 34];
const FLAT_POS = [34, 37, 33, 36, 32, 35, 31];
const BASS_SHARP_POS = SHARP_POS.map((p) => p - 14);
const BASS_FLAT_POS = FLAT_POS.map((p) => p - 14);

const esc = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const textOf = (node) => (node && node.textContent ? node.textContent.trim() : "");
const child = (node, name) => Array.from(node?.children || []).find((entry) => entry.tagName === name) || null;
const children = (node, name) => Array.from(node?.children || []).filter((entry) => entry.tagName === name);

function diatonicFor(step, octave) {
  return LETTER_POS[step] + 7 * octave;
}

function positionOfMidi(midi) {
  // MIDI 60 is C4 (diatonic 28). Sharps/flats choose the nearest natural letter.
  const pc = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  const letter = ["C", "C", "D", "D", "E", "F", "F", "G", "G", "A", "A", "B"][pc];
  const natural = SEMITONE[letter];
  const alter = pc - natural;
  return { position: diatonicFor(letter, octave), alter, letter, octave };
}

function noteNameForMidi(midi) {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  return names[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

function keyAlterations(fifths) {
  const map = new Map();
  if (fifths > 0) for (let i = 0; i < Math.min(7, fifths); i++) map.set(SHARP_ORDER[i], 1);
  if (fifths < 0) for (let i = 0; i < Math.min(7, -fifths); i++) map.set(FLAT_ORDER[i], -1);
  return map;
}

function keyName(fifths) {
  const major = ["Cb", "Gb", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#"];
  return major[Math.max(0, Math.min(14, fifths + 7))] || "C";
}

function displayType(duration, type, dots) {
  if (type && TYPE_QUARTERS[type]) return { type, dots: dots || 0 };
  for (const [quarters, name, extraDots] of QUARTERS_TYPE) {
    if (Math.abs(duration - quarters) < 0.01) return { type: name, dots: extraDots };
  }
  // Dotted values (1.5, 3, .75 ...) map to the base type plus one dot.
  const dotted = QUARTERS_TYPE.find(([quarters]) => Math.abs(duration - quarters * 1.5) < 0.01);
  if (dotted) return { type: dotted[1], dots: 1 };
  const nearest = QUARTERS_TYPE.reduce((best, entry) =>
    Math.abs(entry[0] - duration) < Math.abs(best[0] - duration) ? entry : best,
  );
  return { type: nearest[1], dots: 0 };
}

function emptyNotation() {
  return {
    title: "",
    composer: "",
    bpm: 120,
    staves: 1,
    clef: "treble",
    timeSignature: { beats: 4, beatType: 4 },
    keyFifths: 0,
    measures: [],
    notes: [],
    duration: 0,
    source: "",
    warnings: [],
  };
}

// --- MusicXML -----------------------------------------------------------

function parsePitch(node) {
  const step = textOf(child(node, "step")).toUpperCase();
  const octave = Number(textOf(child(node, "octave")) || 4);
  const alter = Number(textOf(child(node, "alter")) || 0);
  if (!(step in SEMITONE) || !Number.isFinite(octave)) return null;
  return {
    midi: 12 * (octave + 1) + SEMITONE[step] + alter,
    step,
    octave,
    alter,
  };
}

function tieTypes(note) {
  const types = new Set();
  for (const tie of Array.from(note.getElementsByTagName("tie"))) {
    const type = tie.getAttribute("type");
    if (type) types.add(type);
  }
  for (const tie of Array.from(note.getElementsByTagName("tied"))) {
    const type = tie.getAttribute("type");
    if (type) types.add(type);
  }
  return types;
}

export function parseMusicXml(xmlText, fallbackTitle = "") {
  const parser = new DOMParser();
  const doc = parser.parseFromString(String(xmlText || ""), "text/xml");
  if (!doc || doc.getElementsByTagName("parsererror").length) {
    throw new Error("That file is not valid MusicXML.");
  }
  const root = doc.documentElement;
  if (!root || root.tagName !== "score-partwise") {
    throw new Error("Only part-wise MusicXML (.musicxml / .xml) is supported.");
  }

  const notation = emptyNotation();
  notation.source = "musicxml";
  notation.title =
    textOf(root.getElementsByTagName("work-title")[0]) ||
    textOf(root.getElementsByTagName("movement-title")[0]) ||
    fallbackTitle;
  const creator = Array.from(root.getElementsByTagName("creator")).find(
    (entry) => entry.getAttribute("type") === "composer",
  );
  notation.composer = textOf(creator);

  const parts = Array.from(root.children).filter((entry) => entry.tagName === "part");
  if (!parts.length) throw new Error("That score has no parts.");
  const part = parts[0];
  const partName = textOf(
    Array.from(root.getElementsByTagName("part-name")).find((entry, index) => index === 0),
  );
  if (partName && !notation.title) notation.title = partName;
  notation.part = partName;

  let divisions = 1;
  let beats = 4;
  let beatType = 4;
  let fifths = 0;
  let staves = 1;
  let clefSign = "G";
  let measureStart = 0;
  let tempo = 0;
  const pendingTies = new Map();
  const notes = [];
  const measures = [];

  const measureNodes = Array.from(part.children).filter((entry) => entry.tagName === "measure");
  measureNodes.forEach((measureNode, measureIndex) => {
    let cursor = 0;
    let previousOnset = 0;
    let measureUsed = 0;

    const applyAttributes = (attributes) => {
      const divisionsNode = child(attributes, "divisions");
      if (divisionsNode) divisions = Math.max(1, Number(textOf(divisionsNode)) || 1);
      const time = child(attributes, "time");
      if (time) {
        const nextBeats = Number(textOf(child(time, "beats")));
        const nextType = Number(textOf(child(time, "beat-type")));
        if (nextBeats > 0 && nextType > 0) {
          beats = nextBeats;
          beatType = nextType;
        }
      }
      const key = child(attributes, "key");
      if (key) {
        const nextFifths = Number(textOf(child(key, "fifths")));
        if (Number.isFinite(nextFifths)) fifths = nextFifths;
      }
      const stavesNode = child(attributes, "staves");
      if (stavesNode) staves = Math.max(1, Number(textOf(stavesNode)) || 1);
      const clef = child(attributes, "clef");
      if (clef && (!clef.getAttribute("number") || clef.getAttribute("number") === "1")) {
        const sign = textOf(child(clef, "sign"));
        if (sign) clefSign = sign.toUpperCase();
      }
    };

    for (const node of Array.from(measureNode.children)) {
      if (node.tagName === "attributes") {
        applyAttributes(node);
        continue;
      }
      if (node.tagName === "backup") {
        cursor = Math.max(0, cursor - Number(textOf(child(node, "duration")) || 0) / divisions);
        continue;
      }
      if (node.tagName === "forward") {
        cursor += Number(textOf(child(node, "duration")) || 0) / divisions;
        continue;
      }
      if (node.tagName === "direction") {
        const sound = child(node, "sound");
        const metronome = child(node, "metronome");
        if (sound && sound.getAttribute("tempo")) tempo = Number(sound.getAttribute("tempo")) || tempo;
        if (metronome) {
          const perMinute = Number(textOf(child(metronome, "per-minute")));
          if (perMinute > 0) tempo = perMinute;
        }
        continue;
      }
      if (node.tagName !== "note") continue;

      const duration = Number(textOf(child(node, "duration")) || 0) / divisions;
      const isChord = Boolean(child(node, "chord"));
      const isGrace = Boolean(child(node, "grace"));
      const rest = Boolean(child(node, "rest"));
      const voice = textOf(child(node, "voice")) || "1";
      const staff = Number(textOf(child(node, "staff")) || 1);
      const onset = measureStart + (isChord ? previousOnset : cursor);
      const ties = tieTypes(node);
      const pitchNode = child(node, "pitch");
      const pitch = pitchNode ? parsePitch(pitchNode) : null;
      const typeInfo = displayType(duration, textOf(child(node, "type")), children(node, "dot").length);

      if (!isChord) {
        previousOnset = cursor;
        if (!isGrace) cursor += Math.max(0, duration);
      }
      measureUsed = Math.max(measureUsed, cursor, previousOnset + duration);

      if (rest) {
        notes.push({
          start: onset,
          duration,
          midi: [],
          rest: true,
          staff,
          voice,
          measure: measureIndex,
          type: typeInfo.type,
          dots: typeInfo.dots,
        });
        continue;
      }
      if (!pitch) continue;

      const tieKey = `${staff}:${voice}:${pitch.midi}`;
      if (ties.has("stop") && pendingTies.has(tieKey)) {
        const target = pendingTies.get(tieKey);
        target.duration += duration;
        if (!ties.has("start")) pendingTies.delete(tieKey);
        continue;
      }
      if (isGrace) continue;

      const entry = {
        start: onset,
        duration,
        midi: [pitch.midi],
        rest: false,
        staff,
        voice,
        measure: measureIndex,
        type: typeInfo.type,
        dots: typeInfo.dots,
        step: pitch.step,
        octave: pitch.octave,
        alter: pitch.alter,
      };
      notes.push(entry);
      if (ties.has("start")) pendingTies.set(tieKey, entry);
    }

    const nominal = (beats * 4) / beatType;
    const actual = measureUsed > nominal + 0.001 ? measureUsed : nominal;
    measures.push({
      index: measureIndex,
      start: measureStart,
      duration: actual,
      beats,
      beatType,
      fifths,
    });
    measureStart += actual;
  });

  notation.divisions = divisions;
  notation.timeSignature = { beats, beatType };
  notation.keyFifths = fifths;
  notation.staves = Math.max(staves, ...notes.map((note) => note.staff || 1));
  notation.clef = notation.staves === 1 && clefSign === "F" ? "bass" : "treble";
  notation.measures = measures;
  notation.notes = notes;
  notation.duration = measureStart;
  notation.bpm = tempo > 0 ? Math.round(tempo) : 120;
  notation.key = keyName(fifths);
  if (!notes.some((note) => !note.rest)) throw new Error("That score contains no notes.");
  return notation;
}

// --- compressed MusicXML (.mxl) ----------------------------------------

function readZipEntries(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("That .mxl file is not a valid ZIP archive.");
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries = new Map();
  for (let index = 0; index < count; index++) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    entries.set(name, { method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return { bytes, view, entries };
}

async function zipEntryBuffer(zip, name) {
  const entry = zip.entries.get(name);
  if (!entry) throw new Error(`The .mxl archive is missing ${name}.`);
  const { bytes, view } = zip;
  if (view.getUint32(entry.localOffset, true) !== 0x04034b50) throw new Error("That .mxl archive is damaged.");
  const nameLength = view.getUint16(entry.localOffset + 26, true);
  const extraLength = view.getUint16(entry.localOffset + 28, true);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const data = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method !== 8) throw new Error("That .mxl file uses an unsupported compression method.");
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser cannot open compressed .mxl files. Export uncompressed MusicXML instead.");
  }
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function parseMxl(arrayBuffer, fallbackTitle = "") {
  const zip = readZipEntries(arrayBuffer);
  let scorePath = null;
  if (zip.entries.has("META-INF/container.xml")) {
    const container = new TextDecoder().decode(await zipEntryBuffer(zip, "META-INF/container.xml"));
    const match = container.match(/full-path="([^"]+)"/i);
    if (match) scorePath = match[1];
  }
  if (!scorePath) {
    scorePath =
      [...zip.entries.keys()].find(
        (name) => !name.startsWith("META-INF/") && /\.(xml|musicxml)$/i.test(name),
      ) || null;
  }
  if (!scorePath) throw new Error("That .mxl archive does not contain a MusicXML score.");
  const text = new TextDecoder().decode(await zipEntryBuffer(zip, scorePath));
  return parseMusicXml(text, fallbackTitle);
}

// --- MIDI ---------------------------------------------------------------

function readVar(buffer, state) {
  let value = 0;
  for (let i = 0; i < 4; i++) {
    const byte = buffer[state.pos++];
    value = (value << 7) | (byte & 0x7f);
    if (!(byte & 0x80)) break;
  }
  return value;
}

export function parseMidi(arrayBuffer, fallbackTitle = "") {
  const buffer = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);
  if (buffer.length < 14 || String.fromCharCode(...buffer.slice(0, 4)) !== "MThd") {
    throw new Error("That file is not a MIDI file.");
  }
  const headerLength = view.getUint32(4);
  const format = view.getUint16(8);
  const trackCount = view.getUint16(10);
  const division = view.getInt16(12);
  if (division <= 0) throw new Error("SMPTE-timed MIDI is not supported.");

  let pos = 8 + headerLength;
  const notes = [];
  let bpm = 0;
  let beats = 4;
  let beatType = 4;
  let title = "";

  for (let track = 0; track < trackCount && pos + 8 <= buffer.length; track++) {
    if (String.fromCharCode(...buffer.slice(pos, pos + 4)) !== "MTrk") break;
    const length = view.getUint32(pos + 4);
    const end = Math.min(buffer.length, pos + 8 + length);
    const state = { pos: pos + 8 };
    let tick = 0;
    let running = 0;
    const active = new Map();

    while (state.pos < end) {
      tick += readVar(buffer, state);
      let status = buffer[state.pos++];
      if (status < 0x80) {
        state.pos -= 1;
        status = running;
      } else if (status < 0xf0) {
        running = status;
      }
      const type = status & 0xf0;
      const channel = status & 0x0f;

      if (status === 0xff) {
        const meta = buffer[state.pos++];
        const size = readVar(buffer, state);
        const data = buffer.slice(state.pos, state.pos + size);
        state.pos += size;
        if (meta === 0x51 && size === 3) {
          const micros = (data[0] << 16) | (data[1] << 8) | data[2];
          if (!bpm && micros > 0) bpm = Math.round(60000000 / micros);
        } else if (meta === 0x58 && size >= 2) {
          if (data[0] > 0 && data[1] > 0) {
            beats = data[0];
            beatType = 2 ** data[1];
          }
        } else if (meta === 0x03 && size) {
          const name = new TextDecoder().decode(data).trim();
          if (!title) title = name;
        }
        continue;
      }
      if (status === 0xf0 || status === 0xf7) {
        const size = readVar(buffer, state);
        state.pos += size;
        continue;
      }
      if (type === 0x90) {
        const note = buffer[state.pos++];
        const velocity = buffer[state.pos++];
        if (velocity > 0) active.set(`${channel}:${note}`, tick);
        else {
          const start = active.get(`${channel}:${note}`);
          if (start !== undefined) {
            active.delete(`${channel}:${note}`);
            notes.push({ startTick: start, endTick: tick, midi: note, channel });
          }
        }
      } else if (type === 0x80) {
        const note = buffer[state.pos++];
        state.pos++;
        const start = active.get(`${channel}:${note}`);
        if (start !== undefined) {
          active.delete(`${channel}:${note}`);
          notes.push({ startTick: start, endTick: tick, midi: note, channel });
        }
      } else if (type === 0xa0 || type === 0xb0 || type === 0xe0) {
        state.pos += 2;
      } else if (type === 0xc0 || type === 0xd0) {
        state.pos += 1;
      } else {
        break;
      }
    }
    pos = end;
  }

  const melodic = notes.filter((note) => note.channel !== 9 && note.endTick > note.startTick);
  if (!melodic.length) throw new Error("That MIDI file has no melodic notes.");

  const notation = emptyNotation();
  notation.source = "midi";
  notation.title = title || fallbackTitle;
  notation.bpm = bpm || 120;
  notation.timeSignature = { beats, beatType };
  notation.key = "";
  notation.keyFifths = 0;

  const quarters = melodic.map((note) => ({
    start: note.startTick / division,
    duration: (note.endTick - note.startTick) / division,
    midi: [note.midi],
    staff: note.midi < 55 ? 2 : 1,
    voice: String(note.channel + 1),
    rest: false,
  }));
  const measureLength = (beats * 4) / beatType;
  quarters.forEach((note) => {
    note.measure = Math.max(0, Math.floor(note.start / measureLength));
    const typeInfo = displayType(note.duration, "", 0);
    note.type = typeInfo.type;
    note.dots = typeInfo.dots;
  });
  const last = Math.max(...quarters.map((note) => note.start + note.duration));
  const measureCount = Math.max(1, Math.ceil(last / measureLength));
  notation.measures = Array.from({ length: measureCount }, (_, index) => ({
    index,
    start: index * measureLength,
    duration: measureLength,
    beats,
    beatType,
    fifths: 0,
  }));
  notation.notes = quarters.sort((a, b) => a.start - b.start || a.midi[0] - b.midi[0]);
  const hasTreble = quarters.some((note) => note.staff === 1);
  const hasBass = quarters.some((note) => note.staff === 2);
  notation.staves = hasTreble && hasBass ? 2 : 1;
  notation.clef = !hasTreble && hasBass ? "bass" : "treble";
  notation.duration = measureCount * measureLength;
  notation.format = format;
  return notation;
}

// --- timed events for the player ----------------------------------------

export function notationToParsed(notation, { bpm = 120, transpose = 0 } = {}) {
  const beat = 60 / bpm;
  const step = beat / 4;
  // Notes that share an onset become one event (a chord).
  const groups = new Map();
  for (const note of notation.notes) {
    if (note.rest || !note.midi.length) continue;
    const key = note.start.toFixed(4);
    if (!groups.has(key)) groups.set(key, { start: note.start, midi: [], staff: note.staff || 1 });
    const group = groups.get(key);
    for (const midi of note.midi) group.midi.push(midi + transpose);
    group.staff = Math.min(group.staff, note.staff || 1);
  }
  const ordered = [...groups.entries()]
    .map(([key, group]) => ({ start: Number(key), group }))
    .sort((a, b) => a.start - b.start);
  // Written length per onset, so a tied note keeps its full value.
  const written = new Map();
  for (const note of notation.notes) {
    if (note.rest || !note.midi.length) continue;
    const key = note.start.toFixed(4);
    written.set(key, Math.max(written.get(key) || 0, note.duration || 0));
  }
  const events = ordered.map(({ start, group }, index) => {
    const next = ordered[index + 1]?.start ?? notation.duration;
    const quarters = Math.max(written.get(start.toFixed(4)) || 1, next - start);
    return {
      time: start * beat,
      midi: [...new Set(group.midi)].sort((a, b) => a - b),
      duration: Math.max(0.1, quarters * beat * 0.95),
      lines: [start, start],
      scoreIndex: index,
      kind: "score",
    };
  });
  const last = events[events.length - 1];
  const duration = last ? last.time + last.duration : notation.duration * beat;
  return { events, duration: Math.max(duration, notation.duration * beat), kind: "score", step };
}

// --- score drawing ------------------------------------------------------

function yFor(position, staff, geometry) {
  const bass = staff === 2 || (geometry.clef === "bass" && staff === 1);
  const bottom = bass ? geometry.bassBottom : geometry.trebleBottom;
  const bottomPosition = bass ? 18 : 30;
  return bottom - (position - bottomPosition) * 4;
}

function accidentalFor(note, keyMap) {
  if (note.alter === undefined) {
    const pc = ((note.midi[0] % 12) + 12) % 12;
    const sharp = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0][pc];
    return sharp ? "♯" : "";
  }
  if (note.alter > 0) return "♯";
  if (note.alter < 0) return "♭";
  if (keyMap.get(note.step) && note.alter === 0) return "♮";
  return "";
}

function restGlyph(x, y, type) {
  if (type === "whole" || type === "breve") {
    return `<rect class="score-rest" x="${x - 5}" y="${y + 2}" width="10" height="4" />`;
  }
  if (type === "half") {
    return `<rect class="score-rest" x="${x - 5}" y="${y - 6}" width="10" height="4" />`;
  }
  if (type === "quarter") {
    return `<path class="score-rest" d="M ${x - 1} ${y - 10} l 6 5 -5 4 4 5 -7 -4 5 -4 -4 -5 z" />`;
  }
  const flags = type === "eighth" ? 1 : type === "16th" ? 2 : type === "32nd" ? 3 : 1;
  let out = `<path class="score-rest" d="M ${x + 4} ${y - 10} l -7 16" />`;
  for (let i = 0; i < flags; i++) {
    out += `<circle class="score-rest" cx="${x - 3}" cy="${y - 8 + i * 4}" r="1.7" />`;
  }
  return out;
}

function stemAndFlags(x, y, type, up) {
  const length = 26;
  const stemX = up ? x + 4.6 : x - 4.6;
  const endY = up ? y - length : y + length;
  let out = `<line class="score-stem" x1="${stemX}" y1="${y}" x2="${stemX}" y2="${endY}" />`;
  const flags =
    type === "eighth" ? 1 : type === "16th" ? 2 : type === "32nd" ? 3 : type === "64th" ? 4 : 0;
  for (let i = 0; i < flags; i++) {
    const flagY = endY + (up ? i * 6 : -i * 6);
    out += `<path class="score-flag" d="M ${stemX} ${flagY} q 9 ${up ? 4 : -4} 6 ${up ? 12 : -12}" />`;
  }
  return out;
}

function staffLines(x1, x2, top) {
  let out = "";
  for (let i = 0; i < 5; i++) {
    const y = top + i * 8;
    out += `<line class="score-line" x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" />`;
  }
  return out;
}

function keySignature(x, top, staff, fifths) {
  let out = "";
  if (!fifths) return out;
  const count = Math.min(7, Math.abs(fifths));
  const positions = staff === 2 ? (fifths > 0 ? BASS_SHARP_POS : BASS_FLAT_POS) : fifths > 0 ? SHARP_POS : FLAT_POS;
  const glyph = fifths > 0 ? "♯" : "♭";
  for (let i = 0; i < count; i++) {
    const y = yFor(positions[i], staff, { trebleBottom: top + 32, bassBottom: top + 32 });
    out += `<text class="score-accidental" x="${x + i * 8}" y="${y + 3}">${glyph}</text>`;
  }
  return out;
}

function clefGlyph(x, top, staff) {
  if (staff === 2) {
    return `<text class="score-clef bass" x="${x}" y="${top + 29}">𝄢</text>`;
  }
  return `<text class="score-clef" x="${x}" y="${top + 38}">𝄞</text>`;
}

function timeSignature(x, top, beats, beatType) {
  return `<text class="score-time" x="${x}" y="${top + 12}">${beats}</text><text class="score-time" x="${x}" y="${top + 28}">${beatType}</text>`;
}

function renderMeasureNotes(measure, notes, geometry, width, bpm) {
  const startX = geometry.measureX;
  const usable = width - 26;
  let out = "";
  const sorted = [...notes].sort((a, b) => a.start - b.start || (a.voice || "1").localeCompare(b.voice || "1"));
  const groups = new Map();
  for (const note of sorted) {
    // Rests and notes in different voices/staves at the same onset must not
    // collapse into one symbol.
    const key = `${note.start.toFixed(4)}:${note.staff || 1}:${note.voice || "1"}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(note);
  }

  for (const [key, group] of [...groups.entries()].sort(
    (a, b) => Number(a[0].split(":")[0]) - Number(b[0].split(":")[0]),
  )) {
    const onset = Number(key.split(":")[0]);
    const staff = group[0].staff || 1;
    const offsetX = (onset - measure.start) / Math.max(0.001, measure.duration);
    const x = startX + 16 + offsetX * usable;
    const voiceNumber = Math.max(1, Number(group[0].voice) || 1);
    const voiceShift = voiceNumber > 1 ? Math.min(8, (voiceNumber - 1) * 5) : 0;
    const groupDuration = Math.max(...group.map((note) => note.duration || 0));

    if (group[0].rest) {
      const top = staff === 2 ? geometry.bassTop : geometry.trebleTop;
      const mid = top + 16;
      out += `<g class="score-note score-rest-group" data-start="${onset.toFixed(4)}" data-duration="${groupDuration.toFixed(
        4,
      )}" data-staff="${staff}">${restGlyph(x, mid, group[0].type)}</g>`;
      continue;
    }

    const pitches = group
      .filter((note) => note.midi && note.midi.length)
      .map((note) => {
        const midi = note.midi[0];
        const info = note.step
          ? {
              position: diatonicFor(note.step, note.octave),
              alter: note.alter || 0,
              step: note.step,
            }
          : positionOfMidi(midi);
        return { ...note, midiValue: midi, ...info, y: yFor(info.position, staff, geometry) };
      })
      .sort((a, b) => a.y - b.y);

    if (!pitches.length) continue;
    const up = pitches[pitches.length - 1].y > (staff === 2 ? geometry.bassTop + 16 : geometry.trebleTop + 16);
    const noteType = group[0].type || "quarter";
    const hollow = noteType === "whole" || noteType === "half" || noteType === "breve";
    const drawX = x + voiceShift;
    const keyMap = keyAlterations(geometry.fifths);
    let body = "";

    pitches.forEach((pitch, index) => {
      const accidental = accidentalFor(pitch, keyMap);
      if (accidental) {
        body += `<text class="score-accidental" x="${drawX - 12}" y="${pitch.y + 3}">${accidental}</text>`;
      }
      // Ledger lines for notes outside the five-line staff.
      const bassStaff = staff === 2 || (geometry.clef === "bass" && staff === 1);
      const bottomLine = bassStaff ? 18 : 30;
      const topLine = bottomLine + 8;
      if (pitch.position < bottomLine || pitch.position > topLine) {
        for (let p = bottomLine - 2; p >= pitch.position; p -= 2) {
          const y = yFor(p, staff, geometry);
          body += `<line class="score-ledger" x1="${drawX - 8}" y1="${y}" x2="${drawX + 8}" y2="${y}" />`;
        }
        for (let p = topLine + 2; p <= pitch.position; p += 2) {
          const y = yFor(p, staff, geometry);
          body += `<line class="score-ledger" x1="${drawX - 8}" y1="${y}" x2="${drawX + 8}" y2="${y}" />`;
        }
      }
      body += `<ellipse class="score-head ${hollow ? "is-hollow" : ""}" cx="${drawX}" cy="${pitch.y}" rx="5.2" ry="3.9" transform="rotate(-18 ${drawX} ${pitch.y})" />`;
      for (let dot = 0; dot < (group[0].dots || 0); dot++) {
        body += `<circle class="score-dot" cx="${drawX + 10 + dot * 4}" cy="${pitch.y - 2}" r="1.5" />`;
      }
      if (index === 0) {
        // One stem for the whole chord, from the outer note.
        body = stemAndFlags(drawX, up ? pitches[pitches.length - 1].y : pitches[0].y, noteType, up) + body;
      }
    });
    out += `<g class="score-note" data-start="${onset.toFixed(4)}" data-duration="${groupDuration.toFixed(
      4,
    )}" data-staff="${staff}" data-midi="${pitches.map((p) => p.midiValue).join(",")}">${body}</g>`;
  }
  return out;
}

export function renderScore(notation, { width = 900, bpm = notation.bpm || 120 } = {}) {
  const staves = notation.staves || (notation.notes.some((note) => note.staff === 2) ? 2 : 1);
  const measures = notation.measures.length ? notation.measures : [{ index: 0, start: 0, duration: 4, beats: 4, beatType: 4, fifths: notation.keyFifths || 0 }];
  // A short score fills the line; a longer one breaks at a musical width and
  // leaves the final system short instead of stretching it.
  const measuresPerSystem = Math.min(staves === 2 ? 3 : 4, Math.max(1, measures.length));
  const singleBass = staves === 1 && notation.clef === "bass";
  const systems = Math.ceil(measures.length / measuresPerSystem);
  const systemHeight = staves === 2 ? 210 : 120;
  const left = 54;
  const right = 18;
  const staffGap = 86;
  const usable = width - left - right;
  const measureWidth = usable / measuresPerSystem;
  const height = systems * systemHeight + 30;
  let svg = `<svg class="score-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(
    notation.title || "Sheet music",
  )}">`;

  for (let system = 0; system < systems; system++) {
    const top = system * systemHeight + 24;
    const from = system * measuresPerSystem;
    const to = Math.min(measures.length, from + measuresPerSystem);
    const systemMeasures = measures.slice(from, to);
    const systemWidth = measureWidth * (to - from);
    const trebleTop = top;
    const bassTop = staves === 2 ? top + staffGap : top;
    const geometryBase = {
      trebleTop,
      trebleBottom: trebleTop + 32,
      bassTop,
      bassBottom: bassTop + 32,
      clef: notation.clef || "treble",
      fifths: systemMeasures[0]?.fifths || 0,
    };

    svg += `<g class="score-system" data-system="${system}">`;
    svg += staffLines(left, left + systemWidth, trebleTop);
    if (staves === 2) {
      svg += staffLines(left, left + systemWidth, bassTop);
      svg += `<path class="score-brace" d="M ${left - 8} ${trebleTop} q -8 ${staffGap / 2} 0 ${staffGap} q 8 ${staffGap / 2} 0 ${staffGap}" />`;
    }
    const clefStaff = singleBass ? 2 : 1;
    svg += clefGlyph(left + 2, trebleTop, clefStaff);
    if (staves === 2) svg += clefGlyph(left + 2, bassTop, 2);
    const first = systemMeasures[0];
    const fifths = first?.fifths || 0;
    svg += keySignature(left + 24, trebleTop, clefStaff, fifths);
    if (staves === 2) svg += keySignature(left + 24, bassTop, 2, fifths);
    const timeX = left + 24 + Math.min(7, Math.abs(fifths)) * 8 + 10;
    if (system === 0) {
      svg += timeSignature(timeX, trebleTop, first?.beats || 4, first?.beatType || 4);
      if (staves === 2) svg += timeSignature(timeX, bassTop, first?.beats || 4, first?.beatType || 4);
    }

    systemMeasures.forEach((measure, index) => {
      const measureX = left + index * measureWidth;
      const measureNotes = notation.notes.filter((note) => note.measure === measure.index);
      const geometry = {
        ...geometryBase,
        measureX,
        fifths: measure.fifths ?? fifths,
      };
      svg += renderMeasureNotes(measure, measureNotes, geometry, measureWidth, bpm);

      // Bar lines, including one at the end of the system.
      if (index > 0) {
        svg += `<line class="score-bar" x1="${measureX}" y1="${trebleTop}" x2="${measureX}" y2="${
          staves === 2 ? bassTop + 32 : trebleTop + 32
        }" />`;
      }
      if (index === to - from - 1 || index === measuresPerSystem - 1) {
        const endX = left + (index + 1) * measureWidth;
        svg += `<line class="score-bar end" x1="${endX}" y1="${trebleTop}" x2="${endX}" y2="${
          staves === 2 ? bassTop + 32 : trebleTop + 32
        }" />`;
      }
    });
    svg += `</g>`;
  }

  svg += `</svg>`;
  return `<div class="score-sheet" data-score="1"><div class="score-heading"><strong>${esc(
    notation.title || "Untitled score",
  )}</strong>${
    notation.composer ? `<span>${esc(notation.composer)}</span>` : ""
  }<span class="dim">${esc(notation.key || "")}${
    notation.timeSignature ? ` · ${notation.timeSignature.beats}/${notation.timeSignature.beatType}` : ""
  }${notation.bpm ? ` · ${notation.bpm} BPM` : ""}</span></div>${svg}</div>`;
}

// Highlight and reveal the notes that are sounding at `seconds`.
export function paintScoreAt(sheet, seconds, bpm = 120) {
  if (!sheet) return;
  const secondsPerQuarter = 60 / Math.max(20, bpm);
  const groups = sheet.querySelectorAll(".score-note");
  let activeSystem = null;
  groups.forEach((group) => {
    const start = Number(group.dataset.start) * secondsPerQuarter;
    const duration = Number(group.dataset.duration) * secondsPerQuarter;
    const active = seconds + 0.001 >= start && seconds < start + Math.max(0.05, duration);
    group.classList.toggle("is-active", active);
    if (active) activeSystem = group.closest(".score-system");
  });
  if (activeSystem) {
    const rect = activeSystem.getBoundingClientRect();
    if (rect.top < 80 || rect.bottom > window.innerHeight - 80) {
      activeSystem.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }
}

export function scoreMeta(notation) {
  const notes = notation.notes.filter((note) => !note.rest);
  return {
    notes: notes.length,
    measures: notation.measures.length,
    key: notation.key || keyName(notation.keyFifths || 0),
    time: `${notation.timeSignature.beats}/${notation.timeSignature.beatType}`,
    bpm: notation.bpm || 120,
    staves: notation.staves,
    clef: notation.clef || (notation.staves === 2 ? "grand" : "treble"),
  };
}

export { noteNameForMidi };
