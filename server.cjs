
'use strict';

/**
 * server.cjs - HTTP API around build.cjs and PWA preparation.
 *
 * Existing Android endpoints:
 *   POST /api/check
 *   POST /api/build
 *   GET  /api/build/:id
 *   GET  /api/build/:id/files/:key
 *
 * PWA endpoints:
 *   POST /api/pwa/scan
 *   POST /api/pwa/package
 *   GET  /api/pwa/package/:id
 *   GET  /api/pwa/package/:id/download
 *
 * Run: node server.cjs
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Load local development variables without overriding values already supplied by the host.
function loadLocalEnv() {
  const envFile = path.join(__dirname, '.env');
  if (!fs.existsSync(envFile)) return;

  for (const line of fs.readFileSync(envFile, 'utf8').split(/\\r?\\n/)) {
    const match = line.match(/^\\s*(?:export\\s+)?([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(.*?)\\s*$/);
    if (!match || Object.prototype.hasOwnProperty.call(process.env, match[1])) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\\s+#.*$/, '');
    }
    process.env[match[1]] = value;
  }
}
loadLocalEnv();

const core = require('./build.cjs');
const db = require('./storage/database.cjs');
const { createSigningKey, getSigningKey, hasSigningKey } = require('./storage/signing-key-manager.cjs');

const { scanWebsite } = require('./pwa/scanner.cjs');
const { generateManifest } = require('./pwa/manifest-generator.cjs');
const { generateAppIcons } = require('./pwa/icon-generator.cjs');
const { generatePwaPackage } = require('./pwa/package-generator.cjs');
const { registerGitHubRoutes } = require('./integrations/github.cjs');

// Files a user may download. Only these names are ever served.
const FILES = {
  aab: 'app-release-bundle.aab',
  apk: 'app-release-signed.apk',
  assetlinks: 'assetlinks.json',
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const PWA_PACKAGE_FILENAME = 'WebToApp-PWA-Setup.zip';

/** Counts events per IP inside a time window. */
function makeCounter(max, windowMs) {
  const hits = new Map();

  const recent = (ip) => {
    const now = Date.now();
    const list = (hits.get(ip) || []).filter(
      (timestamp) => now - timestamp < windowMs
    );

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
      return res.status(429).json({
        error: 'Too many requests. Please wait a while and try again.',
      });
    }

    counter.record(req.ip);
    next();
  };
}

function createApp({
  buildApp = core.buildApp,
  checkSite = core.checkSite,
  buildsDir = path.join(__dirname, 'builds'),
  pwaPackagesDir = path.join(__dirname, 'pwa-packages'),
  allowPrivate = false,
  maxBuildsPerHour = 20,
  maxChecksPerMinute = 30,
  maxRequestsPerMinute = 120,
  jobTtlMs = 60 * 60 * 1000,
} = {}) {
  const app = express();

app.disable('x-powered-by');

// Allow requests from the local WebToApp frontend.
const allowedOrigins = [
    'http://127.0.0.1:5500',
    'http://localhost:5500'
];

app.use((req, res, next) => {
    const origin = req.headers.origin;

    if (allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
    }

    res.setHeader(
        'Access-Control-Allow-Methods',
        'GET, POST, OPTIONS'
    );

    res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type'
    );

    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }

    next();
});

