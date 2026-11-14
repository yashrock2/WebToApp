
'use strict';

/**
 * WebToApp - PWA Icon Generator
 *
 * Supports:
 * 1. User-uploaded logos.
 * 2. Automatic extraction from website manifest icons.
 * 3. Automatic extraction from HTML icon links.
 *
 * Generates:
 * - icon-192.png
 * - icon-512.png
 *
 * Uses Sharp and the existing build.cjs SSRF protections.
 * No AI or external AI API is used.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const core = require('../build.cjs');

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const MAX_REDIRECTS = 5;

/**
 * Safely downloads an image from a public HTTPS URL.
 * Every redirect is checked to prevent SSRF.
 */
async function downloadImage(imageUrl, { allowPrivate = false } = {}) {
  let current;

  try {
    current = new URL(imageUrl);
  } catch {
    throw new Error('The icon URL is invalid.');
  }

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    if (current.protocol !== 'https:') {
      throw new Error('Only HTTPS icon URLs are supported.');
    }

    if (current.username || current.password) {
      throw new Error('Icon URLs cannot contain credentials.');
    }

    if (!allowPrivate) {
      await core.assertPublicHost(current.hostname);
    }

    const response = await fetch(current.href, {
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
      headers: {
        'user-agent': 'webtoapp-pwa-generator/1.0'
      }
    });

    const location = response.headers.get('location');

    if (
      response.status >= 300 &&
      response.status < 400 &&
      location
    ) {
      current = new URL(location, current);
      continue;
    }

    if (!response.ok) {
      throw new Error(
        `Could not download icon. Server returned HTTP ${response.status}.`
      );
    }

    const contentLength = Number(
      response.headers.get('content-length') || 0
    );

    if (contentLength > MAX_IMAGE_BYTES) {
      throw new Error('The icon image exceeds the 5 MB limit.');
    }

    const contentType = (
      response.headers.get('content-type') || ''
    ).toLowerCase();

    if (
      contentType &&
      !contentType.startsWith('image/')
      && !contentType.includes('octet-stream')
    ) {
      throw new Error('The selected URL did not return an image.');
    }

    if (!response.body) {
      throw new Error('The icon response was empty.');
    }

    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        total += value.length;

        if (total > MAX_IMAGE_BYTES) {
          await reader.cancel();
          throw new Error('The icon image exceeds the 5 MB limit.');
        }

        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }

    if (!total) {
      throw new Error('The downloaded icon is empty.');
    }

    return {
      buffer: Buffer.concat(chunks),
      finalUrl: current.href
    };
  }

  throw new Error('Too many redirects while downloading the icon.');
}

/**
 * Finds an icon from the website's existing manifest.
 */
