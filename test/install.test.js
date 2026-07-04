// Integration-style test: runs gmcnInstall() against a stubbed browser scope
// and verifies the fetch hook end-to-end (tile detection -> source tile
// fetches -> canvas composite -> corrected Response).
// Run: node test/install.test.js
'use strict';

const assert = require('node:assert');
const { gmcnCore, gmcnInstall } = require('../corrector.js');

const core = gmcnCore();
const TILE = 256;

function makeScope() {
  const fetched = [];
  const drawn = [];

  class FakeResponse {
    constructor(body, init) {
      this.body = body;
      this.status = (init && init.status) || 200;
      this.headers = (init && init.headers) || {};
      this.__corrected = true;
    }
  }

  class FakeCanvas {
    constructor(w, h) {
      this.width = w;
      this.height = h;
    }
    getContext() {
      return {
        imageSmoothingEnabled: false,
        imageSmoothingQuality: '',
        drawImage(bmp, x, y, w, h) {
          drawn.push({ x, y, w, h });
        }
      };
    }
    convertToBlob() {
      return Promise.resolve({ type: 'image/jpeg' });
    }
  }

  // Minimal HTMLImageElement mimicking what Maps' tile loader relies on:
  // src accessor pair + decode() that rejects while there is no src.
  class FakeImage {
    constructor() {
      this._src = '';
      this._listeners = Object.create(null);
    }
    addEventListener(type, fn) {
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    }
    decode() {
      return this._src
        ? Promise.resolve()
        : Promise.reject(new Error('EncodingError: no src'));
    }
  }
  Object.defineProperty(FakeImage.prototype, 'src', {
    configurable: true,
    enumerable: true,
    get() { return this._src; },
    set(v) { this._src = String(v); }
  });

  const scope = {
    fetch(url) {
      fetched.push(String(url));
      return Promise.resolve({
        ok: true,
        blob: () => Promise.resolve({ size: 1 })
      });
    },
    createImageBitmap() {
      return Promise.resolve({ width: TILE, height: TILE, close() {} });
    },
    OffscreenCanvas: FakeCanvas,
    Response: FakeResponse,
    HTMLImageElement: FakeImage,
    URL: {
      createObjectURL: () => 'blob:fake/corrected-tile',
      revokeObjectURL() {}
    }
  };
  return { scope, fetched, drawn };
}

