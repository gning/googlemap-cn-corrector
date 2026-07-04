// Unit tests for the pure tile/coordinate logic in corrector.js.
// Run: node test/core.test.js
'use strict';

const assert = require('node:assert');
const { gmcnCore } = require('../corrector.js');

const core = gmcnCore();
let passed = 0;

function test(name, fn) {
  fn();
  passed++;
  console.log('  ok -', name);
}

// Meters per degree (approx) for turning deltas into distances.
function deltaMeters(lat, d) {
  const mLat = d.dLat * 110574;
  const mLng = d.dLng * 111320 * Math.cos(lat * Math.PI / 180);
  return Math.hypot(mLat, mLng);
}

test('no offset outside China (Tokyo, LA, Sydney)', () => {
  for (const [lat, lng] of [[35.68, 139.69], [34.05, -118.24], [-33.87, 151.21]]) {
    const d = core.wgs2gcjDelta(lat, lng);
    assert.strictEqual(d.dLat, 0);
    assert.strictEqual(d.dLng, 0);
  }
});

test('no offset in Taiwan / Hong Kong / Macau exclusion zones', () => {
  for (const [lat, lng] of [[25.03, 121.56], [22.28, 114.16], [22.19, 113.54]]) {
    const d = core.wgs2gcjDelta(lat, lng);
    assert.strictEqual(deltaMeters(lat, d), 0, `expected 0 at ${lat},${lng}`);
  }
});

test('mainland cities have a plausible GCJ offset (100-900 m)', () => {
  const cities = {
    Guangzhou: [23.1233, 113.2376],
    Beijing: [39.9042, 116.4074],
    Shanghai: [31.2304, 121.4737],
    Chengdu: [30.5728, 104.0668],
    Urumqi: [43.8256, 87.6168]
  };
  for (const [name, [lat, lng]] of Object.entries(cities)) {
    const d = core.wgs2gcjDelta(lat, lng);
    const m = deltaMeters(lat, d);
    assert.ok(m > 100 && m < 900, `${name}: offset ${m.toFixed(1)}m out of range`);
  }
});

test('delta is smooth (varies < 5 m across one z=15 tile)', () => {
  const lat = 23.1233, lng = 113.2376, step = 360 / 2 ** 15;
  const a = core.wgs2gcjDelta(lat, lng);
  const b = core.wgs2gcjDelta(lat + step, lng + step);
  assert.ok(Math.abs(deltaMeters(lat, a) - deltaMeters(lat, b)) < 5);
});

test('tileCenter matches known values', () => {
  // Tile (0,0,0) center is (0,0); Guangzhou z=15 tile.
  const c0 = core.tileCenter(0, 0, 0);
  assert.ok(Math.abs(c0.lat) < 1e-9 && Math.abs(c0.lng) < 1e-9);
  const n = 2 ** 15;
  const x = Math.floor((113.2376 + 180) / 360 * n);
  const latRad = 23.1233 * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  const c = core.tileCenter(x, y, 15);
  assert.ok(Math.abs(c.lat - 23.1233) < 0.01 && Math.abs(c.lng - 113.2376) < 0.02);
});

test('offsetTileUnits direction matches the raw delta', () => {
  const n = 2 ** 15;
  const x = Math.floor((113.2376 + 180) / 360 * n);
  const latRad = 23.1233 * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  const c = core.tileCenter(x, y, 15);
  const d = core.wgs2gcjDelta(c.lat, c.lng);
  const off = core.offsetTileUnits(x, y, 15);
  // du sign follows dLng; dv is opposite dLat (canvas y grows downward).
  assert.ok(Math.sign(off.du) === Math.sign(d.dLng));
  assert.ok(Math.sign(off.dv) === -Math.sign(d.dLat));
  // Magnitude: pixel offset must equal the metric offset divided by the
  // ground resolution at this latitude/zoom (world is 256*2^15 px).
  const px = Math.hypot(off.du, off.dv) * 256;
  const meters = deltaMeters(c.lat, d);
  const expectedPx = meters / (156543.03392 * Math.cos(latRad) / 2 ** 15);
  assert.ok(Math.abs(px - expectedPx) / expectedPx < 0.05,
    `pixel offset ${px.toFixed(1)} vs expected ${expectedPx.toFixed(1)}`);
});

