
'use strict';

/**
 * Builds a standards-based Web App Manifest from scanner findings and
 * website-owner supplied settings.
 *
 * No AI, external AI API, or network access is used here.
 */

const DISPLAY_MODES = new Set([
  'standalone',
  'fullscreen',
  'minimal-ui',
  'browser'
]);

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/**
 * Validates and cleans text values.
 */
function cleanText(value, field, maxLength, required = false) {
  if (value === undefined || value === null || value === '') {
    if (required) {
      throw new Error(`${field} is required.`);
    }
    return '';
  }

  if (typeof value !== 'string') {
    throw new Error(`${field} must be text.`);
  }

  const result = value.trim();

  if (required && !result) {
    throw new Error(`${field} is required.`);
  }

  if (result.length > maxLength) {
    throw new Error(
      `${field} must be ${maxLength} characters or fewer.`
    );
  }

  return result;
}

/**
 * Ensures the website uses HTTPS.
 */
function normalizeSiteUrl(value) {
  let url;

  try {
    url = new URL(value);
  } catch {
    throw new Error('A valid website URL is required.');
  }

  if (url.protocol !== 'https:') {
    throw new Error(
      'The website must use HTTPS before generating a production TWA manifest.'
    );
  }

  url.hash = '';

  return url;
}

/**
 * Validates that start URL and scope belong to the website's origin.
 */
function normalizeSameOriginPath(value, field, siteUrl, fallback) {
  const raw = value || fallback;

  let parsed;

  try {
    parsed = new URL(raw, siteUrl);
  } catch {
    throw new Error(
      `${field} must be a valid path on your website.`
    );
  }

  if (parsed.origin !== siteUrl.origin) {
    throw new Error(
      `${field} must stay on the same origin as your website.`
    );
  }

  if (parsed.username || parsed.password) {
    throw new Error(
      `${field} cannot contain credentials.`
    );
  }

  return `${parsed.pathname}${parsed.search}` || '/';
}

/**
 * Validates hexadecimal colour values.
 */
function normalizeColor(value, field, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  if (
    typeof value !== 'string' ||
    !HEX_COLOR.test(value.trim())
  ) {
    throw new Error(
      `${field} must be a hexadecimal colour such as #0f172a.`
    );
  }

  return value.trim();
}

/**
 * Generates manifest.webmanifest.
 *
 * @param {object} options
 * @param {string} options.siteUrl - HTTPS website URL
 * @param {object} options.website - Website information from scanner
 * @param {object} options.settings - User-selected app settings
 * @param {Array} options.icons - Generated icon definitions
 *
 * @returns {{
 *   manifest: object,
 *   json: string,
 *   filename: string
 * }}
 */
function generateManifest({
  siteUrl,
  website = {},
  settings = {},
  icons
} = {}) {

  const baseUrl = normalizeSiteUrl(siteUrl);

  // App name
  const name = cleanText(
    settings.name ?? website.appName ?? website.title,
    'App name',
    50,
    true
  );

  // Short name
  const shortName = cleanText(
    settings.shortName ?? name.slice(0, 12),
    'Short name',
    12,
    true
  );

  // Start URL
  const startUrl = normalizeSameOriginPath(
    settings.startUrl ?? website.startUrl,
    'Start URL',
    baseUrl,
    '/'
  );

  // Scope
  const scope = normalizeSameOriginPath(
    settings.scope ?? website.scope,
    'Scope',
    baseUrl,
    '/'
  );

  // Display mode
  const display = String(
    settings.display || 'standalone'
  ).trim().toLowerCase();

  if (!DISPLAY_MODES.has(display)) {
    throw new Error(
      'Display mode must be standalone, fullscreen, minimal-ui, or browser.'
    );
  }

  // Ensure start URL is inside the selected scope.
  const scopePath = new URL(scope, baseUrl).pathname;
  const startPath = new URL(startUrl, baseUrl).pathname;

  if (
    !startPath.startsWith(
      scopePath.endsWith('/')
        ? scopePath
        : `${scopePath}/`
    ) &&
    startPath !== scopePath
  ) {
    throw new Error(
      'Start URL must be inside the selected scope.'
    );
  }

  // Theme and background colours
  const themeColor = normalizeColor(
    settings.themeColor ?? website.themeColor,
    'Theme colour',
    '#0f172a'
  );

  const backgroundColor = normalizeColor(
    settings.backgroundColor ?? website.backgroundColor,
    'Background colour',
    '#ffffff'
  );

  // Default icon references.
  // These files will be generated in our icon-generation module.
  const iconList = icons === undefined
    ? [
        {
          src: '/icons/icon-192.png',
          sizes: '192x192',
          type: 'image/png',
          purpose: 'any'
        },
        {
          src: '/icons/icon-512.png',
          sizes: '512x512',
          type: 'image/png',
          purpose: 'any'
        }
      ]
    : icons;

  if (!Array.isArray(iconList) || iconList.length === 0) {
    throw new Error(
      'At least one app icon must be configured before generating the final manifest.'
    );
  }

  // Validate icon definitions.
  for (const icon of iconList) {
    if (
      !icon ||
      typeof icon !== 'object' ||
      typeof icon.src !== 'string' ||
      !icon.src.trim()
    ) {
      throw new Error(
        'Each icon must have a valid src path.'
      );
    }

    if (
      /^(?:https?:)?\/\//i.test(icon.src) ||
      icon.src.startsWith('data:')
    ) {
      throw new Error(
        'Icon src values must be paths hosted on the website, not external or data URLs.'
      );
    }

    if (!icon.src.startsWith('/')) {
      throw new Error(
        'Icon src values must be root-relative paths, for example /icons/icon-512.png.'
      );
    }
  }

  // Build manifest object.
  const manifest = {
    id: scope,

    name,

    short_name: shortName,

    description:
      cleanText(
        settings.description,
        'Description',
        300,
        false
      ) || `${name} application`,

    start_url: startUrl,

    scope,

    display,

    orientation: settings.orientation || 'any',

    theme_color: themeColor,

    background_color: backgroundColor,

    icons: iconList.map((icon) => ({
      src: icon.src,
      sizes: icon.sizes || '512x512',
      type: icon.type || 'image/png',
      purpose: icon.purpose || 'any'
    }))
  };

  return {
    manifest,

    json: `${JSON.stringify(manifest, null, 2)}\n`,

    filename: 'manifest.webmanifest'
  };
}

module.exports = {
  generateManifest
};
