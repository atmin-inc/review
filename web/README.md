# atmin review web

The dashboard the review worker serves at https://review.atmin.ai: sign-in, repositories, usage, repository runs and settings, review detail, and the operator panel at `/admin`. React 19 with the atmin kit components in `src/ui/`, bundled by esbuild and styled with Tailwind v4.

## Build

```sh
npm --prefix web ci
npm --prefix web run build
```

`build.mjs` writes `web/dist/`:

- `index.html` has no inline script, style tag or style attribute, which the worker's CSP requires. The build fails if one appears.
- `assets/` holds scripts, CSS, fonts and logos, each with a content hash in its name, because the worker serves `/assets/*` as immutable. `favicon.ico` sits at the root without a hash.
- The Geist TTFs in `fonts/` become WOFF2 through `scripts/woff2.mjs`, a zero-dependency encoder, because the worker does not serve `.ttf`.

`dist/` is gitignored, so deploys run the build.

`src/theme.css` and `src/ui/*` are the brand kit's files. Only their import paths have changed. App layout lives in `src/app.css`.

## Test

```sh
npm --prefix web test
```

The tests cover the URL parsing in `src/route.js` (deep links `/?repository=<id>#review/<runId>` and `/admin`), money and date formatting, and the WOFF2 encoder.

## Mock server

`scripts/mock-api.mjs` serves `dist/` with the worker's CSP and cache headers, and fakes the JSON API from fixtures. It has no dependencies.

```sh
npm --prefix web run build
MOCK_SCENARIO=customer node web/scripts/mock-api.mjs   # http://localhost:4173
```

| Variable | Values |
|---|---|
| `MOCK_SCENARIO` | `signed-out`, `no-installations`, `customer` (default), `operator` (admin with 3 customers), `limit-reached` |
| `PORT` | default `4173` |
| `MOCK_DELAY` | API delay in ms, default `120` |

In the mock, `/auth/github` signs straight back in and returns to the deep link. In the `signed-out` scenario it returns `?signin=denied`. Sign out, and any 403 outside `/admin`, end the mock session the way the worker does.