test('planTiles covers the requested tile exactly', () => {
  // Zero offset -> the tile itself, drawn at (0,0).
  let plan = core.planTiles(100, 200, 15, 0, 0);
  assert.strictEqual(plan.length, 1);
  assert.deepStrictEqual(plan[0], { tx: 100, ty: 200, u: 0, v: 0 });

  // Fractional offset -> 4 tiles whose draw rects tile the unit square.
  plan = core.planTiles(100, 200, 15, 0.3, -0.4);
  assert.strictEqual(plan.length, 4);
  for (const t of plan) {
    // each drawn tile must overlap [0,1)x[0,1)
    assert.ok(t.u > -1 && t.u < 1 && t.v > -1 && t.v < 1);
  }
  // union of [u,u+1) must cover [0,1): check a grid of sample points
  for (let sx = 0.05; sx < 1; sx += 0.1) {
    for (let sy = 0.05; sy < 1; sy += 0.1) {
      assert.ok(plan.some(t => sx >= t.u && sx < t.u + 1 && sy >= t.v && sy < t.v + 1),
        `point ${sx},${sy} not covered`);
    }
  }

  // Offset larger than one tile still needs at most 4 source tiles.
  plan = core.planTiles(100, 200, 20, 3.7, -2.2);
  assert.strictEqual(plan.length, 4);
  assert.strictEqual(plan[0].tx, 96); // floor(100 - 3.7)

  // Antimeridian wrap and world edge clamping.
  plan = core.planTiles(0, 0, 15, 0.5, 0.5);
  for (const t of plan) {
    assert.ok(t.tx >= 0 && t.tx < 2 ** 15);
    assert.ok(t.ty >= 0 && t.ty < 2 ** 15);
  }
});

test('parseTileUrl recognizes satellite tiles only', () => {
  const kh = core.parseTileUrl('https://khms0.google.com/kh/v=992?x=419&y=193&z=9');
  assert.deepStrictEqual({ x: kh.x, y: kh.y, z: kh.z }, { x: 419, y: 193, z: 9 });

  const khApi = core.parseTileUrl('https://khms1.googleapis.com/kh?v=992&hl=en&x=6&y=3&z=3');
  assert.deepStrictEqual({ x: khApi.x, y: khApi.y, z: khApi.z }, { x: 6, y: 3, z: 3 });

  const mt = core.parseTileUrl('https://mt0.google.com/vt/lyrs=s@189&x=419&y=193&z=9&hl=en');
  assert.deepStrictEqual({ x: mt.x, y: mt.y, z: mt.z }, { x: 419, y: 193, z: 9 });

  // Must NOT match roadmap/vector/label tiles or unrelated URLs.
  assert.strictEqual(core.parseTileUrl('https://mt0.google.com/vt/lyrs=m&x=1&y=2&z=3'), null);
  assert.strictEqual(core.parseTileUrl('https://www.google.com/maps/vt/pb=!1m4!1m3!1i9!2i419!3i193'), null);
  assert.strictEqual(core.parseTileUrl('https://www.google.com/maps/@23.1,113.2,15z'), null);
  assert.strictEqual(core.parseTileUrl('not a url'), null);
});

test('replaceXY rewrites only x and y', () => {
  const url = 'https://khms0.google.com/kh/v=992?x=419&y=193&z=9';
  assert.strictEqual(core.replaceXY(url, 420, 192),
    'https://khms0.google.com/kh/v=992?x=420&y=192&z=9');
});

console.log(`\n${passed} tests passed`);
