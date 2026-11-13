#!/usr/bin/env node
'use strict';

/**
 * build.cjs - turn a live website URL into a Play Store-ready TWA (AAB).
 *
 * As a command:
 *   node build.cjs --url=https://example.com [--name="My App"] [--package=com.example.app]
 *
 * As a library (used by server.cjs):
 *   const { buildApp, checkSite } = require('./build.cjs');
 *
 * Needs: Node 18+, and Bubblewrap set up once (npx @bubblewrap/cli doctor).
 *
 * Safety rules baked in:
 *  - user input only ever goes into JSON files, never into a shell command
 *  - the keystore password is redacted from all output
 *  - the website checker refuses private/internal addresses (SSRF protection),
 *    including after redirects and for the icon Bubblewrap will download
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const MIN_SDK = 24; // androidbrowserhelper needs 24+, Bubblewrap's template says 21
const COUNTRY = 'IN';
const BUBBLEWRAP_TIMEOUT_MS = 20 * 60 * 1000;

// ---------- errors ----------

/** userFacing=true means the message is safe and useful to show to end users. */
class BuildError extends Error {
  constructor(message, userFacing = false) {
    super(message);
    this.name = 'BuildError';
    this.userFacing = userFacing;
  }
}
function fail(msg) {
  throw new BuildError(msg, false);
}
function failUser(msg) {
  throw new BuildError(msg, true);
}

// ---------- small helpers ----------

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = /^--([a-zA-Z-]+)(?:=(.*))?$/.exec(arg);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

function derivePackageId(host) {
  const parts = host
    .toLowerCase()
    .split(':')[0]
    .split('.')
    .reverse()
    .map((p) => {
      let s = p.replace(/[^a-z0-9_]/g, '_');
      if (!/^[a-z]/.test(s)) s = 'x' + s;
      return s;
    });
  return parts.join('.') + '.twa';
}

function isValidPackageId(id) {
  return typeof id === 'string' && id.length <= 150 && /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(id);
}

function normalizeColor(value, fallback) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim())
    ? value.trim().toUpperCase()
    : fallback;
}

function cleanDnPart(s) {
  return String(s).replace(/[,=+<>#;"\\\r\n]/g, ' ').trim().slice(0, 60) || 'App';
}

function maxIconSize(sizes) {
  if (typeof sizes !== 'string') return 0;
  let max = 0;
  for (const token of sizes.split(/\s+/)) {
    const m = /^(\d+)x(\d+)$/.exec(token);
    if (m) max = Math.max(max, Math.min(Number(m[1]), Number(m[2])));
  }
  return max;
}

// ---------- SSRF protection ----------

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) ||           // link-local, cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224                               // multicast + reserved
    );
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return true;
    if (l.startsWith('fc') || l.startsWith('fd')) return true; // unique local
    if (/^fe[89ab]/.test(l)) return true;                      // link-local
    const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l);    // IPv4-mapped
    if (dotted) return isPrivateIp(dotted[1]);
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(l);
    if (hex) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      return isPrivateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return false;
  }
  return true; // not an IP at all: treat as unsafe
}

async function assertPublicHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('That address is not allowed.');
    return;
  }
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw new Error(`Could not find the website "${host}".`);
  }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error('That address is not allowed.');
  }
}

async function readLimited(res, maxBytes) {
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('The response was too large.');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** fetch() that only talks to public https hosts, re-checks every redirect, and caps the size. */
async function safeFetch(startUrl, { allowPrivate = false, maxBytes = 1000000, maxRedirects = 5 } = {}) {
  let current = new URL(startUrl);
  for (let i = 0; i <= maxRedirects; i++) {
    if (current.protocol !== 'https:') throw new Error('Only https:// addresses are allowed.');
    if (!allowPrivate) await assertPublicHost(current.hostname);
    const res = await fetch(current.href, {
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
      headers: { 'user-agent': 'webtoapp-builder/0.1' },
    });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current);
      continue;
    }
    if (!res.ok) throw new Error(`${current.href} returned HTTP ${res.status}`);
    return { text: await readLimited(res, maxBytes), finalUrl: current.href };
  }
  throw new Error('Too many redirects.');
}

// ---------- website checker ----------

