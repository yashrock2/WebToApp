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
    const error = new Error(
      response.status === 401 || response.status === 403
        ? 'GitHub authorization failed. Reconnect the GitHub App and check its permissions.'
        : 'GitHub could not complete the requested operation.'
    );
    error.statusCode = response.status === 404 ? 404 : 502;
    throw error;
  }
  return data;
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
  const pendingStates = new Map();
  const sessions = new Map();

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

  app.get('/api/integrations/github/install', (req, res) => {
    try {
      const slug = requiredEnv('GITHUB_APP_SLUG');
      requiredEnv('GITHUB_CLIENT_ID');
      const state = crypto.randomBytes(32).toString('hex');
      pruneExpired();
      pendingStates.set(state, Date.now());
      const target = new URL(`https://github.com/apps/${encodeURIComponent(slug)}/installations/new`);
      target.searchParams.set('state', state);
      return res.redirect(302, target.toString());
    } catch (error) {
      return res.status(error.statusCode || 500).json({ error: error.message });
    }
  });

  app.get('/api/integrations/github/callback', async (req, res) => {
    const { code, state, installation_id: installationId } = req.query || {};
    if (
      typeof code !== 'string' ||
      typeof state !== 'string' ||
      typeof installationId !== 'string' ||
      !/^\d+$/.test(installationId)
    ) {
      return res.status(400).send('GitHub did not return a valid installation authorization.');
    }

    pruneExpired();
    const createdAt = pendingStates.get(state);
    pendingStates.delete(state);
    if (!createdAt || Date.now() - createdAt > STATE_TTL_MS) {
      return res.status(400).send('GitHub authorization expired or the state could not be verified. Start again from WebToApp.');
    }

    try {
      const clientId = requiredEnv('GITHUB_CLIENT_ID');
      const clientSecret = requiredEnv('GITHUB_CLIENT_SECRET');
      const tokenResponse = await githubRequest('https://github.com/login/oauth/access_token', {
        method: 'POST',
        body: { client_id: clientId, client_secret: clientSecret, code },
      });
      if (!tokenResponse.access_token) {
        return res.status(502).send('GitHub did not issue an authorization token. Please reconnect.');
      }

      const user = await githubRequest(`${API_ROOT}/user`, {
        token: tokenResponse.access_token,
      });
      const appJwt = createAppJwt();

      // Confirm that the installation belongs to this GitHub App before minting a token.
      const installation = await githubRequest(
        `${API_ROOT}/app/installations/${installationId}`,
        { token: appJwt }
      );
      const installationToken = await githubRequest(
        `${API_ROOT}/app/installations/${installationId}/access_tokens`,
        { token: appJwt, method: 'POST', body: {} }
      );

      if (!installationToken.token) {
        throw new Error('GitHub did not issue an installation token.');
      }

      const sessionId = crypto.randomBytes(32).toString('hex');
      sessions.set(sessionId, {
        token: installationToken.token,
        account: user.login,
        installationId: String(installation.id),
        expiresAt: Date.now() + SESSION_TTL_MS,
      });

      res.setHeader('Set-Cookie', [
        `${COOKIE_NAME}=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
      ]);
      return res.redirect(303, '/');
    } catch (error) {
      console.error('[github callback]', error.message);
      return res.status(error.statusCode || 502).send(
        'GitHub connection could not be completed. Check the local WebToApp server configuration and try again.'
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
