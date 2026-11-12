# AzureScraper

Self-hosted, modular scraper with a web UI. Runs as a Docker container on Unraid.

- **Categories** are the square tiles on the home page (starting with **Groceries**).
- Each category holds **modules**, one per source (Kroger, Walmart, Meijer, Target, Aldi).
- Every module turns its source's raw data into one shared `Product` shape (`src/core/types.ts`).

| Module  | Status  | Method |
|---------|---------|--------|
| Kroger  | Working | Official Kroger Public API (OAuth2, JSON) |
| Walmart | Planned | Embedded JSON in page HTML |
| Meijer  | Planned | TBD |
| Target  | Planned | TBD |
| Aldi    | Planned | TBD |

## Run locally (Mac)

```bash
pnpm install
pnpm dev                  # http://localhost:3933 (reads .env, reloads on save)
```

## Docker / Unraid

```bash
docker compose up -d --build
```

Unraid template values:

- Port: `3933` -> `3933`
- Path: `/data` -> `/mnt/user/appdata/azurescraper`
- API keys are entered in the UI (Settings -> Connections), no template variables needed.

## Settings -> Connections

The gear button (top right) opens Settings. **Connections** stores API keys for any service:

- Pick a service from the dropdown and its fields appear (defined by each module, see below).
- **Custom API...** stores any name plus any number of key/value pairs, for future modules.
- Secrets are saved in `/data/connections.json` (file mode 600) and are never sent back to the
  browser, only a masked preview. Leave a secret blank when editing to keep the saved value.
- **Test** checks the credentials (Kroger: requests a token) before or after saving.
- Env vars (`KROGER_CLIENT_ID`, ...) still work as a fallback; a saved connection takes priority.

The app has no login, so keep it on your LAN or behind your reverse proxy's auth.

## Kroger setup

1. Create an account at <https://developer.kroger.com> and register an application.
2. Settings -> Connections -> choose **Kroger** -> paste Client ID and Secret -> Test -> Save.
3. Groceries -> Kroger -> enter a ZIP -> pick a store -> search.

Prices and stock levels only come back when a store (`locationId`) is selected.

## Project layout

```
src/
  server.ts                     Fastify server + REST API
  config.ts                     env-var configuration
  core/types.ts                 Product / ScraperModule / Category contracts
  core/registry.ts              which categories and modules exist
  core/connections.ts           saved API keys + provider registry
  modules/groceries/kroger/     Kroger API client + normalizer
  modules/groceries/planned.ts  placeholders for the other stores
public/                         plain HTML/CSS/JS UI
```

## Adding a store module

1. Create `src/modules/groceries/<store>/index.ts` that exports a `ScraperModule`.
2. Convert the store's raw data into `Product` objects.
3. Swap the placeholder in `src/core/registry.ts` for your module.
4. If it needs keys, call `registerProvider({...fields})` in the module (see Kroger) so it
   appears in Settings -> Connections, and read them with `resolveValues("<id>")`.
