const FRAMEWORKS = [
  { id: 'next', label: 'Next.js', packages: ['next'], configs: ['next.config.js', 'next.config.mjs', 'next.config.ts'] },
  { id: 'nuxt', label: 'Nuxt', packages: ['nuxt'], configs: ['nuxt.config.js', 'nuxt.config.ts', 'nuxt.config.mjs'] },
  { id: 'angular', label: 'Angular', packages: ['@angular/core'], configs: ['angular.json'] },
  { id: 'sveltekit', label: 'SvelteKit', packages: ['@sveltejs/kit'], configs: ['svelte.config.js', 'svelte.config.ts'] },
  { id: 'svelte', label: 'Svelte', packages: ['svelte'], configs: ['svelte.config.js', 'svelte.config.ts'] },
  { id: 'astro', label: 'Astro', packages: ['astro'], configs: ['astro.config.js', 'astro.config.mjs', 'astro.config.ts'] },
  { id: 'gatsby', label: 'Gatsby', packages: ['gatsby'], configs: ['gatsby-config.js', 'gatsby-config.ts'] },
  { id: 'vue', label: 'Vue', packages: ['vue'], configs: ['vite.config.js', 'vite.config.ts', 'vue.config.js'] },
  { id: 'react', label: 'React', packages: ['react'], configs: ['vite.config.js', 'vite.config.ts'] },
];
const cleanPath = value => String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
const dirname = value => { const p = cleanPath(value); const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
const basename = value => cleanPath(value).split('/').pop() || '';
const join = (...parts) => parts.filter(Boolean).join('/');
function parseJsonFile(file) { try { return JSON.parse(file.content); } catch { return null; } }

function analyzeProject({ entries = [], files = [] } = {}) {
  const entryPaths = new Set(entries.map(item => cleanPath(item.path)));
  const fileByPath = new Map(files.map(file => [cleanPath(file.path), file]));
  const packageFiles = files.filter(file => basename(file.path) === 'package.json')
    .map(file => ({ path: cleanPath(file.path), root: dirname(file.path), json: parseJsonFile(file) }))
    .filter(item => item.json && typeof item.json === 'object');
  const candidates = new Map();
  for (const item of packageFiles) candidates.set(item.root, { root: item.root, pkg: item.json, score: 0, reasons: [] });
  for (const path of entryPaths) {
    const name = basename(path);
    if (FRAMEWORKS.some(framework => framework.configs.includes(name))) {
      const root = dirname(path);
      if (!candidates.has(root)) candidates.set(root, { root, pkg: null, score: 0, reasons: [] });
    }
  }
  for (const candidate of candidates.values()) {
    const dependencies = Object.assign({}, candidate.pkg?.dependencies, candidate.pkg?.devDependencies, candidate.pkg?.peerDependencies);
    for (const framework of FRAMEWORKS) {
      const configFound = framework.configs.some(name => entryPaths.has(join(candidate.root, name)));
      const packageFound = framework.packages.some(name => Object.prototype.hasOwnProperty.call(dependencies, name));
      if (packageFound) {
        candidate.score += ['react', 'vue', 'svelte'].includes(framework.id) ? 35 : 70;
        candidate.reasons.push(framework.label + ' dependency');
      }
      if (configFound) { candidate.score += 25; candidate.reasons.push(framework.label + ' configuration'); }
    }
    if (candidate.pkg?.scripts?.build) candidate.score += 8;
    if (candidate.pkg?.scripts?.dev) candidate.score += 4;
    if (candidate.root) candidate.score += 2;
  }
  const selected = [...candidates.values()].sort((a, b) => b.score - a.score)[0] || null;
  const root = selected?.root || '';
  const dependencies = Object.assign({}, selected?.pkg?.dependencies, selected?.pkg?.devDependencies, selected?.pkg?.peerDependencies);
  let framework = 'Static HTML / unknown';
  let frameworkId = 'static';
  for (const item of FRAMEWORKS) {
    if (item.packages.some(name => Object.prototype.hasOwnProperty.call(dependencies, name)) ||
        item.configs.some(name => entryPaths.has(join(root, name)))) {
      framework = item.label;
      frameworkId = item.id;
      const vite = entryPaths.has(join(root, 'vite.config.js')) || entryPaths.has(join(root, 'vite.config.ts'));
      if (vite && ['react', 'vue', 'svelte'].includes(item.id)) framework = item.label + ' + Vite';
      break;
    }
  }
  if (selected?.pkg && !Object.keys(dependencies).length && selected.pkg.name) framework = 'JavaScript project (framework not identified)';
  if (!selected && entryPaths.has('index.html')) framework = 'Static HTML';

  const hasPath = path => entryPaths.has(cleanPath(path));
  const hasDirectory = path => entries.some(item => item.type === 'tree' && cleanPath(item.path) === cleanPath(path)) ||
    [...entryPaths].some(item => item.startsWith(cleanPath(path) + '/'));
  let htmlEntry = '';
  let htmlCandidates;
  if (frameworkId === 'angular') htmlCandidates = [join(root, 'src/index.html'), join(root, 'index.html')];
  else if (['react', 'vue', 'svelte'].includes(frameworkId)) htmlCandidates = [join(root, 'index.html'), join(root, 'public/index.html')];
  else if (['next', 'nuxt', 'sveltekit'].includes(frameworkId)) htmlCandidates = [join(root, 'app/layout.tsx'), join(root, 'src/app/layout.tsx'), join(root, 'pages/_document.tsx'), join(root, 'index.html')];
  else htmlCandidates = [join(root, 'index.html'), join(root, 'public/index.html'), 'index.html'];
  htmlEntry = htmlCandidates.find(path => path && hasPath(path)) || '';

  const publicCandidates = [join(root, 'public'), join(root, 'static'), join(root, 'www'), root];
  const publicDirectory = publicCandidates.find(path => path && hasDirectory(path)) || (root ? join(root, 'public') : 'public');
  const manifestCandidates = [join(publicDirectory, 'manifest.webmanifest'), join(publicDirectory, 'manifest.json'), join(root, 'manifest.webmanifest'), join(root, 'manifest.json')].filter(Boolean);
  const manifestPath = manifestCandidates.find(hasPath) || '';
  const manifestFile = manifestPath ? fileByPath.get(manifestPath) : null;
  const manifestJson = manifestFile ? parseJsonFile(manifestFile) : null;
  const html = htmlEntry ? (fileByPath.get(htmlEntry)?.content || '') : '';
  const manifestLinked = /<link\b(?=[^>]*\brel\s*=\s*["'][^"']*manifest[^"']*["'])[^>]*>/i.test(html) || /<link\b[^>]*\brel\s*=\s*manifest\b/i.test(html);
  const themeColorPresent = /<meta\b(?=[^>]*\bname\s*=\s*["']theme-color["'])[^>]*>/i.test(html);
  const viewportPresent = /<meta\b(?=[^>]*\bname\s*=\s*["']viewport["'])[^>]*>/i.test(html);
  const workerCandidates = [join(publicDirectory, 'service-worker.js'), join(publicDirectory, 'service-worker.ts'), join(publicDirectory, 'sw.js'), join(publicDirectory, 'sw.ts'), join(root, 'service-worker.js'), join(root, 'sw.js'), join(root, 'src/service-worker.js'), join(root, 'src/sw.js')].filter(Boolean);
  const workerPaths = workerCandidates.filter(hasPath);
  const sourceText = files.map(file => file.content || '').join('\n');
  const registrationDetected = /serviceWorker\s*(?:\.\s*register|\[\s*['"]register['"]\s*\])\s*\(/i.test(sourceText);
  const iconPaths = [...entryPaths].filter(path => /(^|\/)(?:icons?|assets?)\/[^/]+\.(?:png|webp|svg|jpe?g)$/i.test(path) && /(?:icon|logo|apple-touch)/i.test(basename(path))).slice(0, 20);
  const manifestIcons = Array.isArray(manifestJson?.icons) ? manifestJson.icons : [];
  const suitableManifestIcon = manifestIcons.some(icon => /(?:192x192|512x512|any)/i.test(String(icon?.sizes || '')) && typeof icon?.src === 'string');
  const checks = [
    { id: 'manifest', label: 'Web app manifest', status: manifestPath ? 'found' : 'missing', detail: manifestPath || 'No manifest.webmanifest or manifest.json found in the detected app/public root.' },
    { id: 'manifest-link', label: 'Manifest linked in HTML', status: manifestLinked ? 'found' : htmlEntry ? 'missing' : 'unknown', detail: manifestLinked ? 'Manifest link detected in ' + htmlEntry + '.' : htmlEntry ? 'No manifest link detected in ' + htmlEntry + '.' : 'Could not identify a conventional HTML entry point for this framework.' },
    { id: 'manifest-icons', label: 'Manifest app icons', status: suitableManifestIcon ? 'found' : manifestPath ? 'missing' : 'unknown', detail: suitableManifestIcon ? manifestIcons.length + ' manifest icon declaration(s) found, including a suitable size or scalable icon.' : manifestPath ? 'Manifest exists but no 192×192, 512×512, or scalable icon declaration was identified.' : 'Cannot verify icons until a manifest is available.' },
    { id: 'service-worker', label: 'Service worker', status: workerPaths.length || registrationDetected ? 'found' : 'optional', detail: workerPaths.length ? 'Possible worker file(s): ' + workerPaths.join(', ') + '.' : registrationDetected ? 'A service worker registration call was found in the inspected source files.' : 'No service worker file or registration was detected. This is optional for the current TWA preparation flow.' },
    { id: 'theme-color', label: 'Theme colour metadata', status: themeColorPresent ? 'found' : htmlEntry ? 'recommended' : 'unknown', detail: themeColorPresent ? 'A theme-color meta tag was found.' : 'A theme-color meta tag was not found in the inspected HTML entry.' },
    { id: 'viewport', label: 'Viewport metadata', status: viewportPresent ? 'found' : htmlEntry ? 'recommended' : 'unknown', detail: viewportPresent ? 'A viewport meta tag was found.' : 'A viewport meta tag was not found in the inspected HTML entry.' },
  ];
  const blockers = checks.filter(item => item.status === 'missing' && ['manifest', 'manifest-link', 'manifest-icons'].includes(item.id));
  const warnings = checks.filter(item => ['optional', 'recommended', 'unknown'].includes(item.status));
  return {
    profile: {
      framework, frameworkId,
      appRoot: root ? root + '/' : '/ (repository root)',
      packageFile: selected?.pkg ? (root ? root + '/package.json' : 'package.json') : '',
      packageName: selected?.pkg?.name || '',
      htmlEntry: htmlEntry || 'Not identified',
      publicDirectory: publicDirectory ? publicDirectory + '/' : '/',
      buildCommand: selected?.pkg?.scripts?.build || '',
      devCommand: selected?.pkg?.scripts?.dev || '',
      evidence: selected?.reasons || [],
    },
    checks, blockers, warnings,
    readiness: blockers.length === 0 ? 'No repository-level manifest blockers detected' : 'PWA setup required',
    assets: { manifestPath: manifestPath || null, serviceWorkerPaths: workerPaths, iconPaths, manifestIconCount: manifestIcons.length },
    notes: [
      'This is a static source inspection. It does not execute customer code or modify repository files.',
      'Live HTTPS, deployed manifest reachability, icon HTTP responses, and final TWA eligibility must still be verified by rescanning the deployed website.',
      'A service worker is optional for the current TWA preparation flow and will not be overwritten or generated automatically by this analysis.',
    ],
  };
}
export { analyzeProject };
