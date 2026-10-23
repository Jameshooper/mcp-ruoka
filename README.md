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
- **Recipe tags** — `save_recipe` requires the method (`steps`) and also stores `protein` (`white_meat`, `red_meat`, `fish`, `vegetarian`, `other`), `vegetables` (the meal includes vegetables or a salad) and `nutrition` per portion (kcal, protein, carbs and fat, all required). `find_recipe_ingredients` also returns `estimatedCost` (the meal's price per portion and in total when looked up, pro-rata and including staples, plus the whole packs to buy), which (with the store name, `storeName`, remembered from `get_stores` or passed by the model) is saved with the recipe so it keeps the price it had when it was created; meals saved from a plan keep the price from that plan. `find_recipe_ingredients` with `includeNutrition` (S-Kaupat) calculates these from the store's own nutrition labels (per 100 g/ml values scaled by the amounts in the recipe) and the model saves them with `source: store_data`; where the store has no label the model estimates them instead. Check a label lookup with `bun scripts/check-skaupat-nutrition.ts <ean> <storeId>`.
- **plan_meals** — Prices a whole week of meals at one store as a single shopping list. Needs from every meal are pooled per ingredient, so one bag of carrots can serve several dinners. For each ingredient it picks the pack combination covering the total (`preference`: `cheapest` or `least_waste`) and reports the leftover amount and its value, what pooling saved compared with buying per meal, the cost drivers, and the result against an optional `budget` (pantry staples excluded). It also checks the week is balanced (`balance`): every meal needs a protein type and vegetables or a salad, and the plan should include white meat, red meat and fish with red meat limited (`requireProteins`, `maxRedMeatMeals`, optional `minProteinPerPortionG`), and it reports calories and protein per portion (`nutrition`). The model designs the menu and calls it repeatedly, using `waste.alerts` to put leftovers into later meals until the plan fits the budget.
- **rate_recipe** — Rate a saved recipe 1-5 stars with an optional review. Ratings show in `list_recipes`, so the model can favour well-liked recipes when planning.

- **list_meal_plans / get_meal_plan / delete_meal_plan** — Meal plans saved with `plan_meals` and `saveAs` (stored in `plans.json` next to the recipes). A saved plan keeps the meals, shopping list by product and aisle, totals, budget, balance report and nutrition summary. Each saved meal keeps its method (copied from the saved recipe, or passed as `steps` for an inline meal) and its calories and macros per portion; if a meal brings no figures they are calculated from the store's nutrition labels for the chosen products (meals with uncountable ingredients are marked partial). Ingredients that could not be priced (not found in the store, or given without a quantity) are saved too and shown under "Not priced" so they are never silently left out of the total. Plans can be rated 1-5 with a review (`rate_meal_plan`, or in the panel; re-saving keeps the rating), and each meal that is not yet a recipe has a **Save to recipes** button in the panel that stores it (ingredients with Finnish terms, method, protein type, nutrition when complete) in the recipe book and links the meal to it. Saving under an existing name replaces the plan and keeps the ticks for products still on the list.

### Home-screen app (no Home Assistant UI)

The panel is also served as a standalone web app at `https://<hostname>.<tailnet>.ts.net:8443`, through `tailscale serve` (private to your tailnet, not Funnel) to a listener bound to localhost (`RUOKA_UI_STANDALONE_PORT`, 3003). Only the Tailscale login of the node's owner is let in (`Tailscale-User-Login`, set by Tailscale itself; add others with the `ui_allowed_logins` option). Open it in Safari and use Share, then Add to Home Screen: it gets its own Ruoka icon and opens full screen. Your tailnet policy must allow `tcp:8443` to the node. Icons are rendered from `src/ui/icons/icon.svg` with `CHROMIUM_PATH=... bun scripts/make-icons.ts`.

### Securing the public endpoint

The Funnel makes `/mcp` reachable from the internet, so the server defends itself: every request to `/mcp` needs a valid token; the OAuth flow only hands codes to Claude's own callback URLs (`redirect_uri` allowlist, `OAUTH_REDIRECT_URIS` adds more); a code can only be exchanged with the client secret (the client id alone is not enough); and after 10 failed attempts in 5 minutes the OAuth endpoints answer 429 for a while. Optionally `MCP_ALLOWED_IPS` (app option `mcp_allowed_ips`, comma-separated addresses or CIDR ranges) limits `/mcp`, `/token` and the discovery documents to those sources. Tailscale Funnel has no IP allowlist of its own, so the check is made in the app on the client address Tailscale forwards (`X-Forwarded-For`, believed only when it comes from the local Tailscale proxy, last entry only). Look before you lock: every new MCP session logs `clientIp` and `ipSource`, so confirm Claude's calls show up with a real address in Anthropic's published outbound range before turning the allowlist on, because with an address that cannot be determined the check refuses the request.

### Backup and restore

The download button in the panel's header opens **Backup & restore**. Export gives one zip (`manifest.json`, `recipes.json`, `plans.json`, `stores.json`): recipes with ratings and prices, meal plans with ticked items, and store names. Import checks the file first (a preview of what is new and what already exists), then applies it as *add only what is missing* (default), *add and update* (the file wins on a match) or *replace everything*. Nothing is applied unless every file in the zip is valid, and each import first saves a copy of the current data to `backups/` in the data folder (the last 5 are kept). The zip is read and written by `src/zip.ts`, with size limits against crafted archives. The same files can be fetched with `GET api/backup`.

### Cook with Claude / Shop with Claude

Recipe and plan screens have buttons that open a new Claude chat with a ready-made message (`https://claude.ai/new?q=...`; a "Copy message" link is the fallback). "Cook with Claude" asks for an interactive cooking card with an ingredient checklist and step-by-step timers; "Shop with Claude" asks for the shopping list grouped by aisle for the default store. Because a new chat does not carry project instructions, the message names the store and tool arguments and appends `claude_prompt_note` (the app options `default_store_id`, `default_store_name` and `claude_prompt_note`). The Meal plans tab also has "Create family meal plan for this week": it asks Claude to first ask for a budget and a theme, then plans the 9 dinners from Wednesday to the following Thursday (5 portions on the first two days, 8 on the others, constants `FAMILY_FIRST_PORTIONS` and `FAMILY_OTHER_PORTIONS` in `src/ui/index.html`) with the balance rules, and saves the plan. No API key or extra cost: it uses your normal Claude app and the Ruoka connector.

### Recipes panel (Home Assistant)

The panel uses an iOS-style layout (large titles, inset grouped lists, a floating translucent tab bar, capsule controls) in a calm, warm palette with a serif for headings and a single terracotta accent, inset grouped lists, a floating translucent "glass" tab bar, capsule filters and buttons, round tick boxes, and automatic light and dark mode (with reduced motion and transparency respected).

The Home Assistant app adds a **Recipes** entry to the sidebar (Home Assistant ingress). It lists the saved recipes with search over names, ingredients and tags, tag filter and sorting, shows a recipe with its ingredients scaled to any number of servings, and shows calories and protein per portion with protein-type and vegetable badges (and a protein filter), and lets you rate it, write a review or delete it. A second tab lists the saved **Meal plans**: each opens to the meals (with a link to the recipe), budget and balance status, and the shopping list grouped by aisle with tick boxes that are saved, so the list survives closing the page and works across your phone and computer. The panel is served on its own port (`RUOKA_UI_PORT`, 3002) that is neither published nor proxied by the Funnel, and it only accepts connections from Home Assistant's ingress proxy, so it is reachable only to logged-in Home Assistant users.

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



## Disclaimer

This project is unofficial and not affiliated with K Group, K-Ruoka, S Group, S-Kaupat, or Alko. It accesses publicly available data through their websites. Use responsibly.
