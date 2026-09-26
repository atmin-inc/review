import { useCallback, useEffect, useRef, useState } from 'react';

// Loads data for a key. A reload keeps the data already shown for that key, so a refresh
// never blanks a table; a new key starts empty. `initial` skips the first request.
export function useResource(key, load, initial = null) {
  const [state, setState] = useState(() => ({ key, data: initial, error: null, loading: initial === null }));
  const [version, setVersion] = useState(0);
  const loader = useRef(load);
  loader.current = load;
  const skip = useRef(initial !== null);
  useEffect(() => {
    if (skip.current) { skip.current = false; return undefined; }
    let live = true;
    setState(current => (current.key === key ? { ...current, loading: true, error: null } : { key, data: null, error: null, loading: true }));
    loader.current().then(
      data => { if (live) setState({ key, data, error: null, loading: false }); },
      error => { if (live) setState(current => ({ key, data: current.key === key ? current.data : null, error, loading: false })); },
    );
    return () => { live = false; };
  }, [key, version]);
  const reload = useCallback(() => setVersion(value => value + 1), []);
  const update = useCallback(change => setState(current => ({ ...current, data: change(current.data) })), []);
  const current = state.key === key ? state : { key, data: null, error: null, loading: true };
  return { ...current, reload, update };
}
