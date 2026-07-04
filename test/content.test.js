// Unit tests for the gl=cn URL rewriting logic.
// Run: node test/content.test.js
'use strict';

const assert = require('node:assert');
const { gmcnLogic } = require('../content.js');

const { outOfChina, rewriteUrl } = gmcnLogic();

let n = 0;
function ok(name, fn) {
  fn();
  n++;
  console.log('  ok - ' + name);
}

ok('outOfChina: mainland cities are in, others out', () => {
  assert.strictEqual(outOfChina(23.1233, 113.2376), false); // Guangzhou
  assert.strictEqual(outOfChina(39.9042, 116.4074), false); // Beijing
  assert.strictEqual(outOfChina(35.68, 139.69), true);      // Tokyo
  assert.strictEqual(outOfChina(22.3193, 114.1694), true);  // Hong Kong
  assert.strictEqual(outOfChina(25.033, 121.5654), true);   // Taipei
});

ok('adds gl=cn to a China satellite URL', () => {
  const out = rewriteUrl('https://www.google.com/maps/@23.1232526,113.2375627,2000m/data=!3m1!1e3?hl=en');
  assert.strictEqual(out, 'https://www.google.com/maps/@23.1232526,113.2375627,2000m/data=!3m1!1e3?hl=en&gl=cn');
});

ok('adds gl=cn when the URL has no query string', () => {
  const out = rewriteUrl('https://www.google.com/maps/@39.9042,116.4074,15z');
  assert.strictEqual(out, 'https://www.google.com/maps/@39.9042,116.4074,15z?gl=cn');
});

ok('adds gl=cn to a coordinate-less maps URL', () => {
  const out = rewriteUrl('https://www.google.com/maps?hl=en');
  assert.strictEqual(out, 'https://www.google.com/maps?hl=en&gl=cn');
});

ok('no-op when gl=cn already present (any case)', () => {
  assert.strictEqual(rewriteUrl('https://www.google.com/maps/@23.12,113.23,15z?gl=cn'), null);
  assert.strictEqual(rewriteUrl('https://www.google.com/maps/@23.12,113.23,15z?gl=CN'), null);
});

ok('overrides a different gl value inside China', () => {
  const out = rewriteUrl('https://www.google.com/maps/@23.12,113.23,15z?gl=us&hl=en');
  const u = new URL(out);
  assert.strictEqual(u.searchParams.get('gl'), 'cn');
  assert.strictEqual(u.searchParams.get('hl'), 'en');
});

ok('no-op outside mainland China', () => {
  assert.strictEqual(rewriteUrl('https://www.google.com/maps/@35.68,139.69,14z'), null);   // Tokyo
  assert.strictEqual(rewriteUrl('https://www.google.com/maps/@22.3193,114.1694,14z'), null); // Hong Kong
  assert.strictEqual(rewriteUrl('https://www.google.com/maps/@25.033,121.5654,14z'), null);  // Taipei
});

ok('no-op on non-maps google pages and non-google hosts', () => {
  assert.strictEqual(rewriteUrl('https://www.google.com/search?q=maps'), null);
  assert.strictEqual(rewriteUrl('https://example.com/maps/@23.12,113.23,15z'), null);
  assert.strictEqual(rewriteUrl('not a url'), null);
});

ok('handles place URLs with coordinates deeper in the path', () => {
  const out = rewriteUrl('https://www.google.com/maps/place/Canton+Tower/@23.1066,113.3245,17z/data=!3m1!1e3');
  assert.ok(out.endsWith('?gl=cn'));
});

ok('works on google.com.hk and maps.google.com hosts', () => {
  assert.ok(rewriteUrl('https://www.google.com.hk/maps/@23.12,113.23,15z'));
  assert.ok(rewriteUrl('https://maps.google.com/maps?hl=zh-CN'));
});

console.log('\n' + n + ' tests passed');
