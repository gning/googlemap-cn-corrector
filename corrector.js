/*
 * Google Maps CN Satellite Corrector
 *
 * On google.com/maps, the road/label layer inside mainland China uses GCJ-02
 * ("Mars") coordinates while satellite imagery uses true WGS-84, so imagery
 * and labels are misaligned by ~100-700 m. This script runs in the page's
 * MAIN world, intercepts satellite raster tile requests, and rebuilds each
 * tile shifted by the local WGS-84 -> GCJ-02 delta so imagery lines up with
 * the labels.
 */

/* ------------------------------------------------------------------ *
 * Pure logic: coordinate transform + tile math. No DOM access, so it
 * can run in the window and in Node tests.
 * ------------------------------------------------------------------ */
function gmcnCore() {
  'use strict';

  var PI = Math.PI;
  var A = 6378245.0;               // GCJ-02 reference ellipsoid semi-major axis
  var EE = 0.00669342162296594323; // GCJ-02 reference ellipsoid eccentricity^2

  // Regions that fall inside the mainland bounding box but where Google's
  // labels are NOT GCJ-02 shifted, so no correction must be applied.
  // [minLat, maxLat, minLng, maxLng]
  var EXCLUDED = [
    [21.5, 25.7, 119.9, 124.6],   // Taiwan
    [22.13, 22.54, 113.82, 114.45], // Hong Kong (approx; border with Shenzhen)
    [22.06, 22.215, 113.52, 113.605] // Macau
  ];

  function outOfChina(lat, lng) {
    if (lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271) {
      return true;
    }
    for (var i = 0; i < EXCLUDED.length; i++) {
      var r = EXCLUDED[i];
      if (lat >= r[0] && lat <= r[1] && lng >= r[2] && lng <= r[3]) {
        return true;
      }
    }
    return false;
  }

  function transformLat(x, y) {
    var ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y +
      0.2 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(y * PI) + 40.0 * Math.sin(y / 3.0 * PI)) * 2.0 / 3.0;
    ret += (160.0 * Math.sin(y / 12.0 * PI) + 320.0 * Math.sin(y * PI / 30.0)) * 2.0 / 3.0;
    return ret;
  }

  function transformLng(x, y) {
    var ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y +
      0.1 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(x * PI) + 40.0 * Math.sin(x / 3.0 * PI)) * 2.0 / 3.0;
    ret += (150.0 * Math.sin(x / 12.0 * PI) + 300.0 * Math.sin(x / 30.0 * PI)) * 2.0 / 3.0;
    return ret;
  }

  // Delta (gcjLat - wgsLat, gcjLng - wgsLng) at a WGS-84 position.
  // Zero outside mainland China.
  function wgs2gcjDelta(lat, lng) {
    if (outOfChina(lat, lng)) return { dLat: 0, dLng: 0 };
    var dLat = transformLat(lng - 105.0, lat - 35.0);
    var dLng = transformLng(lng - 105.0, lat - 35.0);
    var radLat = lat / 180.0 * PI;
    var magic = Math.sin(radLat);
    magic = 1 - EE * magic * magic;
    var sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / ((A * (1 - EE)) / (magic * sqrtMagic) * PI);
    dLng = (dLng * 180.0) / (A / sqrtMagic * Math.cos(radLat) * PI);
    return { dLat: dLat, dLng: dLng };
  }

  // Center of a Web Mercator tile in WGS-84 degrees.
  function tileCenter(x, y, z) {
    var n = Math.pow(2, z);
    var lng = (x + 0.5) / n * 360 - 180;
    var lat = Math.atan(Math.sinh(PI * (1 - 2 * (y + 0.5) / n))) * 180 / PI;
    return { lat: lat, lng: lng };
  }

  // Offset of the GCJ shift at a tile, expressed in TILE UNITS (multiply by
  // the tile pixel size to get pixels). Positive du = east, positive dv =
  // down (screen direction), matching canvas axes.
  function offsetTileUnits(x, y, z) {
    var c = tileCenter(x, y, z);
    var d = wgs2gcjDelta(c.lat, c.lng);
    if (d.dLat === 0 && d.dLng === 0) return { du: 0, dv: 0 };
    var n = Math.pow(2, z);
    var du = d.dLng / 360 * n;
    // dWorldY/dLat in Mercator: -n/(2*PI) * sec(lat), lat in radians.
    var dv = -(n / (2 * PI)) * (d.dLat * PI / 180) / Math.cos(c.lat * PI / 180);
    return { du: du, dv: dv };
  }

  // Which source tiles are needed to fill the requested tile once imagery is
  // shifted by (du, dv), and where each must be drawn (u, v in tile units,
  // multiply by tile pixel size for canvas coordinates).
  function planTiles(x, y, z, du, dv) {
    var n = Math.pow(2, z);
    var sx = x - du; // source origin, in tile units
    var sy = y - dv;
    var tx0 = Math.floor(sx);
    var tx1 = Math.ceil(sx + 1) - 1;
    var ty0 = Math.floor(sy);
    var ty1 = Math.ceil(sy + 1) - 1;
    var tiles = [];
    for (var ty = ty0; ty <= ty1; ty++) {
      if (ty < 0 || ty >= n) continue; // off the top/bottom of the world
      for (var tx = tx0; tx <= tx1; tx++) {
        tiles.push({
          tx: ((tx % n) + n) % n, // wrap around the antimeridian
          ty: ty,
          u: tx - sx,
          v: ty - sy
        });
      }
    }
    return tiles;
  }

  // Google tile URLs carry parameters either as a query string or embedded
  // in the path separated by '&' (e.g. /vt/lyrs=s&x=1&y=2&z=3), so extract
  // them with a regex over the whole URL.
  function getParam(href, key) {
    var m = href.match(new RegExp('[/?&]' + key + '=([^&#]+)'));
    return m ? m[1] : null;
  }

  // Recognize satellite raster tile URLs and extract x/y/z.
  //  - https://khms0.google.com/kh/v=992?x=419&y=193&z=9
  //  - https://khms1.googleapis.com/kh?v=992&hl=en&x=419&y=193&z=9
  //  - https://mt0.google.com/vt/lyrs=s@189&x=419&y=193&z=9 (embed/static)
  function parseTileUrl(url) {
    var u;
    try {
      u = new URL(url, 'https://www.google.com');
    } catch (e) {
      return null;
    }
    var host = u.hostname;
    var isKh = /^kh(ms?)?\d*\.google(apis)?\.(com|cn)$/.test(host) &&
      /^\/kh\b/.test(u.pathname);
    var isVt = /^(mt|mts)\d*\.google\.(com|cn)$/.test(host) ||
      /^\/(maps\/)?vt\b/.test(u.pathname);
    if (!isKh && !isVt) return null;
    if (!isKh) {
      // Only satellite raster layers ("s", "s@123", ...); never touch the
      // vector/label layers or we would corrupt them.
      var lyrs = getParam(u.href, 'lyrs');
      if (!lyrs || lyrs.charAt(0) !== 's') return null;
    }
    var x = getParam(u.href, 'x');
    var y = getParam(u.href, 'y');
    var z = getParam(u.href, 'z');
    if (x === null || y === null || z === null) return null;
    x = parseInt(x, 10); y = parseInt(y, 10); z = parseInt(z, 10);
    if (!isFinite(x) || !isFinite(y) || !isFinite(z) || z < 0 || z > 23) return null;
    return { x: x, y: y, z: z, url: u.href };
  }

  function replaceXY(url, nx, ny) {
    return url
      .replace(/([?&]x=)-?\d+/, '$1' + nx)
      .replace(/([?&]y=)-?\d+/, '$1' + ny);
  }

  return {
    outOfChina: outOfChina,
    wgs2gcjDelta: wgs2gcjDelta,
    tileCenter: tileCenter,
    offsetTileUnits: offsetTileUnits,
    planTiles: planTiles,
    parseTileUrl: parseTileUrl,
    replaceXY: replaceXY
  };
}

