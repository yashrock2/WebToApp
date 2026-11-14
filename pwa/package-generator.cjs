
'use strict';

const fs = require('fs');
const path = require('path');
const { ZipArchive } = require('archiver');
const REQUIRED_ICONS = [
  {
    filename: 'icon-192.png',
    archivePath: 'icons/icon-192.png',
    size: 192
  },
  {
    filename: 'icon-512.png',
    archivePath: 'icons/icon-512.png',
    size: 512
  }
];

function validateSiteUrl(siteUrl) {
  let parsed;

  try {
    parsed = new URL(siteUrl);
  } catch {
    throw new Error('A valid website URL is required.');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('The website must use HTTPS before preparing a production PWA package.');
  }

  if (parsed.username || parsed.password) {
    throw new Error('Website URLs containing credentials are not allowed.');
  }

  return parsed;
}

function cleanText(value, fallback, maxLength = 500) {
  if (typeof value !== 'string' || !value.trim()) {
    return fallback;
  }

  return value.trim().slice(0, maxLength);
}

function getHtmlInstructions(siteUrl, manifest, includeServiceWorker) {
  const parsed = new URL(siteUrl);
  const origin = parsed.origin;

  const themeColor = manifest.theme_color || '#0f172a';

  let instructions = `WEBTOAPP - HTML INTEGRATION INSTRUCTIONS
==========================================

Website:
${origin}

STEP 1 - UPLOAD THE GENERATED FILES
----------------------------------

Upload these files to your website's public root directory:

manifest.webmanifest
icons/icon-192.png
icons/icon-512.png

Your files should be accessible at:

${origin}/manifest.webmanifest
${origin}/icons/icon-192.png
${origin}/icons/icon-512.png


STEP 2 - UPDATE YOUR HTML HEAD
------------------------------

Open your website's main HTML template.

Inside the <head> section, add:

<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="${themeColor}">

If your website does not already have a viewport meta tag,
also add:

<meta name="viewport" content="width=device-width, initial-scale=1">


STEP 3 - CHECK THE MANIFEST
---------------------------

Open this URL in your browser:

${origin}/manifest.webmanifest

You should see the generated JSON manifest.

Also verify that both icon URLs open successfully.


STEP 4 - CHECK YOUR HOSTING CONFIGURATION
-----------------------------------------

Ensure your hosting server serves:

manifest.webmanifest

with the content type:

application/manifest+json

Ensure the icon files are served as:

image/png


STEP 5 - RESCAN YOUR WEBSITE
----------------------------

Return to WebToApp and scan your website again.

WebToApp will check whether the manifest and icons are
available on your live website.

IMPORTANT:
Downloading this ZIP does not automatically modify your
website. You must upload the files and update your HTML
yourself.

`;

  if (includeServiceWorker) {
    instructions += `
OPTIONAL SERVICE WORKER
-----------------------

A service-worker.js template is included in this package.

Before using it, review the file and customize its caching
strategy for your website.

To register it, add this JavaScript to your website:

<script>
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js')
      .catch(error => {
        console.error('Service worker registration failed:', error);
      });
  });
}
</script>

Do not register multiple service workers for the same scope.
Check your existing website implementation first.

`;
  }

  return instructions;
}

function getServiceWorkerTemplate() {
  return `/*
 * WebToApp - Optional Service Worker Template
 *
 * IMPORTANT:
 * Review and customize this file before deploying.
 * This is a basic example, not a complete offline strategy.
 */

const CACHE_NAME = 'webtoapp-static-v1';

const STATIC_ASSETS = [
  '/',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;

  if (request.method !== 'GET') {
    return;
  }

  const requestUrl = new URL(request.url);

  // Only handle requests from this website.
  if (requestUrl.origin !== self.location.origin) {
    return;
  }

  // Do not intercept API requests.
  if (requestUrl.pathname.startsWith('/api/')) {
    return;
  }

  event.respondWith(
    caches.match(request).then(cachedResponse => {
      if (cachedResponse) {
        return cachedResponse;
      }

      return fetch(request);
    })
  );
});
`;
}

function getReadme(siteUrl, manifest, includeServiceWorker) {
  const appName = cleanText(
    manifest.name,
    'Your Web Application',
    50
  );

  const parsed = new URL(siteUrl);

  return `WEBTOAPP - PWA SETUP PACKAGE
==============================

Application: ${appName}
Website: ${parsed.origin}

PACKAGE CONTENTS
----------------

manifest.webmanifest
    Your Progressive Web App manifest.

icons/icon-192.png
    Application icon (192 x 192).

icons/icon-512.png
    Application icon (512 x 512).

integration/html-instructions.txt
    Instructions for connecting the manifest to your website.

${includeServiceWorker ? 'service-worker.js\n    Optional service worker template. Review before deployment.\n' : ''}

INSTALLATION GUIDE
------------------

1. Extract this ZIP file.

2. Upload manifest.webmanifest to your website's public root.

3. Upload the icons folder to your website's public root.

4. Open integration/html-instructions.txt.

5. Follow the HTML integration instructions.

6. Publish your website changes.

7. Verify that the manifest and icons are accessible through
   your website's HTTPS URLs.

8. Return to WebToApp and scan your website again.

IMPORTANT NOTES
---------------

- This package does not automatically modify your website.
- You need access to your website hosting or source code.
- Preserve the folder structure when uploading files.
- Do not overwrite an existing manifest without reviewing it.
- Back up your website before making changes.
- The service worker is optional and should be reviewed before use.
- A valid PWA manifest alone does not guarantee that every
  website meets Trusted Web Activity requirements.
- WebToApp will perform another scan before proceeding
  with the Android app build.

Generated by WebToApp.
`;
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('A valid manifest object is required.');
  }

  if (!Array.isArray(manifest.icons) || manifest.icons.length === 0) {
    throw new Error('The manifest must contain at least one icon.');
  }

  for (const icon of REQUIRED_ICONS) {
    const found = manifest.icons.some(item => {
      if (!item || typeof item.src !== 'string') {
        return false;
      }

      return item.src === `/icons/${icon.filename}`;
    });

    if (!found) {
      throw new Error(
        `Manifest is missing the required ${icon.size}x${icon.size} icon reference.`
      );
    }
  }
}

