'use strict';

const crypto = require('crypto');
const fs = require('fs');

const API_ROOT = 'https://api.github.com';
const COOKIE_NAME = 'webtoapp_github';
const SESSION_TTL_MS = 60 * 60 * 1000;
const STATE_TTL_MS = 10 * 60 * 1000;

function requiredEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    const error = new Error(`GitHub integration is not configured: missing ${name}.`);
    error.statusCode = 503;
    throw error;
  }
  return value.trim();
}

function readPrivateKey() {
  const keyPath = requiredEnv('GITHUB_PRIVATE_KEY_PATH');
  return fs.readFileSync(keyPath, 'utf8');
}

function createAppJwt() {
  const appId = requiredEnv('GITHUB_APP_ID');
  const privateKey = readPrivateKey();
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iat: now - 60,
    exp: now + 8 * 60,
    iss: appId,
  })}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), privateKey);
  return `${unsigned}.${signature.toString('base64url')}`;
}

async function githubRequest(url, { token, method = 'GET', body } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'WebToApp-GitHub-Integration',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof data.message === 'string' ? data.message : 'Unknown GitHub API error';
    const error = new Error(`GitHub API request failed (${response.status}): ${detail}`);
    error.statusCode = response.status === 404 ? 404 : 502;
    throw error;
  }
  return data;
}

async function exchangeOAuthCode(code) {
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'WebToApp-GitHub-Integration',
    },
    body: JSON.stringify({
      client_id: requiredEnv('GITHUB_CLIENT_ID'),
      client_secret: requiredEnv('GITHUB_CLIENT_SECRET'),
      code,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    const error = new Error(data.error_description || data.error || 'GitHub did not issue an OAuth access token.');
    error.statusCode = 502;
    throw error;
  }
  return data.access_token;
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return '';
}

