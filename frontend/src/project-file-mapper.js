const normalize = value => String(value || '').replace(/\\/g, '/').replace(/^\\/+|\\/+$/g, '');
const basename = value => normalize(value).split('/').pop() || '';

function mapPwaBundleToProject({ bundle = [], profile = {}, entries = [] } = {}) {
  if (!Array.isArray(bundle) || !bundle.length) {
    throw new Error('A generated PWA file bundle is required.');
  }
  const publicRoot = normalize(profile.publicDirectory || 'public');
  const existing = new Set(entries.map(item => normalize(item.path)));
  const files = bundle.map(file => {
    const relativePath = normalize(file.path);
    if (!relativePath || relativePath.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error('The generated bundle contains an unsafe file path.');
    }
    const targetPath = [publicRoot, relativePath].filter(Boolean).join('/');
    return {
      sourcePath: relativePath,
      targetPath,
      contentType: file.contentType || 'application/octet-stream',
      sizeBytes: Number(file.sizeBytes || 0),
      conflict: existing.has(targetPath),
      action: existing.has(targetPath) ? 'review-required' : 'create',
      reason: existing.has(targetPath)
        ? 'A file already exists at this path. It must be reviewed; it will not be overwritten automatically.'
        : 'No file exists at this path. A future Pull Request can add it safely.'
    };
  });

  const htmlEntry = normalize(profile.htmlEntry);
  const frameworkId = profile.frameworkId || 'static';
  const integration = {
    file: htmlEntry || null,
    method: ['next', 'nuxt', 'sveltekit'].includes(frameworkId)
      ? 'framework-metadata'
      : 'html-head',
    instruction: htmlEntry
      ? ['next', 'nuxt', 'sveltekit'].includes(frameworkId)
        ? 'Add manifest and theme metadata using the framework metadata API in the identified app entry. Do not inject HTML tags blindly.'
        : 'Add a manifest link and theme-color meta tag inside the existing HTML head. Preserve all current tags.'
      : 'The HTML integration point could not be identified automatically. Manual review is required.'
  };

  return {
    publicDirectory: publicRoot || '/',
    files,
    integration,
    hasConflicts: files.some(file => file.conflict),
    safeToCreateAll: files.every(file => !file.conflict),
    notes: [
      'This is a proposed file mapping only. No repository files are changed.',
      'Existing files are never overwritten automatically.',
      'HTML integration is described separately and requires a framework-aware patch before a Pull Request is created.'
    ]
  };
}

export { mapPwaBundleToProject };