/* ------------------------------------------------------------------ *
 * Hook installer. Runs against a window or a WorkerGlobalScope.
 * ------------------------------------------------------------------ */
function gmcnInstall(scope, core, config) {
  'use strict';

  if (scope.__gmcnInstalled) return;
  scope.__gmcnInstalled = true;

  var origFetch = scope.fetch ? scope.fetch.bind(scope) : null;
  var loggedOnce = false;

  // Cache of corrected tiles: url -> Promise<Blob|null>.
  var cache = new Map();
  var CACHE_MAX = 256;

  function logActive() {
    if (!loggedOnce) {
      loggedOnce = true;
      try {
        console.info('[GMaps CN Corrector] satellite offset correction active');
      } catch (e) { /* ignore */ }
    }
  }

  function makeCanvas(size) {
    if (typeof scope.OffscreenCanvas === 'function') {
      return new scope.OffscreenCanvas(size, size);
    }
    var c = scope.document.createElement('canvas');
    c.width = size; c.height = size;
    return c;
  }

  function canvasToBlob(canvas) {
    if (canvas.convertToBlob) {
      return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
    }
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) {
        if (b) resolve(b); else reject(new Error('toBlob failed'));
      }, 'image/jpeg', 0.92);
    });
  }

  // Build the corrected tile. Resolves to null when no correction is needed
  // (outside mainland China / negligible offset) so the caller passes the
  // request through untouched.
  function buildCorrected(info) {
    var off = core.offsetTileUnits(info.x, info.y, info.z);
    if (Math.hypot(off.du, off.dv) * 256 < config.minPixelOffset) {
      return Promise.resolve(null);
    }
    if (!origFetch) return Promise.resolve(null);

    var plan = core.planTiles(info.x, info.y, info.z, off.du, off.dv);
    var fetches = plan.map(function (t) {
      var srcUrl = core.replaceXY(info.url, t.tx, t.ty);
      return origFetch(srcUrl, { mode: 'cors', credentials: 'omit' })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.blob();
        })
        .then(function (blob) { return scope.createImageBitmap(blob); })
        .then(function (bmp) { return { tile: t, bmp: bmp }; })
        .catch(function () { return null; }); // missing edge tiles are fine
    });

    return Promise.all(fetches).then(function (parts) {
      parts = parts.filter(Boolean);
      if (parts.length === 0) return null; // nothing usable: pass through
      var S = parts[0].bmp.width || 256;
      var canvas = makeCanvas(S);
      var ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        ctx.drawImage(p.bmp, p.tile.u * S, p.tile.v * S, S, S);
        if (p.bmp.close) p.bmp.close();
      }
      return canvasToBlob(canvas);
    });
  }

  function correctedBlob(info) {
    var hit = cache.get(info.url);
    if (hit) return hit;
    var p = buildCorrected(info).catch(function () { return null; });
    cache.set(info.url, p);
    if (cache.size > CACHE_MAX) {
      cache.delete(cache.keys().next().value); // drop oldest entry
    }
    return p;
  }

  function matchUrl(url) {
    if (!config.enabled) return null;
    return core.parseTileUrl(url);
  }

  /* ---- fetch() ---- */
  if (origFetch) {
    scope.fetch = function (input, init) {
      var url = '';
      try {
        url = typeof input === 'string' ? input : (input && input.url) || String(input);
      } catch (e) { /* ignore */ }
      var info = matchUrl(url);
      if (!info) return origFetch(input, init);
      return correctedBlob(info).then(function (blob) {
        if (!blob) return origFetch(input, init);
        logActive();
        return new scope.Response(blob, {
          status: 200,
          statusText: 'OK',
          headers: { 'Content-Type': blob.type || 'image/jpeg' }
        });
      });
    };
  }

  /* ---- XMLHttpRequest ---- */
  if (scope.XMLHttpRequest) {
    var XP = scope.XMLHttpRequest.prototype;
    var origOpen = XP.open;
    var origSend = XP.send;

    XP.open = function (method, url) {
      this.__gmcnUrl = (method && String(method).toUpperCase() === 'GET') ? String(url) : null;
      return origOpen.apply(this, arguments);
    };

    XP.send = function (body) {
      var info = this.__gmcnUrl ? matchUrl(this.__gmcnUrl) : null;
      if (!info) return origSend.apply(this, arguments);
      var xhr = this;
      var rt = xhr.responseType;
      if (rt !== 'arraybuffer' && rt !== 'blob') {
        return origSend.apply(this, arguments);
      }
      correctedBlob(info).then(function (blob) {
        if (!blob) return origSend.call(xhr, body);
        return (rt === 'blob' ? Promise.resolve(blob) : blob.arrayBuffer())
          .then(function (result) {
            logActive();
            var props = {
              readyState: 4,
              status: 200,
              statusText: 'OK',
              response: result,
              responseURL: info.url
            };
            for (var k in props) {
              Object.defineProperty(xhr, k, { value: props[k], configurable: true });
            }
            xhr.getAllResponseHeaders = function () {
              return 'content-type: ' + (blob.type || 'image/jpeg') + '\r\n';
            };
            xhr.getResponseHeader = function (name) {
              return String(name).toLowerCase() === 'content-type'
                ? (blob.type || 'image/jpeg') : null;
            };
            xhr.dispatchEvent(new scope.Event('readystatechange'));
            xhr.dispatchEvent(new scope.ProgressEvent('load'));
            xhr.dispatchEvent(new scope.ProgressEvent('loadend'));
          });
      }).catch(function () {
        try { origSend.call(xhr, body); } catch (e) { /* already sent/aborted */ }
      });
    };
  }

  /* ---- <img src> (classic raster mode) ---- */
  if (scope.HTMLImageElement) {
    var desc = Object.getOwnPropertyDescriptor(scope.HTMLImageElement.prototype, 'src');
    if (desc && desc.set) {
      Object.defineProperty(scope.HTMLImageElement.prototype, 'src', {
        configurable: true,
        enumerable: desc.enumerable,
        get: desc.get,
        set: function (value) {
          var info = null;
          try {
            info = matchUrl(String(value));
          } catch (e) { /* never let the hook break image loading */ }
          if (!info) return desc.set.call(this, value);
          var img = this;
          correctedBlob(info).then(function (blob) {
            if (!blob) return desc.set.call(img, value);
            logActive();
            var objUrl = scope.URL.createObjectURL(blob);
            var cleanup = function () { scope.URL.revokeObjectURL(objUrl); };
            img.addEventListener('load', cleanup, { once: true });
            img.addEventListener('error', cleanup, { once: true });
            desc.set.call(img, objUrl);
          }).catch(function () { desc.set.call(img, value); });
        }
      });
    }
  }

  // NOTE: no Worker patching. Wrapping Google's worker scripts in blob: URLs
  // changes self.location inside the worker, which breaks Maps' own
  // relative-URL resolution and crashes the whole app ("We're sorry, but an
  // error has occurred"). Satellite raster tiles are requested from the main
  // thread, so the fetch/XHR/<img> hooks above are sufficient.
}

/* ------------------------------------------------------------------ *
 * Entry point.
 * ------------------------------------------------------------------ */
(function () {
  'use strict';

  // Node (unit tests): export the pure core, install nothing.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { gmcnCore: gmcnCore, gmcnInstall: gmcnInstall };
    return;
  }

  var scope = typeof self !== 'undefined' ? self : window;
  var config = {
    enabled: true,
    minPixelOffset: 2 // skip correction when the shift is < 2px at 256px tiles
  };

  if (scope.document) {
    var readFlag = function () {
      var el = scope.document.documentElement;
      if (el && el.dataset && el.dataset.gmcnEnabled !== undefined) {
        config.enabled = el.dataset.gmcnEnabled !== 'false';
      }
    };
    readFlag();
    // The isolated-world bridge sets data-gmcn-enabled from chrome.storage
    // and fires this event on every change.
    scope.document.addEventListener('gmcn-config', readFlag);
  }

  // Fail safe: if installation throws for any reason, leave the page's
  // networking completely untouched rather than risk breaking Maps.
  try {
    gmcnInstall(scope, gmcnCore(), config);
  } catch (e) {
    try { console.warn('[GMaps CN Corrector] install failed:', e); } catch (e2) { /* ignore */ }
  }
})();
