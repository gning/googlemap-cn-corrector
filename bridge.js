// Isolated-world bridge: mirrors the extension setting (chrome.storage) into
// the page so the MAIN-world script (corrector.js) can read it. Data crosses
// worlds via a DOM attribute; a plain Event signals changes.
(function () {
  'use strict';

  function apply(enabled) {
    var el = document.documentElement;
    if (!el) return;
    el.dataset.gmcnEnabled = String(enabled !== false);
    document.dispatchEvent(new Event('gmcn-config'));
  }

  chrome.storage.sync.get({ enabled: true }, function (items) {
    apply(items.enabled);
  });

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'sync' && changes.enabled) {
      apply(changes.enabled.newValue);
    }
  });
})();