function findManifestUrl(html, baseUrl) {
  const tags = html.match(/<link\b[^>]*>/gi) || [];
  for (const tag of tags) {
    if (!/\brel\s*=\s*["']?[^"'>]*\bmanifest\b/i.test(tag)) continue;
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const value = href && (href[1] || href[2] || href[3]);
    if (value) return new URL(value, baseUrl).href;
  }
  return null;
}

function pickIcon(manifest, manifestUrl) {
  const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
  let best = null;
  for (const icon of icons) {
    if (!icon || !icon.src) continue;
    const purposes = String(icon.purpose || 'any').split(/\s+/);
    if (!purposes.includes('any')) continue;
    const type = String(icon.type || '').toLowerCase();
    if (type && type !== 'image/png') continue;
    const size = maxIconSize(icon.sizes);
    if (size < 512) continue;
    if (!best || size < best.size) best = { size, src: icon.src };
  }
  if (!best) return null;
  try {
    return new URL(best.src, manifestUrl).href;
  } catch {
    return null;
  }
}

async function checkSite(siteUrl, { allowPrivate = false } = {}) {
  const errors = [];
  const warnings = [];
  let url;
  try {
    url = new URL(String(siteUrl));
  } catch {
    return { ok: false, errors: ['That is not a valid URL.'], warnings };
  }
  if (url.protocol !== 'https:') return { ok: false, errors: ['The site must use HTTPS.'], warnings };

  let page;
  try {
    page = await safeFetch(url.href, { allowPrivate });
  } catch (e) {
    return { ok: false, errors: ['Could not load the site: ' + e.message], warnings };
  }
  const origin = new URL(page.finalUrl).origin;

  if (!/<meta[^>]+name=["']viewport["']/i.test(page.text)) {
    warnings.push('No viewport meta tag. The app may look zoomed out on phones.');
  }

  let manifestUrl;
  try {
    manifestUrl = findManifestUrl(page.text, page.finalUrl);
  } catch {
    manifestUrl = null;
  }
  if (!manifestUrl) {
    errors.push('No web manifest found. Add <link rel="manifest" href="/manifest.webmanifest"> to the page.');
    return { ok: false, errors, warnings };
  }

  let manifest;
  try {
    manifest = JSON.parse((await safeFetch(manifestUrl, { allowPrivate })).text);
  } catch (e) {
    errors.push('The web manifest could not be loaded or is not valid JSON: ' + e.message);
    return { ok: false, errors, warnings };
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    errors.push('The web manifest is not a JSON object.');
    return { ok: false, errors, warnings };
  }

  const iconUrl = pickIcon(manifest, manifestUrl);
  if (!iconUrl) {
    errors.push('The manifest needs a PNG icon of at least 512x512 (purpose "any").');
  } else {
    // Bubblewrap downloads this icon from our build machine, so it must be a safe address too.
    try {
      const iu = new URL(iconUrl);
      if (iu.protocol !== 'https:') throw new Error('The icon must use https.');
      if (!allowPrivate) await assertPublicHost(iu.hostname);
    } catch (e) {
      errors.push('The icon address is not allowed: ' + e.message);
    }
  }
  if (manifest.display && manifest.display !== 'standalone' && manifest.display !== 'fullscreen') {
    warnings.push(`Manifest display is "${manifest.display}". "standalone" is recommended.`);
  }
  if (errors.length) return { ok: false, errors, warnings };

  let startUrl = '/';
  if (manifest.start_url) {
    try {
      const s = new URL(manifest.start_url, manifestUrl);
      if (s.origin === origin) startUrl = s.pathname + s.search;
      else warnings.push('start_url is on a different origin. Using "/" instead.');
    } catch {
      warnings.push('start_url in the manifest is invalid. Using "/".');
    }
  }

  return {
    ok: true,
    errors,
    warnings,
    origin,
    host: new URL(origin).host,
    manifestUrl,
    iconUrl,
    startUrl,
    manifest,
  };
}

// ---------- twa-manifest.json and assetlinks.json ----------

function buildTwaManifest(c) {
  const origin = `https://${c.host}`;
  return {
    packageId: c.packageId,
    host: c.host,
    name: c.name,
    launcherName: c.launcherName,
    display: 'standalone',
    themeColor: c.themeColor,
    themeColorDark: '#000000',
    navigationColor: '#000000',
    navigationColorDark: '#000000',
    navigationDividerColor: '#000000',
    navigationDividerColorDark: '#000000',
    backgroundColor: c.backgroundColor,
    enableNotifications: c.notifications,
    startUrl: c.startUrl,
    iconUrl: c.iconUrl,
    splashScreenFadeOutDuration: 300,
    signingKey: { path: c.keystorePath, alias: c.keyAlias },
    appVersionName: c.versionName,
    appVersionCode: c.versionCode,
    shortcuts: [],
    generatorApp: 'bubblewrap-cli',
    webManifestUrl: c.manifestUrl,
    fallbackType: 'customtabs',
    features: {},
    alphaDependencies: { enabled: false },
    enableSiteSettingsShortcut: true,
    isChromeOSOnly: false,
    isMetaQuest: false,
    fullScopeUrl: origin + '/',
    minSdkVersion: MIN_SDK,
    orientation: 'default',
    fingerprints: [],
    additionalTrustedOrigins: [],
    retainedBundles: [],
    protocolHandlers: [],
    fileHandlers: [],
    launchHandlerClientMode: '',
    displayOverride: [],
    appVersion: c.versionName,
  };
}

function buildAssetLinks(packageId, fingerprints) {
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: packageId,
        sha256_cert_fingerprints: fingerprints,
      },
    },
  ];
}

