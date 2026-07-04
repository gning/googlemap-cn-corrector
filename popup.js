(function () {
  'use strict';

  var checkbox = document.getElementById('enabled');

  chrome.storage.sync.get({ enabled: true }, function (items) {
    checkbox.checked = items.enabled !== false;
  });

  checkbox.addEventListener('change', function () {
    chrome.storage.sync.set({ enabled: checkbox.checked });
  });
})();