function getManifestIconCandidates(scanResult) {
  const manifest = scanResult && scanResult.manifest;

  if (!manifest || !Array.isArray(manifest.icons)) {
    return [];
  }

  const manifestUrl = manifest.url;

  if (!manifestUrl) return [];

  return manifest.icons
    .filter((icon) => {
      if (!icon || typeof icon.src !== 'string') return false;

      const purposes = String(icon.purpose || 'any').split(/\s+/);

      return purposes.includes('any');
    })
    .sort((a, b) => {
      const getSize = (icon) => {
        const sizes = String(icon.sizes || '');
        const matches = [...sizes.matchAll(/(\d+)x(\d+)/g)];

        return Math.max(
          0,
          ...matches.map((match) => Number(match[1]))
        );
      };

      return getSize(b) - getSize(a);
    })
    .map((icon) => {
      try {
        const url = new URL(icon.src, manifestUrl);

        if (url.protocol !== 'https:') return null;

        return url.href;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Finds icons declared in HTML using rel="icon".
 */
function getHtmlIconCandidates(scanResult) {
  const icons = scanResult && Array.isArray(scanResult.icons)
    ? scanResult.icons
    : [];

  return icons
    .filter((value) => typeof value === 'string')
    .filter((value) => {
      try {
        return new URL(value).protocol === 'https:';
      } catch {
        return false;
      }
    });
}

/**
 * Selects the image source.
 *
 * User upload takes priority over automatic extraction.
 */
async function selectIconSource({
  siteUrl,
  scanResult,
  uploadedIconBuffer,
  allowPrivate = false
}) {
  // Option 1: User uploaded an image.
  if (uploadedIconBuffer !== undefined && uploadedIconBuffer !== null) {
    if (!Buffer.isBuffer(uploadedIconBuffer)) {
      throw new Error('Uploaded icon must be provided as a Buffer.');
    }

    if (
      uploadedIconBuffer.length === 0 ||
      uploadedIconBuffer.length > MAX_IMAGE_BYTES
    ) {
      throw new Error('Uploaded icon must be between 1 byte and 5 MB.');
    }

    return {
      buffer: uploadedIconBuffer,
      source: {
        type: 'upload',
        url: null
      }
    };
  }

  // Validate the website URL.
  let websiteUrl;

  try {
    websiteUrl = new URL(siteUrl);
  } catch {
    throw new Error('A valid website URL is required.');
  }

  if (websiteUrl.protocol !== 'https:') {
    throw new Error('The website must use HTTPS.');
  }

  // Option 2: Manifest icons first.
  const manifestCandidates = getManifestIconCandidates(scanResult);

  // Option 3: HTML icon links.
  const htmlCandidates = getHtmlIconCandidates(scanResult);

  const candidates = [
    ...manifestCandidates,
    ...htmlCandidates
  ];

  const uniqueCandidates = [...new Set(candidates)];

  if (!uniqueCandidates.length) {
    throw new Error(
      'No website icon was detected. Please upload your own logo.'
    );
  }

  const errors = [];

  // Try candidates one by one.
  for (const iconUrl of uniqueCandidates.slice(0, 10)) {
    try {
      const downloaded = await downloadImage(iconUrl, {
        allowPrivate
      });

      return {
        buffer: downloaded.buffer,
        source: {
          type: 'website',
          url: downloaded.finalUrl
        }
      };
    } catch (error) {
      errors.push(error.message);
    }
  }

  throw new Error(
    'No usable website icon could be downloaded. Please upload your own logo.'
  );
}

/**
 * Generates a square PNG icon with transparent padding.
 */
async function createIcon(inputBuffer, outputPath, size) {
  const image = sharp(inputBuffer, {
    limitInputPixels: MAX_PIXELS,
    failOn: 'error',
    animated: false
  });

  const metadata = await image.metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error('The selected file is not a valid image.');
  }

  if (
    metadata.width * metadata.height > MAX_PIXELS
  ) {
    throw new Error('The image dimensions are too large.');
  }

  if (!['png', 'jpeg', 'webp', 'svg', 'gif', 'tiff', 'avif'].includes(metadata.format)) {
    throw new Error('Unsupported image format.');
  }

  await image
    .rotate()
    .resize(size, size, {
      fit: 'contain',
      background: {
        r: 0,
        g: 0,
        b: 0,
        alpha: 0
      },
      withoutEnlargement: false
    })
    .png({
      compressionLevel: 9
    })
    .toFile(outputPath);

  return {
    src: `/icons/icon-${size}.png`,
    sizes: `${size}x${size}`,
    type: 'image/png',
    purpose: 'any'
  };
}

/**
 * Main function.
 *
 * @param {object} options
 * @param {string} options.siteUrl
 * @param {object} options.scanResult
 * @param {string} options.outputDir
 * @param {Buffer} options.uploadedIconBuffer
 * @param {boolean} options.allowPrivate
 */
async function generateAppIcons({
  siteUrl,
  scanResult,
  outputDir,
  uploadedIconBuffer,
  allowPrivate = false
} = {}) {
  if (!outputDir || typeof outputDir !== 'string') {
    throw new Error('An output directory is required.');
  }

  const resolvedOutputDir = path.resolve(outputDir);

  await fs.promises.mkdir(
    path.join(resolvedOutputDir, 'icons'),
    { recursive: true }
  );

  // Select uploaded logo or automatically detected website icon.
  const selected = await selectIconSource({
    siteUrl,
    scanResult,
    uploadedIconBuffer,
    allowPrivate
  });

  const iconDirectory = path.join(
    resolvedOutputDir,
    'icons'
  );

  // Generate 192x192 icon.
  const icon192 = await createIcon(
    selected.buffer,
    path.join(iconDirectory, 'icon-192.png'),
    192
  );

  // Generate 512x512 icon.
  const icon512 = await createIcon(
    selected.buffer,
    path.join(iconDirectory, 'icon-512.png'),
    512
  );

  return {
    success: true,

    source: selected.source,

    outputDirectory: iconDirectory,

    icons: [
      icon192,
      icon512
    ]
  };
}

module.exports = {
  generateAppIcons,
  selectIconSource,
  downloadImage
};
