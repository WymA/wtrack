# Cloudflare Worker Template

A minimal TypeScript starter for building and deploying a Cloudflare Worker.

## Getting started

```sh
pnpm install
pnpm dev
```

Open the local URL printed by Wrangler. A `GET /` request returns a greeting; other paths return `404`.

If pnpm is not installed, install it first with `npm install --global pnpm`.

## Commands

- `pnpm dev` — start the local development server.
- `pnpm typecheck` — type-check the Worker source.
- `pnpm deploy` — deploy the Worker with Wrangler.

Update the Worker name and compatibility date in `wrangler.jsonc` before deploying.
