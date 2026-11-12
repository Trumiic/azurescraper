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

## Saving items to PostgreSQL

1. Settings -> Connections -> **PostgreSQL**: host (e.g. `192.168.1.76`), port, database, user,
   password. Optional: table name (default `grocery_items`). Click **Test**, then **Save**.
2. On the Kroger page pick a store, search, then click **Save to database** on a product or
   **Save all to database**. Saved products show **In database**.

Each save fetches the full product (`/products/{id}`) so nutrition facts and ingredients are
included when Kroger provides them. Re-saving updates the existing row (matched on
`store` + `store_product_id`) and never erases a known price, nutrition, ingredients or image.
The **Raw** link on a product card shows Kroger's untouched JSON for that product.

The table is created automatically on first save:

```sql
CREATE TABLE IF NOT EXISTS grocery_items (
  id                BIGSERIAL PRIMARY KEY,
  store             TEXT NOT NULL,          -- kroger, walmart, ...
  store_product_id  TEXT NOT NULL,          -- the store's product id
  item_name         TEXT NOT NULL,
  item_price        NUMERIC(10,2),          -- regular price at the chosen store
  item_upc          TEXT,
  item_url          TEXT,                   -- product page on the store's site
  item_detail       JSONB,                  -- brand, size, promoPrice, stockLevel, aisle, categories, locationId, scrapedAt
  item_nf           JSONB,                  -- {servingSize, servingsPerPackage, nutrients:[{name, amount, unit, dailyValue}]}
  item_ingredients  TEXT,
  item_image        TEXT,                   -- image / thumbnail URL
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (store, store_product_id)
);
```

All writes go through `saveItems()` in `src/core/items.ts`, which the planned Redis job
worker (automatic pulls) will reuse.

## Project layout

```
src/
  server.ts                     Fastify server + REST API
  config.ts                     env-var configuration
  core/types.ts                 Product / ScraperModule / Category contracts
  core/registry.ts              which categories and modules exist
  core/connections.ts           saved API keys + provider registry
  core/db.ts                    PostgreSQL connection (Settings -> Connections)
  core/items.ts                 grocery_items table: create, save, lookup
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
