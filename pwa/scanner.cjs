
'use strict';

/**
 * Rule-based PWA/TWA website scanner.
 *
 * No AI, external AI API, or new npm dependency is used.
 * All remote requests go through build.cjs safeFetch to retain SSRF protections.
 */

const core = require('../build.cjs');

function getAttribute(tag, attribute) {
  const regex = new RegExp(
    `\\b${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    'i'
  );

  const match = regex.exec(tag);
  return match ? (match[1] || match[2] || match[3] || '').trim() : '';
}

function getMetaContent(html, name) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];

  for (const tag of tags) {
    const key =
      getAttribute(tag, 'name') ||
      getAttribute(tag, 'property');

    if (key && key.toLowerCase() === name.toLowerCase()) {
      return getAttribute(tag, 'content');
    }
  }

  return '';
}

function getPageTitle(html) {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);

  return match
    ? match[1]
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80)
    : '';
}

function getIconLinks(html, baseUrl) {
  const links = html.match(/<link\b[^>]*>/gi) || [];
  const icons = [];

  for (const tag of links) {
    const relValue = getAttribute(tag, 'rel');
    const hrefValue = getAttribute(tag, 'href');

    if (!relValue || !/\bicon\b/i.test(relValue) || !hrefValue) {
      continue;
    }

    try {
      const parsed = new URL(hrefValue, baseUrl);

      // Ignore data URLs and unsupported protocols.
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        continue;
      }

      icons.push(parsed.href);
    } catch {
      // Ignore malformed icon URLs.
    }
  }

  return [...new Set(icons)].slice(0, 10);
}

function hasServiceWorkerRegistration(html) {
  return /navigator\s*\.\s*serviceWorker\s*\.\s*register\s*\(/i.test(html);
}

function sameOriginPath(value, baseUrl, fallback) {
  if (!value) return fallback;

  try {
    const parsed = new URL(value, baseUrl);
    const base = new URL(baseUrl);

    return parsed.origin === base.origin
      ? `${parsed.pathname}${parsed.search}`
      : fallback;
  } catch {
    return fallback;
  }
}

async function scanWebsite(siteUrl, { allowPrivate = false } = {}) {
  let inputUrl;

  try {
    inputUrl = new URL(String(siteUrl).trim());
  } catch {
    return {
      ok: false,
      status: 'invalid_url',
      errors: ['Enter a valid website URL.'],
      checks: {},
    };
  }

  if (!['http:', 'https:'].includes(inputUrl.protocol)) {
    return {
      ok: false,
      status: 'unsupported_protocol',
      errors: ['Only HTTP and HTTPS website URLs are supported.'],
      checks: {},
    };
  }

  if (inputUrl.username || inputUrl.password) {
    return {
      ok: false,
      status: 'invalid_url',
      errors: ['Website URLs containing credentials are not supported.'],
      checks: {},
    };
  }

  // FIX: URL.protocol returns 'https:', not 'https'.
  const isHttps = inputUrl.protocol === 'https:';

  const checks = {
    https: {
      passed: isHttps,
      required: true,
      message: isHttps
        ? 'The submitted URL uses HTTPS.'
        : 'The website URL uses HTTP. Enable HTTPS through your hosting provider before creating a production TWA.',
    },

    homepage: {
      passed: false,
      required: true,
      message: 'The homepage could not be checked.',
    },

    manifest: {
      passed: false,
      required: true,
      message: 'No web app manifest was found.',
    },

    manifestValid: {
      passed: false,
      required: true,
      message: 'A valid web app manifest has not been verified.',
    },

    appName: {
      passed: false,
      required: true,
      message: 'An app name has not been found.',
    },

    appIcon: {
      passed: false,
      required: true,
      message: 'A suitable 512×512 PNG icon has not been found in the manifest.',
    },

    serviceWorker: {
      passed: false,
      required: false,
      message: 'A service worker registration was not detected in the homepage HTML. This is a PWA recommendation, not an automatic TWA build blocker.',
    },
  };

  if (!isHttps) {
    return {
      ok: true,
      status: 'needs_https',
      url: inputUrl.href,
      finalUrl: null,
      host: inputUrl.host,
      checks,
      errors: [],
      warnings: [
        'HTTPS is required for production Trusted Web Activity hosting.',
      ],
      suggestions: [
        'Enable an SSL certificate for your domain using your hosting provider, then scan the HTTPS address.',
      ],
      website: {
        title: '',
        appName: '',
        themeColor: '',
        backgroundColor: '',
        startUrl: '/',
        scope: '/',
      },
      manifest: null,
      icons: [],
    };
  }

  let page;

  try {
    page = await core.safeFetch(inputUrl.href, { allowPrivate });

    checks.homepage = {
      passed: true,
      required: true,
      message: 'The homepage is reachable over HTTPS.',
    };
  } catch (error) {
    return {
      ok: false,
      status: 'unreachable',
      url: inputUrl.href,
      checks,
      errors: [`Could not load the website: ${error.message}`],
      warnings: [],
      suggestions: [],
    };
  }

  let final;

  try {
    final = new URL(page.finalUrl);

    // A redirect from HTTPS to HTTP must not be treated as secure.
    if (final.protocol !== 'https:') {
      checks.https = {
        passed: false,
        required: true,
        message: 'The website redirected to a non-HTTPS address.',
      };

      return {
        ok: true,
        status: 'needs_https',
        url: inputUrl.href,
        finalUrl: page.finalUrl,
        host: final.host,
        checks,
        errors: [],
        warnings: [
          'The final website address after redirection does not use HTTPS.',
        ],
        suggestions: [
          'Configure your website and redirects to use HTTPS throughout.',
        ],
        website: {
          title: '',
          appName: '',
          themeColor: '',
          backgroundColor: '',
          startUrl: '/',
          scope: '/',
        },
        manifest: null,
        icons: [],
      };
    }
  } catch {
    return {
      ok: false,
      status: 'unreachable',
      url: inputUrl.href,
      checks,
      errors: ['The website returned an invalid final URL.'],
      warnings: [],
      suggestions: [],
    };
  }

  const finalUrl = final.href;
  const title = getPageTitle(page.text);
  const metaTheme = getMetaContent(page.text, 'theme-color');
  const metaName = getMetaContent(page.text, 'application-name') || title;
  const htmlIcons = getIconLinks(page.text, finalUrl);

  const swDetected = hasServiceWorkerRegistration(page.text);

  checks.serviceWorker = {
    passed: swDetected,
    required: false,
    message: swDetected
      ? 'A service worker registration call was found in the homepage HTML.'
      : 'No service worker registration call was detected in the homepage HTML. This is a PWA recommendation, not an automatic TWA build blocker.',
  };

  let manifestUrl = null;

  try {
    manifestUrl = core.findManifestUrl(page.text, finalUrl);
  } catch {
    manifestUrl = null;
  }

  let manifest = null;
  let manifestError = '';

  if (manifestUrl) {
    checks.manifest = {
      passed: true,
      required: true,
      message: 'A web app manifest link was found.',
    };

    try {
      const manifestResponse = await core.safeFetch(manifestUrl, {
        allowPrivate,
        maxBytes: 500000,
      });

      manifest = JSON.parse(manifestResponse.text);

      if (
        !manifest ||
        typeof manifest !== 'object' ||
        Array.isArray(manifest)
      ) {
        throw new Error('The manifest must contain a JSON object.');
      }

      checks.manifestValid = {
        passed: true,
        required: true,
        message: 'The manifest was fetched and contains valid JSON.',
      };
    } catch (error) {
      manifestError = error.message;

      checks.manifestValid = {
        passed: false,
        required: true,
        message: `The manifest could not be validated: ${error.message}`,
      };
    }
  } else {
    checks.manifest = {
      passed: false,
      required: true,
      message: 'No web app manifest link was found in the homepage HTML.',
    };
  }

  const appName = String(
    (manifest && (manifest.name || manifest.short_name)) ||
    metaName ||
    final.host
  ).trim().slice(0, 50);

  checks.appName = {
    passed: Boolean(appName),
    required: true,
    message: appName
      ? `A suggested app name was found: ${appName}`
      : 'No app name could be determined. The website owner will need to enter one.',
  };

  let manifestIconUrl = null;

  if (manifest && checks.manifestValid.passed) {
    try {
      manifestIconUrl = core.pickIcon(manifest, manifestUrl);
    } catch {
      manifestIconUrl = null;
    }
  }

  if (manifestIconUrl) {
    try {
      const iconUrl = new URL(manifestIconUrl);

      if (iconUrl.protocol !== 'https:') {
        throw new Error('The manifest icon must use HTTPS.');
      }

      await core.safeFetch(iconUrl.href, {
        allowPrivate,
        maxBytes: 2_000_000,
      });

      checks.appIcon = {
        passed: true,
        required: true,
        message: 'A manifest PNG icon declared as at least 512×512 was found and is reachable.',
      };
    } catch (error) {
      checks.appIcon = {
        passed: false,
        required: true,
        message: `The manifest icon could not be verified: ${error.message}`,
      };

      manifestIconUrl = null;
    }
  }

  const warnings = [];
  const suggestions = [];

  if (!checks.manifest.passed) {
    suggestions.push(
      'Generate a manifest.webmanifest file and add its link tag to the homepage HTML.'
    );
  }

  if (!checks.appIcon.passed) {
    suggestions.push(
      'Add a reachable HTTPS PNG app icon of at least 512×512 to the manifest.'
    );
  }

  if (!checks.serviceWorker.passed) {
    warnings.push(checks.serviceWorker.message);
  }

  if (
    manifest &&
    manifest.display &&
    !['standalone', 'fullscreen'].includes(
      String(manifest.display).toLowerCase()
    )
  ) {
    warnings.push(
      `The manifest display mode is "${manifest.display}". Use "standalone" for the intended app-like experience.`
    );
  }

  if (!/<meta\b[^>]*name=["']viewport["']/i.test(page.text)) {
    warnings.push(
      'No viewport meta tag was detected. The website may not display correctly on mobile screens.'
    );
  }

  if (manifestError) {
    warnings.push(`Manifest validation detail: ${manifestError}`);
  }

  const startUrl = sameOriginPath(
    manifest && manifest.start_url,
    manifestUrl || finalUrl,
    '/'
  );

  const scope = sameOriginPath(
    manifest && manifest.scope,
    manifestUrl || finalUrl,
    '/'
  );

  const ready =
    checks.https.passed &&
    checks.homepage.passed &&
    checks.manifest.passed &&
    checks.manifestValid.passed &&
    checks.appName.passed &&
    checks.appIcon.passed;

  return {
    ok: true,
    status: ready ? 'ready' : 'needs_setup',
    url: inputUrl.href,
    finalUrl,
    host: final.host,
    checks,
    errors: [],
    warnings,
    suggestions,

    website: {
      title,
      appName,
      themeColor: (manifest && manifest.theme_color) || metaTheme || '',
      backgroundColor: (manifest && manifest.background_color) || '',
      startUrl,
      scope,
    },

    manifest: manifest
      ? {
          url: manifestUrl,
          name: manifest.name || '',
          shortName: manifest.short_name || '',
          display: manifest.display || '',
          startUrl: manifest.start_url || '',
          scope: manifest.scope || '',
          themeColor: manifest.theme_color || '',
          backgroundColor: manifest.background_color || '',
          icons: Array.isArray(manifest.icons) ? manifest.icons : [],
        }
      : null,

    icons: htmlIcons,
  };
}

module.exports = { scanWebsite };
