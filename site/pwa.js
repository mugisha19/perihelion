'use strict';

// Progressive web app glue: registers the service worker and drives the "install" button.
(() => {
  const installBtn = document.getElementById('installBtn');
  const iosHint = document.getElementById('iosHint');

  const standalone = () =>
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    window.navigator.standalone === true;

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
    });
  }

  if (standalone()) return; // already installed, nothing to offer

  // Chrome, Edge, Samsung Internet: offer the native install prompt.
  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    installBtn.hidden = false;
  });
  installBtn.addEventListener('click', async () => {
    if (!deferred) return;
    const prompt = deferred;
    deferred = null;
    installBtn.hidden = true;
    prompt.prompt();
    try { await prompt.userChoice; } catch { /* dismissed */ }
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    installBtn.hidden = true;
    iosHint.hidden = true;
  });

  // iOS Safari has no install prompt, so explain the manual route.
  const ua = window.navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
  const safari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  if (iOS && safari) iosHint.hidden = false;
})();
