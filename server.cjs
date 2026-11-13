'use strict';

/**
 * server.cjs - HTTP API around build.cjs
 *
 *   POST /api/check               { url }                          -> site report
 *   POST /api/build               { url, name?, packageId?, ... }  -> { id }
 *   GET  /api/build/:id                                            -> status, progress log, files
 *   GET  /api/build/:id/files/:key                                 -> download a file
 *
 * Run:  node server.cjs        (listens on http://127.0.0.1:3000)
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const core = require('./build.cjs');

// Files a user may download. Only these names are ever served.
const FILES = {
  aab: 'app-release-bundle.aab',
  apk: 'app-release-signed.apk',
  assetlinks: 'assetlinks.json',
  keystore: 'android.keystore',
  password: 'keystore-password.txt',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Counts events per IP inside a time window. */
function makeCounter(max, windowMs) {
  const hits = new Map(); // ip -> [timestamps]
  const recent = (ip) => {
    const now = Date.now();
    const list = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    hits.set(ip, list);
    return list;
  };
  return {
    limited: (ip) => recent(ip).length >= max,
    record: (ip) => recent(ip).push(Date.now()),
  };
}

function rateLimiter(max, windowMs) {
  const counter = makeCounter(max, windowMs);
  return (req, res, next) => {
    if (counter.limited(req.ip)) {
      res.status(429).json({ error: 'Too many requests. Please wait a while and try again.' });
      return;
    }
    counter.record(req.ip);
    next();
  };
}

