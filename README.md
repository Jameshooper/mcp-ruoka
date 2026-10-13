# mcp-ruoka

Unofficial MCP server for searching Finnish grocery and alcohol products across [K-Ruoka](https://www.k-ruoka.fi), [S-Kaupat](https://www.s-kaupat.fi), and [Alko](https://www.alko.fi).

- **K-Ruoka** — Playwright browser with stealth plugin (Cloudflare Turnstile bypass)
- **S-Kaupat** — Direct HTTP with persisted GraphQL query hashes (extracted via Playwright)
- **Alko** — Direct HTTP with NextAuth guest session (no browser needed)

## Tools

- **search_products** — Search products by query. Supports all three chains. `storeId` required for K-Ruoka/S-Kaupat, optional for Alko (national catalog).
- **get_stores** — List stores, optionally filtered by city and/or chain.
- **find_recipe_ingredients** — Check a recipe's ingredients against one K-Ruoka/S-Kaupat store. The calling model supplies Finnish search terms for each English ingredient (best guess first, then synonyms); the tool tries them in order and returns the first matching products with prices. Mark staples the cook likely owns (oil, salt, sugar, common dried spices) with `pantry: true`: they are still looked up and priced, but costed in a separate `pantryCost` so `cost` covers only what must be bought. Pass each ingredient's total `quantity` and the `servings` count to also get costs: packs needed, whole-pack (basket) vs pro-rata (used) cost per product, and recipe totals including per person. Pass `avoidAllergens` (Finnish and English terms, e.g. for cashews `cashew`, `cashewpähkin`, `kasjupähkin`) to check each candidate's declared allergens and ingredient list: flagged products are reported and never used in the cost totals. A clean result is not a safety guarantee (traces are not visible), so check the label. Typical flow: `get_stores` with the city → pick a store → `find_recipe_ingredients`. `includeLocation` adds in-store aisle/floor for S-Kaupat (each product gets a `locationStatus`; answers are cached for hours, and lookups that miss the call's ~50 s budget finish in the background so repeating the call returns them). Live shelf stock is not available from the chain APIs used here.
- **save_recipe / list_recipes / get_recipe / delete_recipe** — A personal recipe book stored in `recipes.json` (in `RUOKA_DATA_DIR`, default `~/.mcp-ruoka`; `/data` in the Home Assistant app, so it survives updates). Recipes keep their Finnish search terms, so they can be priced and scaled to any number of servings without translating again.
- **Recipe tags** — `save_recipe` also stores `protein` (`white_meat`, `red_meat`, `fish`, `vegetarian`, `other`), `vegetables` (the meal includes vegetables or a salad) and `nutrition` per portion (kcal, protein, carbs and fat, all required). `find_recipe_ingredients` with `includeNutrition` (S-Kaupat) calculates these from the store's own nutrition labels (per 100 g/ml values scaled by the amounts in the recipe) and the model saves them with `source: store_data`; where the store has no label the model estimates them instead. Check a label lookup with `bun scripts/check-skaupat-nutrition.ts <ean> <storeId>`.
- **plan_meals** — Prices a whole week of meals at one store as a single shopping list. Needs from every meal are pooled per ingredient, so one bag of carrots can serve several dinners. For each ingredient it picks the pack combination covering the total (`preference`: `cheapest` or `least_waste`) and reports the leftover amount and its value, what pooling saved compared with buying per meal, the cost drivers, and the result against an optional `budget` (pantry staples excluded). It also checks the week is balanced (`balance`): every meal needs a protein type and vegetables or a salad, and the plan should include white meat, red meat and fish with red meat limited (`requireProteins`, `maxRedMeatMeals`, optional `minProteinPerPortionG`), and it reports calories and protein per portion (`nutrition`). The model designs the menu and calls it repeatedly, using `waste.alerts` to put leftovers into later meals until the plan fits the budget.
- **rate_recipe** — Rate a saved recipe 1-5 stars with an optional review. Ratings show in `list_recipes`, so the model can favour well-liked recipes when planning.

### Recipes panel (Home Assistant)

The Home Assistant app adds a **Recipes** entry to the sidebar (Home Assistant ingress). It lists the saved recipes with search over names, ingredients and tags, tag filter and sorting, shows a recipe with its ingredients scaled to any number of servings, and shows calories and protein per portion with protein-type and vegetable badges (and a protein filter), and lets you rate it, write a review or delete it. The panel is served on its own port (`RUOKA_UI_PORT`, 3002) that is neither published nor proxied by the Funnel, and it only accepts connections from Home Assistant's ingress proxy, so it is reachable only to logged-in Home Assistant users.

