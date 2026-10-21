// Sign-in with the Cognito hosted login page (authorization code flow with PKCE).
// In the local dev copy (config.mode === 'dev') a person is picked from a list instead.

const KEY = 'urlaubsplaner.session';
const PENDING = 'urlaubsplaner.pkce';

let config = null;
let session = null;

export async function initAuth() {
  config = await (await fetch('config.json', { cache: 'no-store' })).json();
  session = read(KEY);

  if (config.mode === 'dev') return config;

  const params = new URLSearchParams(location.search);
  if (params.has('code')) {
    await finishLogin(params.get('code'), params.get('state'));
    history.replaceState(null, '', location.pathname);
  } else if (params.has('error')) {
    history.replaceState(null, '', location.pathname);
  }
  return config;
}

export function isSignedIn() {
  return !!session;
}

export function devUsers() {
  return config?.mode === 'dev' ? config.users : null;
}

export function devSignIn(userId) {
  session = { dev: userId };
  write(KEY, session);
}

export async function signIn() {
  const verifier = randomString(64);
  const state = randomString(24);
  write(PENDING, { verifier, state });
  const url = new URL(`${config.cognitoDomain}/oauth2/authorize`);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: redirectUri(),
    scope: 'openid',
    state,
    code_challenge_method: 'S256',
    code_challenge: await challenge(verifier),
  });
  location.assign(url);
}

export function signOut() {
  sessionStorage.removeItem(KEY);
  session = null;
  if (config.mode === 'dev') {
    location.reload();
    return;
  }
  const url = new URL(`${config.cognitoDomain}/logout`);
  url.search = new URLSearchParams({ client_id: config.clientId, logout_uri: redirectUri() });
  location.assign(url);
}

// Headers for an API call; refreshes the access token when it is about to run out.
export async function authHeaders() {
  if (!session) return {};
  if (session.dev) return { 'x-dev-user': session.dev };
  if (Date.now() > session.expiresAt - 60_000) await refresh();
  return session ? { authorization: `Bearer ${session.accessToken}` } : {};
}

export async function refresh() {
  if (!session?.refreshToken) {
    forget();
    return false;
  }
  const res = await tokenRequest({ grant_type: 'refresh_token', refresh_token: session.refreshToken });
  if (!res) {
    forget();
    return false;
  }
  store({ ...res, refresh_token: session.refreshToken });
  return true;
}

async function finishLogin(code, state) {
  const pending = read(PENDING);
  sessionStorage.removeItem(PENDING);
  if (!pending || pending.state !== state) return;
  const res = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    code_verifier: pending.verifier,
  });
  if (res) store(res);
}

async function tokenRequest(fields) {
  try {
    const res = await fetch(`${config.cognitoDomain}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.clientId, ...fields }),
    });
    return res.ok ? res.json() : null;
  } catch {
    return null;
  }
}

function store(tokens) {
  session = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  };
  write(KEY, session);
}

function forget() {
  session = null;
  sessionStorage.removeItem(KEY);
}

function redirectUri() {
  return `${location.origin}/`;
}

function randomString(length) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[b % 64]).join('');
}

async function challenge(verifier) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function read(key) {
  try {
    return JSON.parse(sessionStorage.getItem(key));
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // private mode without storage: the session lasts until the page is reloaded
  }
}
