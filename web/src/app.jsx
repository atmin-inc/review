import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api, onSessionEnded } from './api.js';
import { parseRoute, routeHref, signinMessages } from './route.js';
import { Navigation, Link, Loading, Mark, Notice, PageHeader } from './components.jsx';
import { Button } from './ui/button.jsx';
import { Landing, NoInstallations } from './landing.jsx';
import { Shell } from './shell.jsx';
import { RepositoriesPage } from './repositories.jsx';
import { UsagePage } from './usage.jsx';
import { RepositoryPage } from './repository.jsx';
import { AdminPage } from './admin.jsx';

export function App() {
  const [route, setRoute] = useState(() => parseRoute(window.location.href));
  const [session, setSession] = useState(null);
  const [failure, setFailure] = useState(null);
  const [ended, setEnded] = useState(null);

  const navigate = useCallback(href => {
    const before = parseRoute(window.location.href);
    window.history.pushState(null, '', href);
    const next = parseRoute(window.location.href);
    setRoute(next);
    // Opening or closing a review keeps the repository page where it was.
    if (before.view !== next.view || before.repository !== next.repository || before.installation !== next.installation) window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    const sync = () => setRoute(parseRoute(window.location.href));
    window.addEventListener('popstate', sync);
    window.addEventListener('hashchange', sync);
    return () => { window.removeEventListener('popstate', sync); window.removeEventListener('hashchange', sync); };
  }, []);

  const loadSession = useCallback(async repository => {
    try {
      setSession(await api.session(repository));
      setFailure(null);
    } catch (error) {
      if (error.status !== 401 && error.status !== 403) setFailure(error);
    }
  }, []);

  useEffect(() => {
    // 401: signed out. 403 outside /admin: the server ended the session; say why on sign-in.
    onSessionEnded(error => {
      setEnded(error.status === 403 ? error.message : null);
      setSession(current => ({ ...current, user: null }));
      api.session().then(setSession, () => {});
    });
    const initial = parseRoute(window.location.href);
    loadSession(initial.view === 'repository' ? initial.repository : undefined);
  }, [loadSession]);

  const signOut = useCallback(async () => {
    try { await api.logout(); } catch { /* The session may already be gone. */ }
    setEnded(null);
    window.history.pushState(null, '', '/');
    setRoute(parseRoute(window.location.href));
    setSession(null);
    loadSession();
  }, [loadSession]);

  // Local updates after a connect or on/off change, so the list reflects them immediately.
  const patchRepository = useCallback((id, change) => setSession(current => ({
    ...current,
    connections: { ...current.connections, repositories: current.connections.repositories.map(r => (r.id === id ? { ...r, ...change } : r)) },
  })), []);

  if (!session) {
    return <div className="grid min-h-dvh place-items-center p-4">
      {failure
        ? <div className="grid max-w-sm justify-items-start gap-4">
          <Mark size={24}/>
          <Notice tone="error">{failure.message}</Notice>
          <Button variant="outline" onClick={() => { setFailure(null); loadSession(route.repository); }}><RefreshCw aria-hidden="true"/>Try again</Button>
        </div>
        : <Loading>Loading atmin review</Loading>}
    </div>;
  }

  if (!session.user) {
    return <Landing route={route} installUrl={session.installUrl} error={ended ?? (route.signin && signinMessages[route.signin])}/>;
  }

  const connections = session.connections ?? { installations: [], repositories: [], maxRepositories: 10 };
  const { installations, repositories } = connections;
  if (!installations.length) {
    return <NoInstallations user={session.user} installUrl={connections.installUrl} onSignOut={signOut}/>;
  }

  const owner = route.view === 'repository' ? repositories.find(r => r.id === route.repository)?.installationId : undefined;
  const selected = installations.find(i => i.id === route.installation)
    ?? installations.find(i => i.id === owner) ?? installations[0];

  let page;
  if (route.view === 'repositories') {
    page = <RepositoriesPage installation={selected} connections={connections} patchRepository={patchRepository}/>;
  } else if (route.view === 'usage') {
    page = <UsagePage installation={selected}/>;
  } else if (route.view === 'repository') {
    const listed = repositories.find(r => r.id === route.repository);
    page = <RepositoryPage key={route.repository} id={route.repository} review={route.review} listed={listed} installation={selected}
      initial={session.repository?.id === route.repository ? session : null} patchRepository={patchRepository}/>;
  } else if (route.view === 'admin') {
    page = <AdminPage operator={session.operator === true}/>;
  } else {
    page = <>
      <PageHeader title="Page not found">This address does not match a page in atmin review.</PageHeader>
      <Link className="link" href={routeHref({ view: 'repositories', installation: selected.id })}>Go to repositories</Link>
    </>;
  }

  return <Navigation.Provider value={navigate}>
    <Shell session={session} installation={selected} route={route} onSignOut={signOut}>{page}</Shell>
  </Navigation.Provider>;
}