## Install as Claude Code plugin

Requires [Bun](https://bun.sh) installed.

```
/plugin marketplace add p18a/mcp-ruoka
/plugin install ruoka@ruoka
```

Dependencies and Playwright browser are installed automatically on first load.

## Deploy to Fly.io

```bash
# Clone and enter the repo
git clone https://github.com/p18a/mcp-ruoka.git
cd mcp-ruoka

# Create fly.toml from example (pick your own app name)
cp fly.example.toml fly.toml
fly launch --no-deploy

# Set OAuth credentials
fly secrets set \
  OAUTH_CLIENT_ID=$(openssl rand -hex 32) \
  OAUTH_CLIENT_SECRET=$(openssl rand -hex 32)

# Deploy
fly deploy
```

Note the client ID and secret — you'll need them to connect.

## Connect via stdio

Runs the server as a subprocess — simplest option for local use.

```bash
git clone https://github.com/p18a/mcp-ruoka.git
cd mcp-ruoka
bun install
```

Then add to your MCP client config:

```json
{
  "mcpServers": {
    "ruoka": {
      "command": "bun",
      "args": ["run", "/path/to/mcp-ruoka/src/index.ts", "--stdio"]
    }
  }
}
```

## Connect via Streamable HTTP

For remote deployments. Deploy first (see above), then point your MCP client at it:

```json
{
  "mcpServers": {
    "ruoka": {
      "type": "streamable-http",
      "url": "https://<your-app>.fly.dev/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_AUTH_TOKEN>"
      }
    }
  }
}
```

For direct bearer token auth, set `MCP_AUTH_TOKEN` as a Fly secret and use it in the header above. For OAuth, configure `OAUTH_CLIENT_ID` and `OAUTH_CLIENT_SECRET` on both the server and your MCP client.

## Run as a Home Assistant app

`ruoka/` is a Home Assistant app that runs the HTTP server with its own Tailscale node and exposes it through [Tailscale Funnel](https://tailscale.com/kb/1223/funnel), so claude.ai (and the iOS app) can reach it as a custom connector.

1. In the Tailscale admin console: enable HTTPS certificates (DNS page), allow Funnel for your devices (access controls: `nodeAttrs` with `"attr": ["funnel"]`), and create a reusable auth key.
2. In Home Assistant: Settings → Apps → App store → ⋮ → Repositories, add `https://github.com/Jameshooper/mcp-ruoka`, then install **Ruoka MCP**.
3. In the app's Configuration tab set `oauth_client_id` and `oauth_client_secret` (`openssl rand -hex 32` each), `tailscale_auth_key`, and optionally `tailscale_hostname`. Start the app.
4. In claude.ai: Settings → Connectors → Add custom connector, URL `https://<hostname>.<your-tailnet>.ts.net/mcp`, with the OAuth client ID and secret under advanced settings.

For local-only use skip Funnel and Tailscale settings: set `mcp_auth_token` (`openssl rand -hex 32`) and connect an MCP client that runs on your own machine, e.g. `claude mcp add --transport http ruoka http://<ha-ip>:3001/mcp --header "Authorization: Bearer <token>"`. Claude on iOS and claude.ai custom connectors cannot reach a local address (they connect from Anthropic's servers), so those need the Funnel setup above.

The app builds by cloning this repo at `RUOKA_REF` (a build arg in `ruoka/Dockerfile`); bump `version` in `ruoka/config.yaml` to make Home Assistant rebuild with newer commits.

## Local development

```bash
bun install
cp .env.example .env
bun run dev
```

The server runs on `http://localhost:3001/mcp` by default (Streamable HTTP). Pass `--stdio` for stdio transport.

## Environment variables

| Variable | Description |
|---|---|
| `OAUTH_CLIENT_ID` | OAuth client ID (required for claude.ai) |
| `OAUTH_CLIENT_SECRET` | OAuth client secret (required for claude.ai) |
| `MCP_AUTH_TOKEN` | Static bearer token (alternative to OAuth) |
| `PORT` | Server port (default: 3001) |
| `LOG_LEVEL` | pino log level (default: info) |
| `BROWSER_DATA_DIR` | Persistent browser data directory (default: `.browser-data/`) |

## Usage examples

<img src="example.png" alt="Example: comparing butter prices between Citymarket and Prisma in Lempäälä" width="600">

<img src="example2.png" alt="Example: finding the best price-to-alcohol ratio for fortified wines at Alko" width="600">

## Disclaimer

This project is unofficial and not affiliated with K Group, K-Ruoka, S Group, S-Kaupat, or Alko. It accesses publicly available data through their websites. Use responsibly.
