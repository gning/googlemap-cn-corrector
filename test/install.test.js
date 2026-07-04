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
    Response: FakeResponse
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

  console.log('\nall install tests passed');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