// Guangzhou (the reference location from the bug report) at z=15.
function tileAt(lat, lng, z) {
  const n = 2 ** z;
  const latRad = (lat * Math.PI) / 180;
  return {
    x: Math.floor(((lng + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n)
  };
}

async function main() {
  // --- corrected tile inside mainland China ---
  {
    const { scope, fetched, drawn } = makeScope();
    gmcnInstall(scope, gmcnCore(), { enabled: true, minPixelOffset: 2 });

    const { x, y } = tileAt(23.1233, 113.2376, 15);
    const url = `https://khms0.google.com/kh/v=992?x=${x}&y=${y}&z=15`;
    const res = await scope.fetch(url);

    assert.ok(res.__corrected, 'should return a synthesized Response');
    assert.strictEqual(res.headers['Content-Type'], 'image/jpeg');

    const off = core.offsetTileUnits(x, y, 15);
    const plan = core.planTiles(x, y, 15, off.du, off.dv);
    assert.ok(plan.length >= 1 && plan.length <= 4);

    // Every planned source tile was fetched with rewritten x/y...
    for (const t of plan) {
      const srcUrl = `https://khms0.google.com/kh/v=992?x=${t.tx}&y=${t.ty}&z=15`;
      assert.ok(fetched.includes(srcUrl), `missing source fetch ${srcUrl}`);
    }
    assert.strictEqual(fetched.length, plan.length, 'no extra fetches');

    // ...and drawn at the planned sub-pixel positions.
    assert.strictEqual(drawn.length, plan.length);
    for (const t of plan) {
      assert.ok(
        drawn.some(d =>
          Math.abs(d.x - t.u * TILE) < 1e-6 &&
          Math.abs(d.y - t.v * TILE) < 1e-6 &&
          d.w === TILE && d.h === TILE),
        `tile (${t.tx},${t.ty}) not drawn at (${t.u * TILE},${t.v * TILE})`
      );
    }
    console.log(`  ok - Guangzhou z15 tile corrected from ${plan.length} source tiles`);
  }

  // --- tile outside China passes through untouched ---
  {
    const { scope, fetched, drawn } = makeScope();
    gmcnInstall(scope, gmcnCore(), { enabled: true, minPixelOffset: 2 });

    const { x, y } = tileAt(35.68, 139.69, 15); // Tokyo
    const url = `https://khms0.google.com/kh/v=992?x=${x}&y=${y}&z=15`;
    const res = await scope.fetch(url);

    assert.ok(!res.__corrected, 'should pass through to the real fetch');
    assert.deepStrictEqual(fetched, [url]);
    assert.strictEqual(drawn.length, 0);
    console.log('  ok - Tokyo tile passes through untouched');
  }

  // --- disabled flag passes everything through ---
  {
    const { scope, fetched } = makeScope();
    gmcnInstall(scope, gmcnCore(), { enabled: false, minPixelOffset: 2 });

    const { x, y } = tileAt(23.1233, 113.2376, 15);
    const url = `https://khms0.google.com/kh/v=992?x=${x}&y=${y}&z=15`;
    const res = await scope.fetch(url);

    assert.ok(!res.__corrected);
    assert.deepStrictEqual(fetched, [url]);
    console.log('  ok - disabled config passes through');
  }

  // --- cache: same tile requested twice composites once ---
  {
    const { scope, fetched } = makeScope();
    gmcnInstall(scope, gmcnCore(), { enabled: true, minPixelOffset: 2 });

    const { x, y } = tileAt(23.1233, 113.2376, 15);
    const url = `https://khms0.google.com/kh/v=992?x=${x}&y=${y}&z=15`;
    await scope.fetch(url);
    const before = fetched.length;
    await scope.fetch(url);
    assert.strictEqual(fetched.length, before, 'second request served from cache');
    console.log('  ok - corrected tiles are cached');
  }

  // --- <img> path: Maps sets src then calls decode() immediately ---
  {
    const { scope, fetched } = makeScope();
    gmcnInstall(scope, gmcnCore(), { enabled: true, minPixelOffset: 2 });

    const { x, y } = tileAt(23.1233, 113.2376, 15);
    const url = `https://khms0.google.com/kh/v=992?x=${x}&y=${y}&z=15`;
    const img = new scope.HTMLImageElement();
    img.src = url;

    // decode() is called by Maps synchronously after assigning src, i.e.
    // before the corrected blob exists. It must NOT reject.
    const decoded = img.decode();

    // Maps reads img.src back to match the tile; it must see the tile URL,
    // never a blob: URL.
    assert.strictEqual(img.src, url, 'src getter reports the original URL');

    await decoded;
    assert.ok(img._src.startsWith('blob:'), 'underlying src swapped to the corrected blob');
    assert.strictEqual(img.src, url, 'getter still reports the original URL after the swap');
    assert.ok(fetched.length >= 1, 'source tiles were fetched to build the correction');
    console.log('  ok - <img> tile: decode() waits for the swap, src reads back original');
  }

  // --- <img> path: tile outside China falls back to the original URL ---
  {
    const { scope } = makeScope();
    gmcnInstall(scope, gmcnCore(), { enabled: true, minPixelOffset: 2 });

    const { x, y } = tileAt(35.68, 139.69, 15); // Tokyo
    const url = `https://khms0.google.com/kh/v=992?x=${x}&y=${y}&z=15`;
    const img = new scope.HTMLImageElement();
    img.src = url;
    await img.decode();
    assert.strictEqual(img._src, url, 'no-correction tile loads the original URL');
    console.log('  ok - <img> tile outside China passes through');
  }

  // --- <img> path: non-tile images are untouched ---
  {
    const { scope } = makeScope();
    gmcnInstall(scope, gmcnCore(), { enabled: true, minPixelOffset: 2 });

    const img = new scope.HTMLImageElement();
    img.src = 'https://www.google.com/maps/vt/icon/name=assets/foo.png';
    assert.strictEqual(img._src, 'https://www.google.com/maps/vt/icon/name=assets/foo.png');
    await img.decode(); // must not hang or reject
    console.log('  ok - non-tile <img> untouched');
  }

  console.log('\nall install tests passed');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
