// URL <-> view mapping, kept pure so tests can pin it. GitHub PR comments already link to
// /?repository=<id>#review/<runId>; those links must keep opening the same review.
const repositoryId = /^[1-9][0-9]{0,15}$/;
const runId = /^[a-zA-Z0-9-]{1,100}$/;

export const signinMessages = {
  denied: 'GitHub did not grant access. Sign in again.',
  expired: 'The sign-in link expired. Sign in again.',
  busy: 'Sign-in is busy. Try again in a minute.',
  unavailable: 'GitHub or atmin is unavailable. Try again shortly.',
};

// A parameter counts only when it appears once, as the server requires.
function single(params, name, pattern) {
  const values = params.getAll(name);
  return values.length === 1 && pattern.test(values[0]) ? values[0] : null;
}

export function parseRoute(href) {
  const url = new URL(href, 'https://review.atmin.ai');
  const params = url.searchParams;
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const code = params.get('signin');
  const signin = Object.hasOwn(signinMessages, code ?? '') ? code : null;
  const installation = single(params, 'installation', repositoryId);
  const base = { signin, installation: installation && Number(installation) };
  if (path === '/admin') return { ...base, view: 'admin' };
  if (path === '/usage') return { ...base, view: 'usage' };
  if (path !== '/') return { ...base, view: 'not-found' };
  const repository = single(params, 'repository', repositoryId);
  if (!repository) return { ...base, view: 'repositories' };
  const hash = /^#review\/(.+)$/.exec(url.hash)?.[1];
  const review = hash && runId.test(hash) ? hash : null;
  return { ...base, view: 'repository', repository: Number(repository), review };
}

export function routeHref(route) {
  const query = id => (id ? `?installation=${id}` : '');
  switch (route.view) {
    case 'admin': return '/admin';
    case 'usage': return `/usage${query(route.installation)}`;
    case 'repository': return `/?repository=${route.repository}${route.review ? `#review/${route.review}` : ''}`;
    default: return `/${query(route.installation)}`;
  }
}

// Sign-in keeps a review deep link: the server returns to /?repository=<id>#review/<runId>.
export function signInHref(route) {
  const params = new URLSearchParams();
  if (route.view === 'repository') {
    params.set('repository', String(route.repository));
    if (route.review) params.set('review', route.review);
  }
  const query = params.toString();
  return `/auth/github${query ? `?${query}` : ''}`;
}
