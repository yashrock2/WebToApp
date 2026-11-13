(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const PKG_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
  const DEFAULT_THEME = '#17243A';
  const STEP_LABELS = [
    'Check your website',
    'Create the signing key',
    'Prepare the app settings',
    'Generate the Android project',
    'Build and sign the app',
    'Write the verification file',
  ];
  const CAPTIONS = {
    web: 'How visitors see your site now.',
    app: 'How your site will open on Android: no browser bar.',
    building: 'Building your app.',
    done: 'Ready for Google Play.',
  };
  const OTHER_FILES = [
    { key: 'assetlinks', label: 'assetlinks.json', note: 'Put this on your website (first step above).' },
    { key: 'apk', label: 'Test app (.apk)', note: 'Install it on an Android phone to try the app before you upload.' },
    { key: 'keystore', label: 'Signing key (android.keystore)', note: 'Keep a private copy. You need it to publish updates.' },
    { key: 'password', label: 'Key password (keystore-password.txt)', note: 'Store it somewhere safe, then delete this file.' },
  ];

  const els = {
    checkForm: $('check-form'), url: $('url'), checkBtn: $('check-btn'), checkError: $('check-error'),
    report: $('report'), reportTitle: $('report-title'), reportList: $('report-list'),
    warnBox: $('report-warnings'), warnList: $('warn-list'),
    buildForm: $('build-form'), appName: $('app-name'), shortName: $('short-name'),
    pkg: $('package-id'), version: $('version'), notifications: $('notifications'),
    buildError: $('build-error'), buildBtn: $('build-btn'),
    progress: $('progress'), progressTitle: $('progress-title'), progressNote: $('progress-note'),
    steps: $('steps'), srStatus: $('sr-status'), progressError: $('progress-error'), retryBtn: $('retry-btn'),
    result: $('result'), resultTitle: $('result-title'), dlAab: $('dl-aab'),
    alUrl: $('al-url'), fp: $('fp'), copyUrl: $('copy-url'), copyFp: $('copy-fp'),
    otherFiles: $('other-files'), againBtn: $('again-btn'),
    phone: $('phone'), pvHost: $('pv-host'), pvName: $('pv-name'), pvMark: $('pv-mark'), pvCaption: $('pv-caption'),
  };

  const state = { checkedUrl: '', jobId: '', pollTimer: 0, tick: 0, startedAt: 0, failures: 0, lastStep: -1, preview: { name: '', theme: DEFAULT_THEME } };

  // ---------- small helpers ----------

  const show = (el, on = true) => { el.hidden = !on; };

  function showMsg(el, text) {
    el.textContent = text;
    show(el, Boolean(text));
  }

  function setBusy(btn, busy, label) {
    btn.disabled = busy;
    btn.textContent = label;
  }

  function normalizeUrl(value) {
    let v = value.trim();
    if (!v) return '';
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = 'https://' + v;
    try {
      return new URL(v).href;
    } catch {
      return '';
    }
  }

  function hostOf(url) {
    try {
      return new URL(url).host;
    } catch {
      return '';
    }
  }

  function onColor(hex) {
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m) return '#FFFFFF';
    const n = parseInt(m[1], 16);
    const lin = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    const lum = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    return lum > 0.4 ? '#111111' : '#FFFFFF';
  }

  async function api(path, body) {
    let res;
    try {
      res = await fetch(path, body
        ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        : undefined);
    } catch {
      throw new Error('Cannot reach the server. Check that it is running, then try again.');
    }
    let data = null;
    try {
      data = await res.json();
    } catch { /* not JSON */ }
    if (!res.ok) throw new Error((data && data.error) || 'Something went wrong. Please try again.');
    return data;
  }

  function focusHeading(el) {
    el.focus({ preventScroll: false });
  }

  // ---------- phone preview ----------

  function setPhone(stateName, opts = {}) {
    const p = els.phone;
    p.dataset.state = stateName;
    if (opts.host !== undefined) els.pvHost.textContent = opts.host || 'yoursite.com';
    if (opts.name !== undefined) state.preview.name = opts.name;
    if (opts.theme) {
      state.preview.theme = opts.theme;
      p.style.setProperty('--pv-theme', opts.theme);
      p.style.setProperty('--pv-on', onColor(opts.theme));
    }
    if (opts.progress !== undefined) p.style.setProperty('--progress', opts.progress + '%');
    const name = state.preview.name || 'Your app';
    els.pvName.textContent = name;
    els.pvMark.textContent = stateName === 'done' ? '\u2713' : (name.trim()[0] || 'A').toUpperCase();
    els.pvCaption.textContent = CAPTIONS[stateName];
  }

  function resetPhone() {
    state.preview = { name: '', theme: DEFAULT_THEME };
    els.phone.style.removeProperty('--pv-theme');
    els.phone.style.removeProperty('--pv-on');
    els.phone.style.setProperty('--progress', '0%');
    setPhone('web', { host: hostOf(normalizeUrl(els.url.value)) });
  }

  // ---------- flow control ----------

  function stopTimers() {
    clearTimeout(state.pollTimer);
    clearInterval(state.tick);
    state.pollTimer = 0;
    state.tick = 0;
  }

  /** Hides everything below the address box. */
  function clearResults() {
    stopTimers();
    state.checkedUrl = '';
    state.jobId = '';
    [els.report, els.buildForm, els.progress, els.result].forEach((s) => show(s, false));
    showMsg(els.checkError, '');
    showMsg(els.buildError, '');
    showMsg(els.progressError, '');
    show(els.retryBtn, false);
    show(els.checkForm, true);
    resetPhone();
  }

  function addItem(list, className, text) {
    const li = document.createElement('li');
    if (className) li.className = className;
    li.textContent = text;
    list.appendChild(li);
  }

  function renderReport(r, url) {
    els.reportList.replaceChildren();
    els.warnList.replaceChildren();
    const warnings = r.warnings || [];
    warnings.forEach((w) => addItem(els.warnList, '', w));
    show(els.warnBox, warnings.length > 0);

    if (r.ok) {
      els.reportTitle.textContent = 'Your site is ready to become an app.';
      ['Loads over HTTPS', 'Has a web app manifest', 'Has a 512 by 512 icon'].forEach((t) => addItem(els.reportList, 'ok', t));
      els.appName.value = r.suggested.name;
      els.shortName.value = r.suggested.shortName;
      els.pkg.value = r.suggested.packageId;
      els.pkg.removeAttribute('aria-invalid');
      show(els.buildForm, true);
      setPhone('app', { host: r.host, name: r.suggested.name, theme: r.themeColor || DEFAULT_THEME });
    } else {
      els.reportTitle.textContent = 'This site needs a fix first.';
      (r.errors || []).forEach((e) => addItem(els.reportList, 'bad', e));
      show(els.buildForm, false);
      setPhone('web', { host: hostOf(url) });
    }
    show(els.report, true);
    focusHeading(els.reportTitle);
  }

  // ---------- check ----------

  els.url.addEventListener('input', () => {
    const url = normalizeUrl(els.url.value);
    if (state.checkedUrl && url !== state.checkedUrl) {
      clearResults();
    } else if (!state.checkedUrl) {
      setPhone('web', { host: hostOf(url) });
    }
  });

  els.checkForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = normalizeUrl(els.url.value);
    clearResults();
    if (!url) {
      showMsg(els.checkError, 'Enter your website address, like https://yourshop.com.');
      els.url.focus();
      return;
    }
    els.url.value = url;
    setPhone('web', { host: hostOf(url) });
    setBusy(els.checkBtn, true, 'Checking\u2026');
    try {
      const r = await api('/api/check', { url });
      state.checkedUrl = url;
      renderReport(r, url);
    } catch (err) {
      showMsg(els.checkError, err.message);
    } finally {
      setBusy(els.checkBtn, false, 'Check my website');
    }
  });

  // ---------- build ----------

  els.pkg.addEventListener('input', () => {
    if (PKG_RE.test(els.pkg.value.trim())) els.pkg.removeAttribute('aria-invalid');
  });

  els.appName.addEventListener('input', () => {
    if (els.phone.dataset.state === 'app') setPhone('app', { name: els.appName.value.trim() });
  });

  function formError(message, field) {
    field.setAttribute('aria-invalid', 'true');
    showMsg(els.buildError, message);
    field.focus();
  }

  els.buildForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    showMsg(els.buildError, '');
    [els.appName, els.shortName, els.pkg, els.version].forEach((f) => f.removeAttribute('aria-invalid'));

    const name = els.appName.value.trim();
    const shortName = els.shortName.value.trim();
    const packageId = els.pkg.value.trim();
    const versionCode = Number(els.version.value);
    if (!name) return formError('Enter an app name.', els.appName);
    if (!shortName || shortName.length > 12) return formError('The name under the icon must be 1 to 12 characters.', els.shortName);
    if (!PKG_RE.test(packageId)) {
      return formError('The app ID needs lowercase letters, numbers and underscores, with at least one dot, like com.mycompany.myapp.', els.pkg);
    }
    if (!Number.isInteger(versionCode) || versionCode < 1) return formError('The version number must be a whole number of 1 or more.', els.version);

    setBusy(els.buildBtn, true, 'Starting\u2026');
    try {
      const job = await api('/api/build', {
        url: state.checkedUrl, name, shortName, packageId, versionCode,
        notifications: els.notifications.checked,
      });
      startProgress(job.id, name);
    } catch (err) {
      showMsg(els.buildError, err.message);
    } finally {
      setBusy(els.buildBtn, false, 'Build my app');
    }
  });

  function startProgress(id, name) {
    state.jobId = id;
    state.failures = 0;
    state.lastStep = -1;
    state.startedAt = Date.now();
    [els.checkForm, els.report, els.buildForm, els.result].forEach((s) => show(s, false));
    showMsg(els.progressError, '');
    show(els.retryBtn, false);
    renderSteps(0, 'todo');
    updateNote('');
    show(els.progress, true);
    setPhone('building', { name, progress: 0 });
    focusHeading(els.progressTitle);
    state.tick = setInterval(() => updateNote(state.queueNote || ''), 1000);
    poll();
  }

  function renderSteps(current, mode) {
    els.steps.replaceChildren();
    STEP_LABELS.forEach((label, i) => {
      const n = i + 1;
      const li = document.createElement('li');
      let cls = 'todo';
      let prefix = '';
      if (mode === 'done' || n < current) { cls = 'done'; prefix = 'Done: '; }
      else if (n === current) {
        cls = mode === 'failed' ? 'failed' : 'current';
        prefix = mode === 'failed' ? 'Failed: ' : 'In progress: ';
        if (mode !== 'failed') li.setAttribute('aria-current', 'step');
      }
      li.className = cls;
      if (prefix) {
        const sr = document.createElement('span');
        sr.className = 'sr-only';
        sr.textContent = prefix;
        li.appendChild(sr);
      }
      li.appendChild(document.createTextNode(label));
      els.steps.appendChild(li);
    });
  }

  function updateNote(extra) {
    const s = Math.floor((Date.now() - state.startedAt) / 1000);
    const clock = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    els.progressNote.textContent = (extra ? extra + ' ' : '') + 'Usually 2 to 4 minutes. Keep this tab open. Elapsed ' + clock + '.';
  }

  function currentStep(log) {
    let step = 0;
    (log || []).forEach((line) => {
      const m = /^(\d)\/6/.exec(line);
      if (m) step = Number(m[1]);
    });
    return step;
  }

  async function poll() {
    try {
      const job = await api('/api/build/' + encodeURIComponent(state.jobId));
      state.failures = 0;
      if (job.status === 'done') return finish(job);
      if (job.status === 'failed') return fail(job.error, currentStep(job.log));
      renderJob(job);
    } catch (err) {
      if (/not found|expired/i.test(err.message)) return fail('This build has expired. Please start again.', 0);
      state.failures += 1;
      if (state.failures >= 5) return fail('Lost contact with the server. Check that it is running, then try again.', 0);
    }
    state.pollTimer = setTimeout(poll, 2000);
  }

  function renderJob(job) {
    if (job.status === 'queued') {
      state.queueNote = 'You are number ' + (job.position || 1) + ' in line.';
      renderSteps(0, 'todo');
      setPhone('building', { progress: 0 });
      return;
    }
    state.queueNote = '';
    const step = currentStep(job.log) || 1;
    if (step !== state.lastStep) {
      state.lastStep = step;
      renderSteps(step, 'running');
      els.srStatus.textContent = 'Step ' + step + ' of 6: ' + STEP_LABELS[step - 1];
      setPhone('building', { progress: Math.round(((step - 0.5) / 6) * 100) });
    }
  }

  function fail(message, step) {
    stopTimers();
    renderSteps(step || 0, step ? 'failed' : 'todo');
    showMsg(els.progressError, message || 'The build failed. Please try again later.');
    els.progressNote.textContent = '';
    show(els.retryBtn, true);
    els.retryBtn.focus();
    setPhone('app', {});
  }

  els.retryBtn.addEventListener('click', () => {
    stopTimers();
    show(els.progress, false);
    show(els.checkForm, true);
    show(els.report, true);
    show(els.buildForm, true);
    setPhone('app', {});
    els.appName.focus();
  });

  // ---------- result ----------

  function wireCopy(btn, getText) {
    if (!navigator.clipboard) {
      show(btn, false);
      return;
    }
    const label = btn.textContent;
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(getText());
        btn.textContent = 'Copied';
      } catch {
        btn.textContent = 'Copy failed';
      }
      setTimeout(() => { btn.textContent = label; }, 1600);
    });
  }

  function finish(job) {
    stopTimers();
    const files = new Map((job.files || []).map((f) => [f.key, f]));
    const aab = files.get('aab');
    if (aab) {
      els.dlAab.href = aab.url;
      els.dlAab.setAttribute('download', aab.name);
    }
    const host = (job.result && job.result.host) || '';
    els.alUrl.textContent = 'https://' + host + '/.well-known/assetlinks.json';
    els.fp.textContent = (job.result && job.result.fingerprint) || '';

    els.otherFiles.replaceChildren();
    OTHER_FILES.forEach((info) => {
      const f = files.get(info.key);
      if (!f) return;
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = f.url;
      a.setAttribute('download', f.name);
      a.textContent = info.label;
      const note = document.createElement('span');
      note.textContent = info.note;
      li.append(a, note);
      els.otherFiles.appendChild(li);
    });

    show(els.progress, false);
    show(els.result, true);
    setPhone('done', { progress: 100 });
    focusHeading(els.resultTitle);
  }

  wireCopy(els.copyUrl, () => els.alUrl.textContent);
  wireCopy(els.copyFp, () => els.fp.textContent);

  els.againBtn.addEventListener('click', () => {
    els.url.value = '';
    clearResults();
    els.url.focus();
  });

  resetPhone();
})();