function registerGitHubRoutes(app) {
  const sessions = new Map();
  const pendingStates = new Map();

  function pruneExpired() {
    const now = Date.now();
    for (const [state, createdAt] of pendingStates) {
      if (now - createdAt > STATE_TTL_MS) pendingStates.delete(state);
    }
    for (const [id, session] of sessions) {
      if (session.expiresAt <= now) sessions.delete(id);
    }
  }

  function currentSession(req) {
    pruneExpired();
    const id = readCookie(req, COOKIE_NAME);
    const session = id ? sessions.get(id) : null;
    if (!session || session.expiresAt <= Date.now()) return null;
    return session;
  }

  app.get('/api/integrations/github/status', (req, res) => {
    const session = currentSession(req);
    return res.json({
      connected: Boolean(session),
      account: session ? session.account : null,
      installationId: session ? session.installationId : null,
    });
  });

  // With "Request user authorization (OAuth) during installation" enabled,
  // GitHub installs the App first and then starts OAuth. The callback receives
  // an OAuth code; it does not reliably include installation_id or state.
  // We identify the installation using the authenticated GitHub username and
  // the App JWT, then verify the installation account before minting a token.
  app.get('/api/integrations/github/install', (req, res) => {
    try {
      const slug = requiredEnv('GITHUB_APP_SLUG');
      requiredEnv('GITHUB_CLIENT_ID');
      return res.redirect(
        302,
        `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`
      );
    } catch (error) {
      return res.status(error.statusCode || 500).json({ error: error.message });
    }
  });

  // Existing installations can authorize directly with an OAuth state value.
  // New installations may arrive through GitHub's automatic OAuth-on-install flow.
  app.get('/api/integrations/github/authorize', (req, res) => {
    try {
      const clientId = requiredEnv('GITHUB_CLIENT_ID');
      const callbackUrl = requiredEnv('GITHUB_CALLBACK_URL');
      const state = crypto.randomBytes(32).toString('hex');
      pruneExpired();
      pendingStates.set(state, Date.now());
      const target = new URL('https://github.com/login/oauth/authorize');
      target.searchParams.set('client_id', clientId);
      target.searchParams.set('redirect_uri', callbackUrl);
      target.searchParams.set('state', state);
      return res.redirect(302, target.toString());
    } catch (error) {
      return res.status(error.statusCode || 500).json({ error: error.message });
    }
  });

  app.get('/api/integrations/github/callback', async (req, res) => {
    const { code, state, error: oauthError, error_description: oauthErrorDescription } = req.query || {};

    if (oauthError) {
      return res.status(400).send(
        `GitHub authorization was not completed: ${String(oauthErrorDescription || oauthError)}`
      );
    }

    if (typeof code !== 'string' || !code.trim()) {
      return res.status(400).send('GitHub did not return an authorization code. Start again from WebToApp.');
    }

    // Validate state whenever WebToApp initiated the OAuth flow itself.
    // GitHub's automatic OAuth-on-install callback may omit state.
    if (state !== undefined) {
      pruneExpired();
      const createdAt = typeof state === 'string' ? pendingStates.get(state) : null;
      if (!createdAt || Date.now() - createdAt > STATE_TTL_MS) {
        return res.status(400).send('GitHub authorization expired or could not be verified. Start again from WebToApp.');
      }
      pendingStates.delete(state);
    }

    try {
      // Exchange the one-time OAuth code and use the resulting identity to
      // discover this GitHub App's installation for that exact account.
      const userAccessToken = await exchangeOAuthCode(code);
      const user = await githubRequest(`${API_ROOT}/user`, {
        token: userAccessToken,
      });

      if (!user.login) {
        throw new Error('GitHub did not return an account username.');
      }

      const appId = requiredEnv('GITHUB_APP_ID');
      const appJwt = createAppJwt();
      const installation = await githubRequest(
        `${API_ROOT}/users/${encodeURIComponent(user.login)}/installation`,
        { token: appJwt }
      );

      if (
        !installation.id ||
        !installation.account ||
        String(installation.account.login || '').toLowerCase() !== user.login.toLowerCase() ||
        String(installation.app_id) !== String(appId)
      ) {
        throw new Error('No matching WebToApp Integration installation was found for this GitHub account. Install the app on this account and try again.');
      }

      const installationToken = await githubRequest(
        `${API_ROOT}/app/installations/${installation.id}/access_tokens`,
        { token: appJwt, method: 'POST', body: {} }
      );

      if (!installationToken.token) {
        throw new Error('GitHub did not issue an installation access token.');
      }

      const sessionId = crypto.randomBytes(32).toString('hex');
      sessions.set(sessionId, {
        token: installationToken.token,
        account: user.login,
        installationId: String(installation.id),
        expiresAt: Date.now() + SESSION_TTL_MS,
      });

      const secureCookie = process.env.NODE_ENV === 'production' ? '; Secure' : '';
      res.setHeader('Set-Cookie', [
        `${COOKIE_NAME}=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secureCookie}`,
      ]);
      const frontendUrl = process.env.GITHUB_FRONTEND_URL || 'http://127.0.0.1:5173/github';
      return res.redirect(303, frontendUrl);
    } catch (error) {
      console.error('[github callback]', error.message);
      return res.status(error.statusCode || 502).send(
        'GitHub connection could not be completed. Check that the GitHub App is installed on the same account you authorized, then try again.'
      );
    }
  });

  app.get('/api/integrations/github/repositories', async (req, res) => {
    const session = currentSession(req);
    if (!session) {
      return res.status(401).json({ error: 'Connect your GitHub account first.' });
    }

    const page = Number(req.query.page || 1);
    if (!Number.isInteger(page) || page < 1 || page > 100) {
      return res.status(400).json({ error: 'Invalid repository page.' });
    }

    try {
      const result = await githubRequest(
        `${API_ROOT}/installation/repositories?per_page=100&page=${page}`,
        { token: session.token }
      );
      return res.json({
        account: session.account,
        totalCount: result.total_count || 0,
        repositories: (result.repositories || []).map((repo) => ({
          id: repo.id,
          name: repo.name,
          fullName: repo.full_name,
          private: repo.private,
          defaultBranch: repo.default_branch,
          htmlUrl: repo.html_url,
          description: repo.description,
          permissions: repo.permissions
            ? { contents: repo.permissions.contents, pullRequests: repo.permissions.pull_requests }
            : undefined,
        })),
      });
    } catch (error) {
      console.error('[github repositories]', error.message);
      return res.status(error.statusCode || 502).json({ error: 'Could not load GitHub repositories. Please reconnect the GitHub App.' });
    }
  });


  async function getAuthorizedRepository(session, fullName) {
    if (typeof fullName !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) {
      const error = new Error('Choose a valid repository.');
      error.statusCode = 400;
      throw error;
    }

    const result = await githubRequest(
      `${API_ROOT}/installation/repositories?per_page=100&page=1`,
      { token: session.token }
    );
    const repository = (result.repositories || []).find(
      (repo) => repo.full_name.toLowerCase() === fullName.toLowerCase()
    );
    if (!repository) {
      const error = new Error('This repository is not available to the connected GitHub App installation.');
      error.statusCode = 403;
      throw error;
    }
    return repository;
  }

  app.get('/api/integrations/github/branches', async (req, res) => {
    const session = currentSession(req);
    if (!session) return res.status(401).json({ error: 'Connect your GitHub account first.' });

    try {
      const repository = await getAuthorizedRepository(session, req.query.repository);
      const [owner, repo] = repository.full_name.split('/');
      const result = await githubRequest(
        `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100`,
        { token: session.token }
      );
      return res.json({
        repository: repository.full_name,
        branches: (result || []).map((branch) => ({
          name: branch.name,
          commitSha: branch.commit?.sha || null,
        })),
      });
    } catch (error) {
      console.error('[github branches]', error.message);
      return res.status(error.statusCode || 502).json({ error: error.message });
    }
  });

  app.get('/api/integrations/github/tree', async (req, res) => {
    const session = currentSession(req);
    if (!session) return res.status(401).json({ error: 'Connect your GitHub account first.' });

    const branchName = typeof req.query.branch === 'string' ? req.query.branch : '';
    if (!branchName || branchName.length > 255) {
      return res.status(400).json({ error: 'Choose a valid branch.' });
    }

    try {
      const repository = await getAuthorizedRepository(session, req.query.repository);
      const [owner, repo] = repository.full_name.split('/');
      const branches = await githubRequest(
        `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100`,
        { token: session.token }
      );
      const branch = (branches || []).find((item) => item.name === branchName);
      const commitSha = branch?.commit?.sha;
      if (!commitSha) {
        const error = new Error('The selected branch could not be found.');
        error.statusCode = 404;
        throw error;
      }

      // The branches endpoint reliably provides the commit SHA. Resolve the
      // commit separately to obtain its tree SHA instead of relying on a
      // nested commit.commit.tree shape that may not be present.
      const commit = await githubRequest(
        `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${commitSha}`,
        { token: session.token }
      );
      const treeSha = commit?.tree?.sha;
      if (!treeSha) {
        const error = new Error('GitHub did not return a source tree for the selected branch.');
        error.statusCode = 502;
        throw error;
      }

      const tree = await githubRequest(
        `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${treeSha}?recursive=1`,
        { token: session.token }
      );
      const entries = (tree.tree || []).slice(0, 1500).map((entry) => ({
        path: entry.path,
        type: entry.type,
        size: entry.size || 0,
      }));

      const rootFiles = new Set(entries.filter((entry) => entry.type === 'blob' && !entry.path.includes('/')).map((entry) => entry.path));
      const packageJson = entries.some((entry) => entry.type === 'blob' && entry.path === 'package.json');
      const framework = rootFiles.has('next.config.js') || rootFiles.has('next.config.mjs') || rootFiles.has('next.config.ts')
        ? 'Next.js'
        : rootFiles.has('vite.config.js') || rootFiles.has('vite.config.ts')
          ? 'Vite'
          : rootFiles.has('angular.json')
            ? 'Angular'
            : rootFiles.has('nuxt.config.js') || rootFiles.has('nuxt.config.ts')
              ? 'Nuxt'
              : rootFiles.has('gatsby-config.js')
                ? 'Gatsby'
                : rootFiles.has('manage.py')
                  ? 'Django'
                  : packageJson
                    ? 'JavaScript project (framework not yet identified)'
                    : rootFiles.has('index.html')
                      ? 'Static HTML'
                      : 'Not identified';

      return res.json({
        repository: repository.full_name,
        branch: branchName,
        commitSha: branch.commit.sha,
        framework,
        totalEntries: (tree.tree || []).length,
        truncated: Boolean(tree.truncated) || (tree.tree || []).length > entries.length,
        entries,
      });
    } catch (error) {
      console.error('[github tree]', error.message);
      return res.status(error.statusCode || 502).json({ error: error.message });
    }
  });


  app.get('/api/integrations/github/file', async (req, res) => {
    const session = currentSession(req);
    if (!session) return res.status(401).json({ error: 'Connect your GitHub account first.' });

    const branchName = typeof req.query.branch === 'string' ? req.query.branch : '';
    const filePath = typeof req.query.path === 'string' ? req.query.path : '';
    if (!branchName || branchName.length > 255 || !filePath || filePath.length > 500 ||
        filePath.startsWith('/') || filePath.split('/').some(part => !part || part === '.' || part === '..')) {
      return res.status(400).json({ error: 'Choose a valid branch and repository file path.' });
    }

    const blockedPath = /(^|\/)(?:\.git|node_modules|vendor|dist|build|coverage|\.next|\.venv|venv|secrets?)(\/|$)/i;
    const blockedFile = /(^|\/)(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx|jks|keystore)|id_rsa|credentials?(?:\.json)?|secrets?(?:\.json)?)$/i;
    const allowedText = /\.(?:json|html?|[cm]?js|jsx|tsx?|css|scss|sass|less|vue|svelte|md|ya?ml|toml|xml|txt|webmanifest|config)$/i;
    if (blockedPath.test(filePath) || blockedFile.test(filePath) || !allowedText.test(filePath)) {
      return res.status(403).json({ error: 'This file type or path is not available for source inspection.' });
    }

    try {
      const repository = await getAuthorizedRepository(session, req.query.repository);
      const [owner, repo] = repository.full_name.split('/');
      const branches = await githubRequest(
        `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100`,
        { token: session.token }
      );
      if (!(branches || []).some(item => item.name === branchName)) {
        return res.status(404).json({ error: 'The selected branch could not be found.' });
      }

      const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
      const file = await githubRequest(
        `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}?ref=${encodeURIComponent(branchName)}`,
        { token: session.token }
      );
      if (Array.isArray(file) || file.type !== 'file' || typeof file.content !== 'string') {
        return res.status(400).json({ error: 'The selected path is not a readable file.' });
      }
      const buffer = Buffer.from(file.content.replace(/\n/g, ''), 'base64');
      if (buffer.length > 256 * 1024) {
        return res.status(413).json({ error: 'This file exceeds the 256 KB source inspection limit.' });
      }
      const textContent = buffer.toString('utf8');
      if (textContent.includes('\u0000')) {
        return res.status(415).json({ error: 'Binary files cannot be read as source text.' });
      }

      return res.json({
        repository: repository.full_name,
        branch: branchName,
        path: file.path,
        size: buffer.length,
        sha: file.sha,
        content: textContent,
      });
    } catch (error) {
      console.error('[github file]', error.message);
      return res.status(error.statusCode || 502).json({ error: error.message });
    }
  });

  app.post('/api/integrations/github/files', async (req, res) => {
    const session = currentSession(req);
    if (!session) return res.status(401).json({ error: 'Connect your GitHub account first.' });

    const branchName = typeof req.body?.branch === 'string' ? req.body.branch : '';
    const paths = Array.isArray(req.body?.paths) ? req.body.paths : [];
    if (!branchName || branchName.length > 255 || paths.length < 1 || paths.length > 10 ||
        paths.some(filePath => typeof filePath !== 'string' || filePath.length > 500 ||
          filePath.startsWith('/') || filePath.split('/').some(part => !part || part === '.' || part === '..'))) {
      return res.status(400).json({ error: 'Choose a valid branch and between 1 and 10 project file paths.' });
    }

    const blockedPath = /(^|\/)(?:\.git|node_modules|vendor|dist|build|coverage|\.next|\.venv|venv|secrets?)(\/|$)/i;
    const blockedFile = /(^|\/)(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx|jks|keystore)|id_rsa|credentials?(?:\.json)?|secrets?(?:\.json)?)$/i;
    const allowedText = /\.(?:json|html?|[cm]?js|jsx|tsx?|css|scss|sass|less|vue|svelte|md|ya?ml|toml|xml|txt|webmanifest|config)$/i;
    if (paths.some(filePath => blockedPath.test(filePath) || blockedFile.test(filePath) || !allowedText.test(filePath))) {
      return res.status(403).json({ error: 'One or more requested files are not available for source inspection.' });
    }

    try {
      const repository = await getAuthorizedRepository(session, req.body.repository);
      const [owner, repo] = repository.full_name.split('/');
      const branches = await githubRequest(
        `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100`,
        { token: session.token }
      );
      if (!(branches || []).some(item => item.name === branchName)) {
        return res.status(404).json({ error: 'The selected branch could not be found.' });
      }

      const results = await Promise.all(paths.map(async filePath => {
        const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
        const file = await githubRequest(
          `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}?ref=${encodeURIComponent(branchName)}`,
          { token: session.token }
        );
        if (Array.isArray(file) || file.type !== 'file' || typeof file.content !== 'string') {
          throw new Error(`The selected path is not a readable file: ${filePath}`);
        }
        const buffer = Buffer.from(file.content.replace(/\n/g, ''), 'base64');
        if (buffer.length > 256 * 1024) throw new Error(`File exceeds the 256 KB limit: ${filePath}`);
        const content = buffer.toString('utf8');
        if (content.includes('\u0000')) throw new Error(`Binary files cannot be read: ${filePath}`);
        return { repository: repository.full_name, branch: branchName, path: file.path, size: buffer.length, sha: file.sha, content };
      }));
      return res.json({ files: results });
    } catch (error) {
      console.error('[github files]', error.message);
      return res.status(error.statusCode || 502).json({ error: error.message });
    }
  });

  app.post('/api/integrations/github/disconnect', (req, res) => {
    const id = readCookie(req, COOKIE_NAME);
    if (id) sessions.delete(id);
    res.setHeader('Set-Cookie', [
      `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
    ]);
    return res.json({ connected: false });
  });
}

module.exports = { registerGitHubRoutes };