app.use(express.json({
    limit: '7mb',
}));

  app.use(
    '/api',
    rateLimiter(maxRequestsPerMinute, 60 * 1000)
  );

  // GitHub App routes share the API rate limiter.
  registerGitHubRoutes(app);

  const buildCounter = makeCounter(
    maxBuildsPerHour,
    60 * 60 * 1000
  );

  const jobs = new Map();
  const pwaPackages = new Map();

  const queue = [];

  let running = false;

  // ----- persistent Android build records -----

  const insertBuildStatement = db.prepare(`
    INSERT INTO builds (
      id, project_id, status, options_json, log_json, files_json,
      result_json, error
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const updateBuildStatement = db.prepare(`
    UPDATE builds
    SET status = ?,
        options_json = ?,
        log_json = ?,
        files_json = ?,
        result_json = ?,
        error = ?,
        updated_at = CURRENT_TIMESTAMP,
        finished_at = CASE
          WHEN ? IS NULL THEN finished_at
          ELSE ?
        END
    WHERE id = ?
  `);

  function persistBuild(job) {
    try {
      const finishedAt = job.finishedAt
        ? new Date(job.finishedAt).toISOString()
        : null;

      updateBuildStatement.run(
        job.status,
        JSON.stringify(job.options || {}),
        JSON.stringify(job.log || []),
        JSON.stringify(job.files || []),
        job.result ? JSON.stringify(job.result) : null,
        job.error || null,
        finishedAt,
        finishedAt,
        job.id
      );
    } catch (error) {
      console.error(`[job ${job.id}] could not persist build update:`, error.message);
    }
  }

  function parseJson(value, fallback) {
    if (value === null || value === undefined) return fallback;
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }

  function jobFromDatabase(row) {
    return {
      id: row.id,
      projectId: row.project_id,
      status: row.status,
      options: parseJson(row.options_json, {}),
      log: parseJson(row.log_json, []),
      files: parseJson(row.files_json, []),
      result: parseJson(row.result_json, null),
      error: row.error || undefined,
      createdAt: row.created_at ? Date.parse(`${row.created_at}Z`) : Date.now(),
      finishedAt: row.finished_at ? Date.parse(`${row.finished_at}Z`) : null,
    };
  }

  // A build interrupted while actively running cannot safely resume Bubblewrap.
  // Keep its history and mark it failed; queued builds can be restored below.
  const interruptedBuildMessage =
    'The server restarted while this build was running. Please start a new build.';

  db.prepare(`
    UPDATE builds
    SET status = 'failed',
        error = ?,
        finished_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE status = 'building'
  `).run(interruptedBuildMessage);

  db.prepare(`
    UPDATE projects
    SET status = 'failed', updated_at = CURRENT_TIMESTAMP
    WHERE id IN (
      SELECT project_id
      FROM builds
      WHERE status = 'failed' AND error = ?
    )
  `).run(interruptedBuildMessage);

  // ----- the Android build queue -----

  async function pump() {
    if (running) return;

    const job = queue.shift();

    if (!job) return;

    running = true;
    job.status = 'building';
    persistBuild(job);

    try {
      // A project owns one permanent signing identity. Generate it once, then reuse it.
      if (!hasSigningKey(job.projectId)) {
        job.log.push('2/6 Creating and securely saving your signing key...');
        persistBuild(job);
        createSigningKey(job.projectId, {
          websiteUrl: job.options.url,
          appName: job.options.name,
        });
      }

      const signingKey = getSigningKey(job.projectId);
      const result = await buildApp(
        {
          ...job.options,
          signingKey,
          outDir: path.join(buildsDir, job.id),
          allowPrivate,
        },
        (line) => {
          job.log.push(line);
          persistBuild(job);
        }
      );

      job.files = Object.keys(FILES).filter((key) =>
        fs.existsSync(
          path.join(result.buildDir, FILES[key])
        )
      );

      job.result = {
        packageId: result.packageId,
        host: result.host,
        fingerprint: result.fingerprint,
        warnings: result.warnings,
      };

      job.status = 'done';
      db.prepare("UPDATE projects SET status = 'built', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(job.projectId);
      persistBuild(job);
    } catch (error) {
      console.error(
        `[job ${job.id}] failed:`,
        error && error.message ? error.message : error
      );

      job.status = 'failed';
      db.prepare("UPDATE projects SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(job.projectId);
      await fs.promises.rm(path.join(buildsDir, job.id), { recursive: true, force: true }).catch(() => {});

      job.error =
        error instanceof core.BuildError && error.userFacing
          ? error.message
          : 'The build failed. Please try again later.';
      persistBuild(job);
    } finally {
      job.finishedAt = Date.now();
      persistBuild(job);
      running = false;

      setImmediate(pump);
    }
  }

  function publicJob(job) {
    return {
      id: job.id,
      projectId: job.projectId,
      status: job.status,
      position:
        job.status === 'queued' && queue.indexOf(job) >= 0
          ? queue.indexOf(job) + 1
          : undefined,
      log: job.log,
      error: job.error,
      result: job.result,

      files:
        job.status === 'done'
          ? job.files.map((key) => ({
              key,
              name: FILES[key],
              url: `/api/build/${job.id}/files/${key}`,
            }))
          : undefined,
    };
  }

  // ----- input validation -----

  function cleanString(value, max) {
    return typeof value === 'string' &&
      value.trim() &&
      value.length <= max
      ? value.trim()
      : undefined;
  }

  function isPlainObject(value) {
    return (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value)
    );
  }

  function validateWebsiteUrl(value) {
    let parsed;

    try {
      parsed = new URL(value);
    } catch {
      throw new Error('Please enter a valid website URL.');
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Only HTTP and HTTPS website URLs are supported.');
    }

    if (parsed.username || parsed.password) {
      throw new Error('Website URLs cannot contain credentials.');
    }

    return parsed;
  }

  function decodeUploadedIcon(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value !== 'string') {
    throw new Error('Uploaded logo must be a Base64 image.');
  }

  let base64 = value.trim();
  let mimeType = '';

  const dataUriMatch = base64.match(
    /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/i
  );

  if (dataUriMatch) {
    mimeType = dataUriMatch[1].toLowerCase();
    base64 = dataUriMatch[2];
  } else if (!/^[A-Za-z0-9+/=\s]+$/.test(base64)) {
    throw new Error(
      'Invalid logo format. Upload a PNG, JPEG, or WebP image.'
    );
  }

  base64 = base64.replace(/\s/g, '');

  if (!base64 || base64.length > 7 * 1024 * 1024) {
    throw new Error('Logo is empty or exceeds the upload limit.');
  }

  const buffer = Buffer.from(base64, 'base64');

  if (
    !buffer.length ||
    buffer.length > 5 * 1024 * 1024 ||
    buffer.toString('base64').replace(/=+$/, '') !==
      base64.replace(/=+$/, '')
  ) {
    throw new Error('Invalid logo or logo exceeds the 5 MB limit.');
  }

  return buffer;
}

  function publicPwaPackage(record) {
    return {
      id: record.id,
      status: record.status,
      filename: record.filename,
      sizeBytes: record.sizeBytes,
      sizeKB: record.sizeKB,
      files: record.files,
      includeServiceWorker: record.includeServiceWorker,
      downloadUrl: `/api/pwa/package/${record.id}/download`,
      createdAt: record.createdAt,
    };
  }

  // ----- PWA scan -----

  app.post(
    '/api/pwa/scan',
    rateLimiter(maxChecksPerMinute, 60 * 1000),
    async (req, res) => {
      const url = cleanString(
        req.body && req.body.url,
        2048
      );

      if (!url) {
        return res.status(400).json({
          error: 'Please enter a website address.',
        });
      }

      try {
        validateWebsiteUrl(url);

        const result = await scanWebsite(url, {
          allowPrivate,
        });

        return res.json(result);
      } catch (error) {
        console.error(
          '[pwa scan] failed:',
          error && error.message ? error.message : error
        );

        return res.status(400).json({
          error:
            error && error.message
              ? error.message
              : 'The website scan failed. Please try again.',
        });
      }
    }
  );

  // ----- PWA package generation -----

  app.post(
    '/api/pwa/package',
    rateLimiter(maxChecksPerMinute, 60 * 1000),
    async (req, res) => {
      const body = req.body || {};

      const url = cleanString(body.url, 2048);

      if (!url) {
        return res.status(400).json({
          error: 'Please enter a website address.',
        });
      }

      let websiteUrl;

      try {
        websiteUrl = validateWebsiteUrl(url);
      } catch (error) {
        return res.status(400).json({
          error: error.message,
        });
      }

      if (websiteUrl.protocol !== 'https:') {
        return res.status(422).json({
          error: 'Your website must use HTTPS before preparing a production PWA package.',
          code: 'HTTPS_REQUIRED',
        });
      }

      const settings = body.settings === undefined
        ? {}
        : body.settings;
        let uploadedIconBuffer;

try {
  uploadedIconBuffer = decodeUploadedIcon(body.iconBase64);
} catch (error) {
  return res.status(400).json({
    error: error.message,
    code: 'INVALID_LOGO',
  });
}

      if (!isPlainObject(settings)) {
        return res.status(400).json({
          error: 'PWA settings must be a valid object.',
        });
      }

      if (
        body.includeServiceWorker !== undefined &&
        typeof body.includeServiceWorker !== 'boolean'
      ) {
        return res.status(400).json({
          error: 'includeServiceWorker must be true or false.',
        });
      }

      const id = crypto.randomUUID();

      const packageDirectory = path.join(
        pwaPackagesDir,
        id
      );

      const includeServiceWorker =
        body.includeServiceWorker === true;

      const record = {
        id,
        status: 'generating',
        filename: PWA_PACKAGE_FILENAME,
        sizeBytes: null,
        sizeKB: null,
        files: [],
        includeServiceWorker,
        createdAt: Date.now(),
        finishedAt: null,
        error: null,
      };

      pwaPackages.set(id, record);

      try {
        await fs.promises.mkdir(packageDirectory, {
          recursive: true,
        });

        // 1. Scan the website.
        const scanResult = await scanWebsite(
          websiteUrl.href,
          { allowPrivate }
        );

        if (!scanResult || scanResult.ok === false) {
          const error = new Error(
            'The website could not be scanned successfully.'
          );

          error.statusCode = 422;
          throw error;
        }

        if (
          scanResult.status === 'needs_https' ||
          scanResult.checks?.https?.passed === false
        ) {
          const error = new Error(
            'HTTPS is required before generating a production PWA package.'
          );

          error.statusCode = 422;
          throw error;
        }

        // 2. Generate application icons.
        const iconResult = await generateAppIcons({
  siteUrl: websiteUrl.href,
  scanResult,
  outputDir: packageDirectory,
  uploadedIconBuffer,
  allowPrivate,
});

        if (!iconResult || iconResult.success !== true) {
          throw new Error(
            'Application icon generation failed.'
          );
        }

        // 3. Generate manifest using the generated icons.
        const manifestResult = generateManifest({
          siteUrl: websiteUrl.href,
          website: scanResult.website || {},
          settings,
          icons: iconResult.icons,
        });

        // 4. Generate ZIP package.
        const packageResult = await generatePwaPackage({
          siteUrl: websiteUrl.href,
          manifestResult,
          iconResult,
          outputDir: packageDirectory,
          includeServiceWorker,
        });

        record.status = 'done';
        record.filename = packageResult.filename;
        record.sizeBytes = packageResult.sizeBytes;
        record.sizeKB = packageResult.sizeKB;
        record.files = packageResult.files;
        record.finishedAt = Date.now();

        return res.status(201).json(
          publicPwaPackage(record)
        );
      } catch (error) {
        console.error(
          `[pwa package ${id}] failed:`,
          error && error.message ? error.message : error
        );

        record.status = 'failed';
        record.finishedAt = Date.now();

        record.error =
          error && error.message
            ? error.message
            : 'PWA package generation failed.';

        await fs.promises.rm(packageDirectory, {
          recursive: true,
          force: true,
        }).catch(() => {});

        const statusCode =
          Number.isInteger(error.statusCode)
            ? error.statusCode
            : 422;

        return res.status(statusCode).json({
          error: record.error,
          code: error.code || 'PWA_PACKAGE_FAILED',
        });
      }
    }
  );

  // ----- PWA package status -----

  app.get('/api/pwa/package/:id', (req, res) => {
    const id = req.params.id;

    const record = UUID.test(id)
      ? pwaPackages.get(id)
      : null;

    if (!record) {
      return res.status(404).json({
        error: 'PWA package not found. It may have expired.',
      });
    }

    return res.json(publicPwaPackage(record));
  });

  // ----- PWA ZIP download -----

  app.get(
    '/api/pwa/package/:id/download',
    (req, res) => {
      const id = req.params.id;

      const record = UUID.test(id)
        ? pwaPackages.get(id)
        : null;

      if (!record || record.status !== 'done') {
        return res.status(404).json({
          error: 'PWA package not found.',
        });
      }

      const filePath = path.join(
        pwaPackagesDir,
        record.id,
        PWA_PACKAGE_FILENAME
      );

      if (!fs.existsSync(filePath)) {
        return res.status(404).json({
          error: 'The PWA ZIP file is no longer available.',
        });
      }

      return res.download(
        filePath,
        PWA_PACKAGE_FILENAME
      );
    }
  );

  // ----- existing website check -----

  app.post(
    '/api/check',
    rateLimiter(maxChecksPerMinute, 60 * 1000),
    async (req, res) => {
      const url = cleanString(
        req.body && req.body.url,
        2048
      );

      if (!url) {
        return res.status(400).json({
          error: 'Please enter a website address.',
        });
      }

      const r = await checkSite(url, {
        allowPrivate,
      });

      if (!r.ok) {
        return res.json({
          ok: false,
          errors: r.errors,
          warnings: r.warnings,
        });
      }

      const m = r.manifest;

      res.json({
        ok: true,
        errors: [],
        warnings: r.warnings,
        host: r.host,

        suggested: {
          name: String(
            m.name || m.short_name || r.host
          ).slice(0, 50),

          shortName: String(
            m.short_name || m.name || r.host
          ).slice(0, 12),

          packageId: core.derivePackageId(r.host),
        },
      });
    }
  );


  // ----- saved projects and build history -----

  // List saved projects with their latest build summary.
  app.get('/api/projects', (req, res) => {
    try {
      const rows = db.prepare(`
        SELECT
          p.id,
          p.website_url,
          p.app_name,
          p.package_name,
          p.status,
          p.created_at,
          p.updated_at,
          COUNT(b.id) AS build_count,
          (
            SELECT b2.id
            FROM builds b2
            WHERE b2.project_id = p.id
            ORDER BY datetime(b2.created_at) DESC, b2.rowid DESC
            LIMIT 1
          ) AS latest_build_id,
          (
            SELECT b2.status
            FROM builds b2
            WHERE b2.project_id = p.id
            ORDER BY datetime(b2.created_at) DESC, b2.rowid DESC
            LIMIT 1
          ) AS latest_build_status,
          (
            SELECT b2.created_at
            FROM builds b2
            WHERE b2.project_id = p.id
            ORDER BY datetime(b2.created_at) DESC, b2.rowid DESC
            LIMIT 1
          ) AS latest_build_created_at
        FROM projects p
        LEFT JOIN builds b ON b.project_id = p.id
        GROUP BY p.id
        ORDER BY datetime(p.updated_at) DESC,
                 datetime(p.created_at) DESC
      `).all();

      return res.json({
        projects: rows.map((row) => ({
          id: row.id,
          websiteUrl: row.website_url,
          appName: row.app_name,
          packageName: row.package_name,
          status: row.latest_build_status || row.status,
          buildCount: row.build_count,
          latestBuild: row.latest_build_id
            ? {
                id: row.latest_build_id,
                status: row.latest_build_status,
                createdAt: row.latest_build_created_at,
              }
            : null,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })),
      });
    } catch (error) {
      console.error('[projects] could not list saved projects:', error);
      return res.status(500).json({
        error: 'Could not load saved projects.',
      });
    }
  });

  // Return one project and its complete Android build history.
  app.get('/api/projects/:id', (req, res) => {
    const id = req.params.id;

    if (!UUID.test(id)) {
      return res.status(404).json({
        error: 'Saved project not found.',
      });
    }

    try {
      const row = db.prepare(`
        SELECT
          id,
          website_url,
          app_name,
          package_name,
          status,
          config_json,
          created_at,
          updated_at
        FROM projects
        WHERE id = ?
      `).get(id);

      if (!row) {
        return res.status(404).json({
          error: 'Saved project not found.',
        });
      }

      const buildRows = db.prepare(`
        SELECT *
        FROM builds
        WHERE project_id = ?
        ORDER BY datetime(created_at) DESC, rowid DESC
      `).all(id);

      const builds = buildRows.map((buildRow) => {
        const job = jobFromDatabase(buildRow);

        return {
          ...publicJob(job),
          createdAt: buildRow.created_at,
          finishedAt: buildRow.finished_at,
        };
      });

      return res.json({
        project: {
          id: row.id,
          websiteUrl: row.website_url,
          appName: row.app_name,
          packageName: row.package_name,
          status: builds[0]?.status || row.status,
          config: parseJson(row.config_json, {}),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          buildCount: builds.length,
        },
        builds,
      });
    } catch (error) {
      console.error(
        `[project ${id}] could not load build history:`,
        error
      );

      return res.status(500).json({
        error: 'Could not load this project and its build history.',
      });
    }
  });


  // ----- existing Android build creation -----

  app.post('/api/build', (req, res) => {
    const body = req.body || {};

    const url = cleanString(body.url, 2048);

    if (!url) {
      return res.status(400).json({
        error: 'Please enter a website address.',
      });
    }

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
      const versionCode = Number(body.versionCode);
      if (!Number.isInteger(versionCode) || versionCode < 1 || versionCode > 2100000000) {
        return res.status(400).json({ error: 'The version code must be a whole number of 1 or more.' });
      }
      options.versionCode = versionCode;
    }
    options.notifications = body.notifications === true;

    const projectId = body.projectId === undefined ? null : body.projectId;
    if (projectId !== null && (typeof projectId !== 'string' || !UUID.test(projectId))) {
      return res.status(400).json({ error: 'Invalid project ID. Please start a new project.' });
    }

    const packageName = options.packageId || core.derivePackageId(new URL(url).host);
    const appName = options.name || new URL(url).host;
    let project;

    try {
      if (projectId) {
        project = db.prepare(`
          SELECT id, website_url, package_name
          FROM projects
          WHERE id = ?
        `).get(projectId);

        if (!project) {
          return res.status(404).json({ error: 'Saved project not found. Start a new project.' });
        }
        if (new URL(project.website_url).origin !== new URL(url).origin) {
          return res.status(409).json({ error: 'This saved project belongs to a different website. Start a new project.' });
        }
        if (project.package_name && project.package_name !== packageName) {
          return res.status(409).json({ error: 'The Android package ID cannot change after a signing key is created. Start a new project to use a different package ID.' });
        }
        db.prepare(`
          UPDATE projects
          SET app_name = ?, config_json = ?, status = 'building', updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(appName, JSON.stringify({ ...options, url }), projectId);
      } else {
        const newProjectId = crypto.randomUUID();
        db.prepare(`
          INSERT INTO projects (id, website_url, app_name, package_name, status, config_json)
          VALUES (?, ?, ?, ?, 'created', ?)
        `).run(newProjectId, url, appName, packageName, JSON.stringify({ ...options, url }));
        project = { id: newProjectId };
      }
    } catch (error) {
      console.error('[project] persistence failed:', error);
      return res.status(500).json({ error: 'Could not save this project. Check the local database and encryption configuration.' });
    }

    if (buildCounter.limited(req.ip)) {
      return res.status(429).json({ error: 'You have reached the hourly build limit. Please try again later.' });
    }
    buildCounter.record(req.ip);

    const job = {
      id: crypto.randomUUID(),
      projectId: project.id,
      status: 'queued',
      log: [],
      files: [],
      options: { ...options, packageId: packageName },
      createdAt: Date.now(),
    };

    try {
      insertBuildStatement.run(
        job.id,
        job.projectId,
        job.status,
        JSON.stringify(job.options),
        JSON.stringify(job.log),
        JSON.stringify(job.files),
        null,
        null
      );
    } catch (error) {
      console.error('[build] could not create persistent build record:', error);
      return res.status(500).json({
        error: 'Could not save this build. Please check the database and try again.',
      });
    }

    jobs.set(job.id, job);
    queue.push(job);

    setImmediate(pump);

    res.status(202).json({
      id: job.id,
      projectId: job.projectId,
      status: job.status,
    });
  });

  // ----- existing Android build status -----

  app.get('/api/build/:id', (req, res) => {
    const id = req.params.id;

    if (!UUID.test(id)) {
      return res.status(404).json({
        error: 'Build not found.',
      });
    }

    let job = jobs.get(id);

    if (!job) {
      const row = db.prepare('SELECT * FROM builds WHERE id = ?').get(id);
      if (row) job = jobFromDatabase(row);
    }

    if (!job) {
      return res.status(404).json({
        error: 'Build not found. It may have expired.',
      });
    }

    return res.json(publicJob(job));
  });

  // ----- existing Android build downloads -----

  app.get('/api/build/:id/files/:key', (req, res) => {
    const id = req.params.id;

    if (!UUID.test(id)) {
      return res.status(404).json({ error: 'File not found.' });
    }

    let job = jobs.get(id);

    if (!job) {
      const row = db.prepare('SELECT * FROM builds WHERE id = ?').get(id);
      if (row) job = jobFromDatabase(row);
    }

    if (!job || job.status !== 'done') {
      return res.status(404).json({
        error: 'File not found.',
      });
    }

    const key = req.params.key;

    if (
      !Object.prototype.hasOwnProperty.call(FILES, key) ||
      !job.files.includes(key)
    ) {
      return res.status(404).json({
        error: 'File not found.',
      });
    }

    const filePath = path.join(
      buildsDir,
      job.id,
      FILES[key]
    );

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        error: 'The build record exists, but this download file is no longer available.',
      });
    }

    return res.download(filePath, FILES[key]);
  });

  // ----- errors -----

  app.use((req, res) => {
    res.status(404).json({
      error: 'Not found.',
    });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status =
      err.status && err.status < 500
        ? err.status
        : 500;

    if (status >= 500) {
      console.error(err);
    }

    res.status(status).json({
      error:
        status < 500
          ? 'Invalid request.'
          : 'Server error.',
    });
  });

  // Restore builds that were queued but had not started before the last shutdown.
  const queuedRows = db.prepare(`
    SELECT *
    FROM builds
    WHERE status = 'queued'
    ORDER BY created_at ASC
  `).all();

  for (const row of queuedRows) {
    const job = jobFromDatabase(row);

    if (!job.options || !job.options.url) {
      db.prepare(`
        UPDATE builds
        SET status = 'failed',
            error = 'Saved build settings are incomplete. Please start a new build.',
            finished_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(job.id);
      continue;
    }

    jobs.set(job.id, job);
    queue.push(job);
  }

  if (queue.length > 0) {
    setImmediate(pump);
  }

  // ----- delete expired build files and PWA packages -----

  const cleaner = setInterval(() => {
    const now = Date.now();

    for (const [id, job] of jobs) {
      if (
        job.finishedAt &&
        now - job.finishedAt > jobTtlMs
      ) {
        jobs.delete(id);

        // Keep the historical build record, but remove expired download links.
        db.prepare(`
          UPDATE builds
          SET files_json = '[]', updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(id);

        fs.rm(
          path.join(buildsDir, id),
          {
            recursive: true,
            force: true,
          },
          () => {}
        );
      }
    }

    for (const [id, record] of pwaPackages) {
      if (
        record.finishedAt &&
        now - record.finishedAt > jobTtlMs
      ) {
        pwaPackages.delete(id);

        fs.rm(
          path.join(pwaPackagesDir, id),
          {
            recursive: true,
            force: true,
          },
          () => {}
        );
      }
    }
  }, 10 * 60 * 1000);

  cleaner.unref();

  app.locals.stop = () => clearInterval(cleaner);

  return app;
}

module.exports = {
  createApp,
  FILES,
};

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;

  createApp().listen(port, '127.0.0.1', () => {
    console.log(
      `API running at http://127.0.0.1:${port}`
    );
  });
}
