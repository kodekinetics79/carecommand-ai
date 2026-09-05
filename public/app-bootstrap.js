/* Runs before the hashed module: recovery inside that module cannot help if
 * the entry module itself was replaced during a deployment. No API/session
 * data is read. Leave a usable static fallback even when storage is denied. */
(function () {
  function showRecovery() {
    var title = document.getElementById('app-startup-title');
    var message = document.getElementById('app-startup-message');
    if (title) title.textContent = 'Your workspace could not finish opening';
    if (message) message.textContent = 'A connection problem or application update may have interrupted loading. Reload this page to try again. Your saved records are not changed.';
  }

  window.addEventListener('error', function (event) {
    var script = event.target;
    // Vite rewrites the entry tag and drops custom IDs in its output HTML.
    if (!script || script !== document.querySelector('script[type="module"][src]') || !document.getElementById('app-startup')) return;
    showRecovery();
    try {
      var key = 'carecommand:entry-recovery';
      var signature = script.src;
      if (!signature || window.sessionStorage.getItem(key) === signature) return;
      window.sessionStorage.setItem(key, signature);
      window.location.reload();
    } catch (_) {
      // Storage can be unavailable. Never reload without a durable loop guard.
    }
  }, true);

  window.setTimeout(function () {
    if (document.getElementById('app-startup')) showRecovery();
  }, 15000);
}());