async function ensureFile(filePath, description) {
  let stats;

  try {
    stats = await fs.promises.stat(filePath);
  } catch {
    throw new Error(`${description} was not found: ${filePath}`);
  }

  if (!stats.isFile()) {
    throw new Error(`${description} must be a file.`);
  }

  return filePath;
}

async function generatePwaPackage({
  siteUrl,
  manifestResult,
  iconResult,
  outputDir,
  includeServiceWorker = false
}) {
  if (!siteUrl) {
    throw new Error('Website URL is required.');
  }

  validateSiteUrl(siteUrl);

  if (!manifestResult || typeof manifestResult.json !== 'string') {
    throw new Error('A generated manifest result is required.');
  }

  if (!iconResult || !iconResult.outputDirectory) {
    throw new Error('A generated icon result is required.');
  }

  if (iconResult.success !== true) {
    throw new Error('Icon generation has not completed successfully.');
  }

  if (!outputDir || typeof outputDir !== 'string') {
    throw new Error('An output directory is required.');
  }

  let manifest;

  try {
    manifest = JSON.parse(manifestResult.json);
  } catch {
    throw new Error('Generated manifest contains invalid JSON.');
  }

  validateManifest(manifest);

  const iconsDirectory = path.resolve(iconResult.outputDirectory);
  const destinationDirectory = path.resolve(outputDir);

  await fs.promises.mkdir(destinationDirectory, {
    recursive: true
  });

  const zipPath = path.join(
    destinationDirectory,
    'WebToApp-PWA-Setup.zip'
  );

  // Validate icon files before creating the archive.
  const iconFiles = [];

  for (const icon of REQUIRED_ICONS) {
    const iconPath = path.join(iconsDirectory, icon.filename);

    await ensureFile(iconPath, `${icon.size}x${icon.size} application icon`);

    iconFiles.push({
      path: iconPath,
      archivePath: icon.archivePath
    });
  }

  const files = [
    'manifest.webmanifest',
    'icons/icon-192.png',
    'icons/icon-512.png',
    'integration/html-instructions.txt',
    'README.txt'
  ];

  if (includeServiceWorker) {
    files.push('service-worker.js');
  }

  const archive = new ZipArchive({
  zlib: {
    level: 9
  }
});

  try {
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipPath);

      output.on('close', resolve);
      output.on('error', reject);

      archive.on('warning', error => {
        if (error.code === 'ENOENT') {
          reject(error);
        }
      });

      archive.on('error', reject);

      archive.pipe(output);

      // Add generated manifest.
      archive.append(manifestResult.json, {
        name: 'manifest.webmanifest'
      });

      // Add generated icons.
      for (const icon of iconFiles) {
        archive.file(icon.path, {
          name: icon.archivePath
        });
      }

      // Add HTML integration instructions.
      archive.append(
        getHtmlInstructions(siteUrl, manifest, includeServiceWorker),
        {
          name: 'integration/html-instructions.txt'
        }
      );

      // Add README.
      archive.append(
        getReadme(siteUrl, manifest, includeServiceWorker),
        {
          name: 'README.txt'
        }
      );

      // Add optional service worker.
      if (includeServiceWorker) {
        archive.append(getServiceWorkerTemplate(), {
          name: 'service-worker.js'
        });
      }

      archive.finalize().catch(reject);
    });
  } catch (error) {
    // Remove incomplete ZIP if generation fails.
    await fs.promises.rm(zipPath, {
      force: true
    }).catch(() => {});

    throw new Error(`PWA ZIP generation failed: ${error.message}`);
  }

  const zipStats = await fs.promises.stat(zipPath);

  if (zipStats.size === 0) {
    throw new Error('Generated ZIP package is empty.');
  }

  return {
    success: true,
    filename: 'WebToApp-PWA-Setup.zip',
    zipPath,
    sizeBytes: zipStats.size,
    sizeKB: Number((zipStats.size / 1024).toFixed(2)),
    files,
    includeServiceWorker
  };
}

module.exports = {
  generatePwaPackage,
  getHtmlInstructions,
  getReadme,
  getServiceWorkerTemplate
};
