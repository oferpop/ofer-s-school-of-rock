// Minimal staff renderer for monophonic melodies and stacked notes.
// Draws a treble staff per row of four 4/4 bars from parsed player events.

const ACCIDENTAL = { 0: 0, 1: 1, 2: 0, 3: 1, 4: 0, 5: 0, 6: 1, 7: 0, 8: 1, 9: 0, 10: 1, 11: 0 };
const LETTER = { 0: 0, 1: 0, 2: 1, 3: 1, 4: 2, 5: 3, 6: 3, 7: 4, 8: 4, 9: 5, 10: 5, 11: 6 };

function diatonic(midi) {
  const pc = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  return { position: LETTER[pc] + 7 * octave, accidental: ACCIDENTAL[pc] };
}

const escape = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/**
 * events: [{ column, midi: [..] }] where column is a 16th-note index.
 */
export function renderStaff(events, { columnsPerBar = 16, barsPerRow = 4, width = 840 } = {}) {
  if (!events.length) return "";
  const maxColumn = Math.max(...events.map((event) => event.column));
  const bars = Math.floor(maxColumn / columnsPerBar) + 1;
  const rows = Math.ceil(bars / barsPerRow);
  const rowHeight = 118;
  const left = 64;
  const barWidth = (width - left - 16) / barsPerRow;

  let svg = `<svg class="staff-svg" viewBox="0 0 ${width} ${rows * rowHeight}" role="img" aria-label="Melody in staff notation">`;

  for (let row = 0; row < rows; row++) {
    const top = row * rowHeight + 26;
    const bottom = top + 40;

    for (let line = 0; line < 5; line++) {
      const y = top + line * 10;
      svg += `<line class="staff-line" x1="10" y1="${y}" x2="${width - 10}" y2="${y}" />`;
    }

    svg += `<text class="staff-clef" x="14" y="${top + 39}">𝄞</text>`;
    if (row === 0) {
      svg += `<text class="staff-time" x="44" y="${top + 9}">4</text>`;
      svg += `<text class="staff-time" x="44" y="${top + 21}">4</text>`;
    }

    for (let bar = 0; bar <= barsPerRow; bar++) {
      const x = left + bar * barWidth;
      svg += `<line class="staff-bar" x1="${x}" y1="${top}" x2="${x}" y2="${bottom}" />`;
    }

    for (const event of events) {
      const bar = Math.floor(event.column / columnsPerBar);
      if (Math.floor(bar / barsPerRow) !== row) continue;
      const barInRow = bar % barsPerRow;
      const slot = event.column % columnsPerBar;
      const x = left + barInRow * barWidth + 8 + (slot / columnsPerBar) * (barWidth - 16);
      const notes = [...new Set(event.midi)].sort((a, b) => a - b);

      for (const midi of notes) {
        const { position, accidental } = diatonic(midi);
        const y = bottom - (position - 30) * 5;
        if (y < top - 20 || y > bottom + 30) continue;

        // Ledger lines outside the five staff lines.
        if (position <= 28 && position % 2 === 0) {
          for (let p = 28; p >= position; p -= 2) {
            const ly = bottom - (p - 30) * 5;
            svg += `<line class="staff-ledger" x1="${x - 9}" y1="${ly}" x2="${x + 9}" y2="${ly}" />`;
          }
        }
        if (position >= 40 && position % 2 === 0) {
          for (let p = 40; p <= position; p += 2) {
            const ly = bottom - (p - 30) * 5;
            svg += `<line class="staff-ledger" x1="${x - 9}" y1="${ly}" x2="${x + 9}" y2="${ly}" />`;
          }
        }

        if (accidental) svg += `<text class="staff-accidental" x="${x - 14}" y="${y + 4}">♯</text>`;

        svg += `<ellipse class="staff-head" cx="${x}" cy="${y}" rx="4.8" ry="3.4" transform="rotate(-18 ${x} ${y})" />`;
      }

      const firstY = bottom - (diatonic(notes[0]).position - 30) * 5;
      const stemUp = firstY > top + 20;
      const stemX = stemUp ? x + 4.2 : x - 4.2;
      const stemY2 = stemUp ? firstY - 26 : firstY + 26;
      svg += `<line class="staff-stem" x1="${stemX}" y1="${firstY}" x2="${stemX}" y2="${stemY2}" />`;
    }
  }

  svg += "</svg>";
  return svg;
}

export { escape };
