// Same-origin JSON API client. Errors carry the server's sentence for the user.
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const fallback = {
  0: 'atmin review could not be reached. Check your connection and try again.',
  401: 'Sign in with GitHub to continue.',
  403: 'Your session ended. Sign in again.',
  404: 'Not found.',
  409: 'This change conflicts with the current state. Reload and try again.',
  413: 'Request too large.',
  429: 'Too many requests. Try again in a minute.',
};

let sessionEnded = () => {};
// 401 anywhere, or 403 outside /admin, means the server no longer has a session for us.
export function onSessionEnded(handler) { sessionEnded = handler; }

async function request(method, path, body) {
  let response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, fallback[0]);
  }
  let data = null;
  try { data = await response.json(); } catch { /* An empty or non-JSON body uses the fallback sentence. */ }
  if (response.ok) return data;
  const error = new ApiError(response.status, typeof data?.error === 'string' ? data.error
    : fallback[response.status] ?? 'The review service is unavailable. Try again shortly.');
  const admin = path.startsWith('/api/review/v1/admin');
  if (response.status === 401 || (response.status === 403 && !admin)) sessionEnded(error);
  throw error;
}

const base = '/api/review/v1';
const repo = id => `repository=${encodeURIComponent(id)}`;

export const api = {
  session: repository => request('GET', `${base}/session${repository ? `?${repo(repository)}` : ''}`),
  dashboard: repository => request('GET', `${base}/dashboard?${repo(repository)}`),
  review: (repository, run) => request('GET', `${base}/reviews/${encodeURIComponent(run)}?${repo(repository)}`),
  connect: repository => request('POST', `${base}/connect?${repo(repository)}`, {}),
  setEnabled: (repository, enabled) => request('POST', `${base}/enabled?${repo(repository)}`, { enabled }),
  saveSettings: (repository, settings) => request('POST', `${base}/settings?${repo(repository)}`, settings),
  logout: () => request('POST', `${base}/logout`, {}),
  admin: () => request('GET', `${base}/admin`),
  savePlan: (installation, plan) => request('POST', `${base}/admin/plan?installation=${encodeURIComponent(installation)}`, plan),
};
