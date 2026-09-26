# Dependency inventory

Runtime and development dependencies from the lockfile. Each retains its license.

| Package | Version | License | Use |
|---|---|---|---|
| @types/node | 24.13.3 | MIT | Development |
| ajv | 8.20.0 | MIT | Runtime |
| fast-deep-equal | 3.1.3 | MIT | Runtime |
| fast-uri | 3.1.7 | BSD-3-Clause | Runtime |
| json-schema-traverse | 1.0.0 | MIT | Runtime |
| openai | 7.12.1 | Apache-2.0 | Runtime |
| require-from-string | 2.0.2 | MIT | Runtime |
| typescript | 5.9.3 | Apache-2.0 | Development |
| undici-types | 7.18.2 | MIT | Development |

## Dashboard (`web/`, served by the GitHub worker, not in the npm package)

Direct dependencies from `web/package-lock.json`. The bundle also includes the atmin
brand kit's customized shadcn/ui components (`web/LICENSE.shadcn`) and the Geist fonts
(`web/fonts/OFL.txt`).

| Package | Version | License | Use |
|---|---|---|---|
| class-variance-authority | 0.7.1 | Apache-2.0 | Runtime |
| clsx | 2.1.1 | MIT | Runtime |
| lucide-react | 1.45.0 | ISC | Runtime |
| radix-ui | 1.6.7 | MIT | Runtime |
| react | 19.2.4 | MIT | Runtime |
| react-dom | 19.2.4 | MIT | Runtime |
| tailwind-merge | 3.6.0 | MIT | Runtime |
| @tailwindcss/cli | 4.3.3 | MIT | Build |
| esbuild | 0.28.2 | MIT | Build |
| tailwindcss | 4.3.3 | MIT | Build |
| tw-animate-css | 1.4.0 | MIT | Build |
