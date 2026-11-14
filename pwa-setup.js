(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  // Opened through Live Server (port 5500)? Talk to the API on port 3000.
  // Opened from the WebToApp server itself (port 3000)? Use same-origin requests.
  const API_BASE_URL = window.location.port === '3000' ? '' : 'http://127.0.0.1:3000';
  const RESULT_KEY = 'webtoapp:pwaResult';
  const saved = sessionStorage.getItem('webtoapp:pwaSetup');

  const els = {
    siteLabel: $('pwa-site-label'),
    form: $('pwa-form'),
    name: $('pwa-name'),
    shortName: $('pwa-short-name'),
    description: $('pwa-description'),
    display: $('pwa-display'),
    theme: $('pwa-theme'),
    background: $('pwa-background'),
    logo: $('pwa-logo'),
    logoName: $('pwa-logo-name'),
    serviceWorker: $('pwa-service-worker'),
    error: $('pwa-error'),
    generate: $('pwa-generate-btn'),
    result: $('pwa-result'),
    download: $('pwa-download'),
    downloadUrl: $('pwa-download-url'),
    meta: $('pwa-package-meta'),
    resultTitle: $('pwa-result-title'),
    rescan: $('pwa-rescan-link'),
    copyLink: $('pwa-copy-link'),
  };

  const showMessage = (message) => {
    if (!els.error) return;

    els.error.textContent = message;
    els.error.hidden = !message;
  };

  const setBusy = (busy) => {
    if (!els.generate) return;

    els.generate.disabled = busy;
    els.generate.textContent = busy
      ? 'Generating package…'
      : 'Generate PWA setup ZIP';
  };

  if (!saved) {
    window.location.replace('index.html');
    return;
  }

  let setup;

  try {
    setup = JSON.parse(saved);
  } catch {
    setup = null;
  }

  if (!setup || !setup.url || !setup.scan || !setup.scan.ok) {
    sessionStorage.removeItem('webtoapp:pwaSetup');
    window.location.replace('index.html');
    return;
  }

  const website = setup.scan.website || {};
  const detectedName =
    website.appName ||
    website.title ||
    new URL(setup.url).hostname;

  els.siteLabel.textContent = setup.url;
  els.name.value = detectedName.slice(0, 50);
  els.shortName.value = detectedName.slice(0, 12);
  els.description.value = `${detectedName} application`.slice(0, 300);

  els.theme.value = /^#[0-9a-f]{6}$/i.test(website.themeColor || '')
    ? website.themeColor
    : '#17243A';

  els.background.value = /^#[0-9a-f]{6}$/i.test(website.backgroundColor || '')
    ? website.backgroundColor
    : '#ffffff';

  // App logo selection
  els.logo.addEventListener('change', () => {
    const file = els.logo.files && els.logo.files[0];

    els.logoName.textContent = file
      ? `${file.name} · ${(file.size / 1024).toFixed(1)} KB`
      : 'No logo selected.';
  });

  // Read uploaded logo
  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = () => resolve(String(reader.result || ''));

      reader.onerror = () => {
        reject(new Error('Could not read the selected logo.'));
      };

      reader.readAsDataURL(file);
    });
  }

  // Backend API request
  async function api(path, body) {
    let response;

    try {
      response = await fetch(`${API_BASE_URL}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error(
        'Cannot reach the backend server. Make sure node server.cjs is running.'
      );
    }

    let data;

    try {
      data = await response.json();
    } catch {
      throw new Error(
        `The server returned an unreadable response (HTTP ${response.status}).`
      );
    }

    if (!response.ok) {
      throw new Error(
        (data && data.error) ||
        `Request failed with status ${response.status}`
      );
    }

    return data;
  }

  // Display download section BELOW the existing configuration form
  function revealPackageResult(result, { scroll = true } = {}) {
    if (!result || result.status !== 'done' || !result.downloadUrl) {
      throw new Error(
        'The package was created, but the server did not return a download link.'
      );
    }

    const downloadUrl = new URL(
      result.downloadUrl,
      API_BASE_URL || window.location.origin
    ).href;

    const filename = result.filename || 'WebToApp-PWA-Setup.zip';

    // Set download button URL
    els.download.href = downloadUrl;
    els.download.setAttribute('download', filename);

    // Set direct download link
    els.downloadUrl.href = downloadUrl;
    els.downloadUrl.textContent = downloadUrl;

    // Package information
    els.meta.textContent =
      `${filename} · ${Number(result.sizeKB || 0).toFixed(2)} KB · ${(result.files || []).length} files`;

    // IMPORTANT:
    // Keep the PWA configuration form visible.
    // Only reveal the download section underneath it.
    els.result.hidden = false;

    els.result.setAttribute('aria-live', 'polite');

    // Scroll down to the newly displayed download section
    if (scroll) {
      requestAnimationFrame(() => {
        els.result.scrollIntoView({
          behavior: 'smooth',
          block: 'start',
        });
      });
    }
  }

  // Remember the generated package, so the download section is still there
  // if the page reloads (Live Server reloads on every file change in the project).
  function saveResult(result) {
    try {
      sessionStorage.setItem(RESULT_KEY, JSON.stringify({ url: setup.url, result }));
    } catch { /* storage unavailable: nothing to do */ }
  }

  async function restoreResult() {
    let stored = null;
    try {
      stored = JSON.parse(sessionStorage.getItem(RESULT_KEY) || 'null');
    } catch { /* ignore */ }
    if (!stored || stored.url !== setup.url || !stored.result) return;

    try {
      const link = new URL(stored.result.downloadUrl, API_BASE_URL || window.location.origin).href;
      const res = await fetch(link, { method: 'HEAD' });
      if (res.status === 404) {
        // The server no longer has this package (it expired or the server restarted).
        sessionStorage.removeItem(RESULT_KEY);
        return;
      }
    } catch { /* server not reachable: still show the saved link */ }

    revealPackageResult(stored.result, { scroll: false });
  }

  // Generate PWA package
  els.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    event.stopPropagation();

    showMessage('');

    const logo = els.logo.files && els.logo.files[0];

    if (!logo) {
      showMessage('Choose your app logo before generating the package.');
      els.logo.focus();
      return;
    }

    if (!['image/png', 'image/jpeg', 'image/webp'].includes(logo.type)) {
      showMessage('Use a PNG, JPEG or WebP image.');
      els.logo.focus();
      return;
    }

    if (logo.size > 5 * 1024 * 1024) {
      showMessage('Your logo must be 5 MB or smaller.');
      els.logo.focus();
      return;
    }

    const name = els.name.value.trim();
    const shortName = els.shortName.value.trim();

    if (!name || name.length > 50) {
      showMessage('Enter an app name between 1 and 50 characters.');
      els.name.focus();
      return;
    }

    if (!shortName || shortName.length > 12) {
      showMessage('Enter a short name between 1 and 12 characters.');
      els.shortName.focus();
      return;
    }

    setBusy(true);

    try {
      const iconBase64 = await readFileAsDataUrl(logo);

      const result = await api('/api/pwa/package', {
        url: setup.url,

        settings: {
          name,
          shortName,
          description: els.description.value.trim(),
          display: els.display.value,
          themeColor: els.theme.value,
          backgroundColor: els.background.value,
        },

        iconBase64,

        includeServiceWorker: els.serviceWorker.checked,
      });

      // Automatically show the download section after successful generation
      revealPackageResult(result);
      saveResult(result);

      console.info(
        '[WebToApp] PWA package generated successfully.',
        result
      );

    } catch (error) {
      console.error(
        '[WebToApp] PWA package generation failed:',
        error
      );

      showMessage(
        error.message || 'Could not generate the PWA setup package.'
      );

    } finally {
      setBusy(false);
    }
  });

  // Copy download link
  if (els.copyLink) {
    els.copyLink.addEventListener('click', async () => {
      const link = els.downloadUrl.href;

      if (!link || link === window.location.href) return;

      try {
        await navigator.clipboard.writeText(link);
        els.copyLink.textContent = 'Copied!';
      } catch {
        els.copyLink.textContent = 'Copy unavailable';
      }
    });
  }

  // Return to website scanner
  els.rescan.addEventListener('click', () => {
    sessionStorage.removeItem('webtoapp:pwaSetup');
    sessionStorage.removeItem(RESULT_KEY);
  });

  // Bring back the download section after a reload
  restoreResult();

})();