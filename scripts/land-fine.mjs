// Builds web/src/land-fine.ts: land on a 0.2° grid, for zooming in close on the dotted globe.
// From Natural Earth's 1:10m land polygons (public domain) via world-atlas. Not a dependency:
//
//   npm i --no-save world-atlas@2 topojson-client@3
//   node scripts/land-fine.mjs
//
// Rows run from 80°N down to 58°S and columns from 180°W eastward. Each row is stored as run
// lengths, sea first then land, alternating, as unsigned LEB128 varints, all rows concatenated
// and base64-encoded. A cell is land when land (even-odd) touches it on any of three scanlines.

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { feature } = require('topojson-client');
const topo = JSON.parse(readFileSync(require.resolve('world-atlas/land-10m.json'), 'utf8'));
const land = feature(topo, topo.objects.land);

const STEP = 0.2;
const LAT0 = 80;
const ROWS = Math.round((LAT0 + 58) / STEP);
const COLS = Math.round(360 / STEP);

// Every ring's edges, as [lon1, lat1, lon2, lat2, ring]. Longitudes are unwrapped along each ring,
// so a ring that crosses the 180° line runs on past it (to 190°, say) instead of jumping back;
// cells are wrapped round again when filled.
const edges = [];
let rings = 0;
const polys = land.type === 'FeatureCollection' ? land.features.map((f) => f.geometry) : [land.geometry];
for (const g of polys) {
  const list = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  for (const poly of list)
    for (const ring of poly) {
      const id = rings++;
      let u = ring[0][0];
      for (let i = 0; i < ring.length - 1; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[i + 1];
        let dx = x2 - x1;
        if (dx > 180) dx -= 360;
        else if (dx < -180) dx += 360;
        if (y1 !== y2) edges.push([u, y1, u + dx, y2, id]);
        u += dx;
      }
    }
}
// Bucket the edges by the rows they span, so each row looks only at its own.
const byRow = Array.from({ length: ROWS }, () => []);
for (const e of edges) {
  const lo = Math.min(e[1], e[3]);
  const hi = Math.max(e[1], e[3]);
  const r0 = Math.max(0, Math.floor((LAT0 - hi) / STEP) - 1);
  const r1 = Math.min(ROWS - 1, Math.ceil((LAT0 - lo) / STEP));
  for (let r = r0; r <= r1; r++) byRow[r].push(e);
}

const bytes = [];
const varint = (n) => {
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    bytes.push(b);
  } while (n);
};
let landCells = 0;
for (let r = 0; r < ROWS; r++) {
  // Three scanlines across the row, and a cell counts as land if land touches it on any of them,
  // so islands narrower than a cell (Singapore is) still show.
  const row = new Uint8Array(COLS);
  for (const f of [0.17, 0.5, 0.83]) {
    const lat = LAT0 - (r + f) * STEP;
    // Each ring on its own: where the scanline crosses it, filled between pairs, toggling cells so
    // a hole (an inland sea) cuts out of the land around it. Cells touched count, wrapped round 180°.
    const line = new Uint8Array(COLS);
    const byRing = new Map();
    for (const [x1, y1, x2, y2, id] of byRow[r])
      if ((y1 <= lat && y2 > lat) || (y2 <= lat && y1 > lat)) {
        if (!byRing.has(id)) byRing.set(id, []);
        byRing.get(id).push(x1 + ((lat - y1) / (y2 - y1)) * (x2 - x1));
      }
    for (const xs of byRing.values()) {
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const c0 = Math.floor((xs[i] + 180) / STEP);
        const c1 = Math.floor((xs[i + 1] + 180) / STEP);
        for (let c = c0; c <= c1 && c < c0 + COLS; c++) line[((c % COLS) + COLS) % COLS] ^= 1;
      }
    }
    for (let c = 0; c < COLS; c++) row[c] |= line[c];
  }
  let cur = 0;
  let run = 0;
  for (let c = 0; c < COLS; c++) {
    if (row[c] === cur) run++;
    else {
      varint(run);
      cur = row[c];
      run = 1;
    }
    landCells += row[c];
  }
  varint(run);
}
const b64 = Buffer.from(bytes).toString('base64');
const out = resolve(dirname(fileURLToPath(import.meta.url)), '../web/src/land-fine.ts');
writeFileSync(
  out,
  `// Land on a 0.2° grid, for zooming in close on the dotted globe; loaded only when you do. Generated
// by scripts/land-fine.mjs from Natural Earth's 1:10m land polygons (public domain) via world-atlas.
// Rows from 80°N down to 58°S, columns from 180°W eastward; each row as run lengths (sea first, then
// land, alternating) in LEB128 varints, all rows concatenated and base64-encoded.

export const LAND_FINE = { lat0: ${LAT0}, step: ${STEP}, rows: ${ROWS}, cols: ${COLS}, runs: '${b64}' };
`,
);
console.log(`${ROWS} × ${COLS} cells, ${landCells} land, ${rings} rings, ${edges.length} edges → ${Math.round(b64.length / 1024)} KB`);
