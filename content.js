/*
 * Google Maps CN Satellite Corrector
 *
 * On google.com/maps, the road/label layer inside mainland China uses GCJ-02
 * ("Mars") coordinates while by default the satellite imagery is true WGS-84,
 * so imagery and labels are misaligned by ~100-700 m.
 *
 * Fix: load the page with the `gl=cn` query parameter. Google's servers then
 * serve satellite imagery already shifted to GCJ-02, so imagery, labels and
 * markers all line up — no client-side tile rewriting needed.
 * (Approach from https://github.com/Cygra/google-map-cn-correction .)
 *
 * This script runs at document_start and redirects once when needed. To keep
 * the side effects of `gl=cn` (China-region search bias) away from unrelated
 * browsing, URLs whose @lat,lng viewport is clearly outside mainland China
 * are left untouched.
 */

function gmcnLogic() {
  'use strict';

  // Mainland bounding box, minus regions where Google's labels are NOT
  // GCJ-02 shifted (no correction wanted there).
  // [minLat, maxLat, minLng, maxLng]
  var EXCLUDED = [
    [21.5, 25.7, 119.9, 124.6],     // Taiwan
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

  // Returns the URL to redirect to, or null when no redirect is needed.
  function rewriteUrl(href) {
    var u;
    try {
      u = new URL(href);
    } catch (e) {
      return null;
    }
    if (!/(^|\.)google\.(com|com\.hk|cn)$/.test(u.hostname)) return null;
    if (!/^\/maps(\/|$)/.test(u.pathname) && u.pathname !== '/maps') return null;
    if ((u.searchParams.get('gl') || '').toLowerCase() === 'cn') return null;

    // If the URL pins a viewport (/@lat,lng,...), only correct inside
    // mainland China; a URL without coordinates is corrected unconditionally.
    var m = u.pathname.match(/\/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
    if (m && outOfChina(parseFloat(m[1]), parseFloat(m[2]))) return null;

    u.searchParams.set('gl', 'cn');
    return u.href;
  }

  return { outOfChina: outOfChina, rewriteUrl: rewriteUrl };
}

(function () {
  'use strict';

  // Node (unit tests): export the pure logic, do nothing else.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { gmcnLogic: gmcnLogic };
    return;
  }

  chrome.storage.sync.get({ enabled: true }, function (items) {
    if (items.enabled === false) return;
    var target = gmcnLogic().rewriteUrl(window.location.href);
    if (target) window.location.replace(target);
  });
})();
