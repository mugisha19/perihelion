'use strict';

// Progressive web app glue: registers the service worker and drives the "Install app" button.
//
// Chrome and Edge (Android and desktop) can install with one tap through the beforeinstallprompt
// event. Safari, iOS browsers and Firefox never send that event, so for them the button opens a
// short guide with the exact steps for the browser the player is using. The button is always
// visible (unless the app is already installed) so it can never silently do nothing.
(() => {
  const installBtn = document.getElementById('installBtn');
  const menu = document.getElementById('menu');
  const sheet = document.getElementById('installHelp');
  const intro = document.getElementById('installIntro');
  const steps = document.getElementById('installSteps');
  const closeBtn = document.getElementById('installClose');
  const appName = document.title;

  const standalone = () =>
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    window.navigator.standalone === true;

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
    });

    // When a new version of the app takes over, reload once so players are not left on old code.
    // Only done from the idle menu, never mid-game, and never on the very first install.
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !menu.hidden) window.location.reload();
    });
  }

  if (standalone()) return; // already installed, nothing to offer

  installBtn.hidden = false;

  // ---------- one-tap install (Chromium) ----------
  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    installBtn.hidden = true;
    closeGuide();
  });

  // ---------- browser detection ----------
  function detect() {
    const ua = navigator.userAgent;
    const ios = /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
    const android = /Android/.test(ua);
    const inApp = /FBAN|FBAV|FB_IAB|Instagram|Snapchat|TikTok|MicroMessenger|Line\/|Twitter|LinkedInApp|; wv\)/.test(ua) ||
      (ios && !/Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua));
    let browser = 'other';
    if (/EdgiOS|EdgA|Edg\//.test(ua)) browser = 'edge';
    else if (/CriOS/.test(ua) || (/Chrome\//.test(ua) && !/OPR\/|SamsungBrowser/.test(ua))) browser = 'chrome';
    else if (/SamsungBrowser/.test(ua)) browser = 'samsung';
    else if (/FxiOS|Firefox\//.test(ua)) browser = 'firefox';
    else if (/Safari\//.test(ua)) browser = 'safari';
    return { ios, android, inApp, browser };
  }

  function guideFor({ ios, android, inApp, browser }) {
    if (inApp) {
      return {
        intro: 'This page is open inside another app, and those cannot install games.',
        steps: [
          'Tap the menu (••• or ⋮) in the corner of this screen.',
          ios ? 'Choose “Open in Safari”.' : 'Choose “Open in browser” or “Open in Chrome”.',
          'Then tap “Install app” again.',
        ],
      };
    }
    if (ios) {
      if (browser === 'safari') {
        return {
          intro: `Add ${appName} to your Home Screen to play it full screen, even offline.`,
          steps: [
            'Tap the Share button (the square with an arrow) in Safari’s toolbar.',
            'Scroll down and tap “Add to Home Screen”.',
            'Tap “Add”. The game now opens full screen from your Home Screen.',
          ],
        };
      }
      return {
        intro: `Add ${appName} to your Home Screen to play it full screen, even offline.`,
        steps: [
          'Tap the Share button (the square with an arrow), next to the address bar or in the ••• menu.',
          'Tap “Add to Home Screen”, then “Add”.',
          'No such option? Your iOS may be older: open this page in Safari and try again.',
        ],
      };
    }
    if (android) {
      if (browser === 'firefox') {
        return {
          intro: `Add ${appName} to your home screen to play it full screen, even offline.`,
          steps: [
            'Tap the menu (⋮) in the top corner.',
            'Tap “Install”.',
            'Confirm. The game now opens full screen from your home screen.',
          ],
        };
      }
      return {
        intro: 'Your browser did not offer a one-tap install, so use its menu instead.',
        steps: [
          'Tap the menu (⋮) in the top corner of the browser.',
          'Tap “Install app” or “Add to Home screen”.',
          'Confirm. The game now opens full screen from your home screen.',
        ],
      };
    }
    if (browser === 'chrome' || browser === 'edge') {
      return {
        intro: 'Your browser did not offer a one-click install, so use its menu instead.',
        steps: [
          'Look for the install icon (a screen with a down arrow) at the right end of the address bar and click it.',
          'Or open the browser menu (⋮ or …) and choose “Install…” under Save and share or Apps.',
          'Click “Install”.',
        ],
      };
    }
    if (browser === 'safari') {
      return {
        intro: `Add ${appName} to your Dock to play it in its own window, even offline.`,
        steps: [
          'Click the Share button in Safari’s toolbar, or open the File menu.',
          'Choose “Add to Dock”.',
          'Click “Add”. This needs Safari 17 or newer.',
        ],
      };
    }
    return {
      intro: 'This browser cannot install web apps.',
      steps: [
        'Open this page in Chrome, Edge or Safari to install it.',
        'You can also just keep playing here: after your first visit the game works offline too.',
      ],
    };
  }

  // ---------- guide dialog ----------
  function openGuide() {
    const guide = guideFor(detect());
    intro.textContent = guide.intro;
    steps.replaceChildren(...guide.steps.map((text) => {
      const li = document.createElement('li');
      li.textContent = text;
      return li;
    }));
    menu.hidden = true;
    sheet.hidden = false;
    closeBtn.focus({ preventScroll: true });
  }

  function closeGuide() {
    if (sheet.hidden) return;
    sheet.hidden = true;
    menu.hidden = false;
    if (!installBtn.hidden) installBtn.focus({ preventScroll: true });
  }

  closeBtn.addEventListener('click', closeGuide);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) closeGuide(); });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && !sheet.hidden) {
      e.preventDefault();
      closeGuide();
    }
  });

  installBtn.addEventListener('click', async () => {
    if (!deferred) {
      openGuide();
      return;
    }
    const prompt = deferred;
    deferred = null; // a prompt event can only be used once
    prompt.prompt();
    try {
      const choice = await prompt.userChoice;
      if (choice.outcome === 'accepted') installBtn.hidden = true;
    } catch { /* dismissed or unavailable */ }
  });
})();