function createApp({
  buildApp = core.buildApp,
  checkSite = core.checkSite,
  buildsDir = path.join(__dirname, 'builds'),
  allowPrivate = false, // tests only. Never enable on a real server.
  maxBuildsPerHour = 5,
  maxChecksPerMinute = 30,
  maxRequestsPerMinute = 120,
  jobTtlMs = 60 * 60 * 1000,
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10kb' }));
  app.use('/api', rateLimiter(maxRequestsPerMinute, 60 * 1000)); // blunt spam on every endpoint
  const buildCounter = makeCounter(maxBuildsPerHour, 60 * 60 * 1000); // counts accepted builds only

  const jobs = new Map();
  const queue = [];
  let running = false;

  // ----- the build queue: one build at a time, builds are heavy -----
  async function pump() {
    if (running) return;
    const job = queue.shift();
    if (!job) return;
    running = true;
    job.status = 'building';
    try {
      const result = await buildApp(
        { ...job.options, outDir: path.join(buildsDir, job.id), allowPrivate },
        (line) => job.log.push(line),
      );
      job.files = Object.keys(FILES).filter((k) => fs.existsSync(path.join(result.buildDir, FILES[k])));
      job.result = { packageId: result.packageId, host: result.host, fingerprint: result.fingerprint, warnings: result.warnings };
      job.status = 'done';
    } catch (e) {
      console.error(`[job ${job.id}] failed:`, e && e.message ? e.message : e);
      job.status = 'failed';
      // Only show the message to users when it is safe and useful. Details stay in the server log.
      job.error = e instanceof core.BuildError && e.userFacing
        ? e.message
        : 'The build failed. Please try again later.';
    } finally {
      job.finishedAt = Date.now();
      running = false;
      setImmediate(pump);
    }
  }

  function publicJob(job) {
    return {
      id: job.id,
      status: job.status,
      position: job.status === 'queued' ? queue.indexOf(job) + 1 : undefined,
      log: job.log,
      error: job.error,
      result: job.result,
      files: job.status === 'done'
        ? job.files.map((key) => ({ key, name: FILES[key], url: `/api/build/${job.id}/files/${key}` }))
        : undefined,
    };
  }

  // ----- input validation -----
  function cleanString(v, max) {
    return typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined;
  }

  // ----- routes -----
  app.post('/api/check', rateLimiter(maxChecksPerMinute, 60 * 1000), async (req, res) => {
    const url = cleanString(req.body && req.body.url, 2048);
    if (!url) return res.status(400).json({ error: 'Please enter a website address.' });
    const r = await checkSite(url, { allowPrivate });
    if (!r.ok) return res.json({ ok: false, errors: r.errors, warnings: r.warnings });
    const m = r.manifest;
    res.json({
      ok: true,
      errors: [],
      warnings: r.warnings,
      host: r.host,
      suggested: {
        name: String(m.name || m.short_name || r.host).slice(0, 50),
        shortName: String(m.short_name || m.name || r.host).slice(0, 12),
        packageId: core.derivePackageId(r.host),
      },
    });
  });

  app.post('/api/build', (req, res) => {
    const body = req.body || {};
    const url = cleanString(body.url, 2048);
    if (!url) return res.status(400).json({ error: 'Please enter a website address.' });

    const options = { url };
    if (body.name !== undefined) {
      options.name = cleanString(body.name, 50);
      if (!options.name) return res.status(400).json({ error: 'The app name must be 1 to 50 characters.' });
    }
    if (body.shortName !== undefined) {
      options.shortName = cleanString(body.shortName, 12);
      if (!options.shortName) return res.status(400).json({ error: 'The short name must be 1 to 12 characters.' });
    }
    if (body.packageId !== undefined) {
      if (!core.isValidPackageId(body.packageId)) {
        return res.status(400).json({ error: 'The package ID must look like com.mycompany.myapp (lowercase letters, numbers, underscores).' });
      }
      options.packageId = body.packageId;
    }
    if (body.versionCode !== undefined) {
      const v = Number(body.versionCode);
      if (!Number.isInteger(v) || v < 1 || v > 2100000000) {
        return res.status(400).json({ error: 'The version code must be a whole number of 1 or more.' });
      }
      options.versionCode = v;
    }
    options.notifications = body.notifications === true;

    // Only valid, accepted builds count toward the hourly limit, so typos never lock a user out.
    if (buildCounter.limited(req.ip)) {
      return res.status(429).json({ error: 'You have reached the hourly build limit. Please try again later.' });
    }
    buildCounter.record(req.ip);

    const job = { id: crypto.randomUUID(), status: 'queued', log: [], files: [], options, createdAt: Date.now() };
    jobs.set(job.id, job);
    queue.push(job);
    setImmediate(pump);
    res.status(202).json({ id: job.id, status: job.status });
  });

  app.get('/api/build/:id', (req, res) => {
    const job = UUID.test(req.params.id) ? jobs.get(req.params.id) : null;
    if (!job) return res.status(404).json({ error: 'Build not found. It may have expired.' });
    res.json(publicJob(job));
  });

  app.get('/api/build/:id/files/:key', (req, res) => {
    const job = UUID.test(req.params.id) ? jobs.get(req.params.id) : null;
    if (!job || job.status !== 'done') return res.status(404).json({ error: 'File not found.' });
    const key = req.params.key;
    if (!Object.prototype.hasOwnProperty.call(FILES, key) || !job.files.includes(key)) {
      return res.status(404).json({ error: 'File not found.' });
    }
    const filePath = path.join(buildsDir, job.id, FILES[key]);
    res.download(filePath, FILES[key]);
  });

  // ----- errors -----
  app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status && err.status < 500 ? err.status : 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status < 500 ? 'Invalid request.' : 'Server error.' });
  });

  // ----- delete old builds (they contain signing keys) -----
  const cleaner = setInterval(() => {
    const now = Date.now();
    for (const [id, job] of jobs) {
      if (job.finishedAt && now - job.finishedAt > jobTtlMs) {
        jobs.delete(id);
        fs.rm(path.join(buildsDir, id), { recursive: true, force: true }, () => {});
      }
    }
  }, 10 * 60 * 1000);
  cleaner.unref();
  app.locals.stop = () => clearInterval(cleaner);

  return app;
}

module.exports = { createApp, FILES };

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, '127.0.0.1', () => {
    console.log(`API running at http://127.0.0.1:${port}`);
  });
}