// ---------- tools: keytool + bubblewrap ----------

function findKeytool() {
  const cfgPath = path.join(os.homedir(), '.bubblewrap', 'config.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (cfg.jdkPath) {
      const exe = process.platform === 'win32' ? 'keytool.exe' : 'keytool';
      const p = path.join(cfg.jdkPath, 'bin', exe);
      if (fs.existsSync(p)) return p;
    }
  } catch {
    /* fall through */
  }
  return 'keytool'; // hope it is on PATH
}

function makeRedactor(secret) {
  return (text) => (secret ? String(text).split(secret).join('***') : String(text));
}

function createKeystore({ keytool, keystorePath, alias, password, dname, redact }) {
  const args = [
    '-genkeypair', '-keystore', keystorePath, '-alias', alias,
    '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
    '-storepass', password, '-keypass', password, '-dname', dname,
  ];
  const r = spawnSync(keytool, args, { encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    fail('keytool could not create the signing key:\n' + redact((r.stderr || '') + (r.stdout || '') + (r.error ? r.error.message : '')));
  }
}

function readFingerprint({ keytool, keystorePath, alias, password, redact }) {
  const r = spawnSync(keytool, ['-list', '-v', '-keystore', keystorePath, '-alias', alias, '-storepass', password], { encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    fail('keytool could not read the key:\n' + redact((r.stderr || '') + (r.error ? r.error.message : '')));
  }
  const m = /SHA256:\s*((?:[0-9A-F]{2}:){31}[0-9A-F]{2})/i.exec(r.stdout);
  if (!m) fail('Could not find a SHA-256 fingerprint in the keytool output.');
  return m[1].toUpperCase();
}

/** Runs bubblewrap without blocking the event loop, so a server stays responsive during builds. */
function runBubblewrap(args, { cwd, env, redact, timeoutMs = BUBBLEWRAP_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    // shell:true is needed for npx on Windows. Args here are fixed strings, never user input.
    const child = spawn('npx', ['@bubblewrap/cli', ...args], {
      cwd,
      env: { ...process.env, ...env },
      shell: true,
    });
    let out = '';
    let timedOut = false;
    const cap = 5 * 1024 * 1024;
    const onData = (d) => {
      out += d.toString();
      if (out.length > cap) out = out.slice(-cap);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new BuildError(`Could not start bubblewrap: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const output = redact(out);
      if (code === 0 && !timedOut) return resolve(output);
      const tail = output.split('\n').slice(-40).join('\n'); // Gradle traces are huge, keep the end
      const why = timedOut ? 'timed out' : 'failed';
      reject(new BuildError(`"bubblewrap ${args[0]}" ${why}:\n${tail}`));
    });
  });
}

// ---------- the main job ----------

/**
 * Builds a signed AAB for a live website.
 * options: { url, name?, shortName?, packageId?, versionCode?, notifications?, outDir?, allowPrivate? }
 * log: function(message) called with progress lines.
 * Throws BuildError. When error.userFacing is true the message is safe to show to users.
 */
async function buildApp(options, log = () => {}) {
  const site = await (async () => {
    log('1/6 Checking the website...');
    return checkSite(options.url, { allowPrivate: Boolean(options.allowPrivate) });
  })();
  site.warnings.forEach((w) => log('   warning: ' + w));
  if (!site.ok) {
    failUser(site.errors.join(' '));
  }
  log(`   OK: ${site.host}`);

  const m = site.manifest;
  const name = String(options.name || m.name || m.short_name || site.host).slice(0, 50);
  const launcherName = String(options.shortName || m.short_name || name).slice(0, 12);
  const packageId = String(options.packageId || derivePackageId(site.host));
  if (!isValidPackageId(packageId)) {
    failUser(`"${packageId}" is not a valid package ID. Use lowercase letters, numbers and underscores, with at least two dot-separated parts (e.g. com.mycompany.myapp).`);
  }
  const versionCode = Number.parseInt(String(options.versionCode ?? '1'), 10);
  if (!Number.isInteger(versionCode) || versionCode < 1 || versionCode > 2100000000) {
    failUser('The version code must be a whole number of 1 or more.');
  }

  const slug = site.host.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const buildDir = path.resolve(options.outDir || path.join(__dirname, 'builds', `${slug}-${Date.now()}`));
  fs.mkdirSync(buildDir, { recursive: true });

  const password = crypto.randomBytes(18).toString('base64url');
  const redact = makeRedactor(password);
  const keytool = findKeytool();
  const keystorePath = path.join(buildDir, 'android.keystore');
  const keyAlias = 'android';

  log('2/6 Creating the signing key...');
  createKeystore({
    keytool, keystorePath, alias: keyAlias, password, redact,
    dname: `CN=${cleanDnPart(name)}, OU=TWA, O=${cleanDnPart(site.host)}, C=${COUNTRY}`,
  });
  const fingerprint = readFingerprint({ keytool, keystorePath, alias: keyAlias, password, redact });

  log('3/6 Writing twa-manifest.json...');
  const twa = buildTwaManifest({
    packageId, host: site.host, name, launcherName,
    themeColor: normalizeColor(m.theme_color, '#FFFFFF'),
    backgroundColor: normalizeColor(m.background_color, '#FFFFFF'),
    notifications: Boolean(options.notifications),
    startUrl: site.startUrl, iconUrl: site.iconUrl, manifestUrl: site.manifestUrl,
    keystorePath, keyAlias, versionName: String(versionCode), versionCode,
  });
  fs.writeFileSync(path.join(buildDir, 'twa-manifest.json'), JSON.stringify(twa, null, 2));

  log('4/6 Generating the Android project (first run downloads files)...');
  await runBubblewrap(['update', '--skipVersionUpgrade'], { cwd: buildDir, env: {}, redact });

  const gradlePath = path.join(buildDir, 'app', 'build.gradle');
  if (fs.existsSync(gradlePath)) {
    const sdk = /minSdk(?:Version)?\s*=?\s*(\d+)/.exec(fs.readFileSync(gradlePath, 'utf8'));
    if (sdk && Number(sdk[1]) < MIN_SDK) {
      fail(`The generated project still targets minSdk ${sdk[1]}. It needs ${MIN_SDK}+. Check twa-manifest.json.`);
    }
  }

  log('5/6 Building and signing (this can take a few minutes)...');
  await runBubblewrap(['build'], {
    cwd: buildDir,
    env: { BUBBLEWRAP_KEYSTORE_PASSWORD: password, BUBBLEWRAP_KEY_PASSWORD: password },
    redact,
  });

  const aab = path.join(buildDir, 'app-release-bundle.aab');
  const apk = path.join(buildDir, 'app-release-signed.apk');
  if (!fs.existsSync(aab)) fail('The build finished but no .aab file was produced.');

  log('6/6 Writing assetlinks.json...');
  const assetLinks = path.join(buildDir, 'assetlinks.json');
  fs.writeFileSync(assetLinks, JSON.stringify(buildAssetLinks(packageId, [fingerprint]), null, 2));
  const passwordFile = path.join(buildDir, 'keystore-password.txt');
  fs.writeFileSync(passwordFile, password + '\n');

  return {
    buildDir, packageId, host: site.host, fingerprint, warnings: site.warnings,
    files: { aab, apk, assetLinks, keystore: keystorePath, passwordFile },
  };
}

// ---------- command line ----------

async function cli() {
  const args = parseArgs(process.argv.slice(2));
  const str = (v) => (typeof v === 'string' ? v : undefined);
  if (!str(args.url)) {
    console.error('ERROR: Missing --url. Example: node build.cjs --url=https://example.com --name="My App"');
    process.exit(1);
  }
  if (Number(process.versions.node.split('.')[0]) < 18) {
    console.error('ERROR: Node 18 or newer is required.');
    process.exit(1);
  }
  try {
    const r = await buildApp(
      {
        url: str(args.url), name: str(args.name), shortName: str(args['short-name']),
        packageId: str(args.package), versionCode: str(args['version-code']),
        notifications: Boolean(args.notifications), outDir: str(args.out),
      },
      console.log,
    );
    console.log(`
Done. Files are in:
  ${r.buildDir}

  app-release-bundle.aab   upload this to Google Play Console
  app-release-signed.apk   for testing on an Android phone
  assetlinks.json          host at https://${r.host}/.well-known/assetlinks.json
  android.keystore         your signing key. Back it up. Without it you cannot update the app.
  keystore-password.txt    the key password. Store it safely, then delete this file.

If you use Play App Signing, Google re-signs the app. After the first upload, add the
"App signing key" SHA-256 from Play Console (App integrity) to assetlinks.json as a second fingerprint.
`);
  } catch (e) {
    console.error('\nERROR: ' + (e instanceof BuildError ? e.message : e && e.stack ? e.stack : String(e)));
    process.exit(1);
  }
}

module.exports = {
  buildApp, checkSite, BuildError, derivePackageId, isValidPackageId, findManifestUrl, pickIcon,
  buildTwaManifest, buildAssetLinks, normalizeColor, maxIconSize, createKeystore, readFingerprint,
  makeRedactor, isPrivateIp, assertPublicHost, safeFetch,
};

if (require.main === module) cli();