# Retailer response fixtures

Responses in the shape each chain's API returns, used by `retailers.test.ts` to check that the
clients read products, prices, stores, aisles, allergens and nutrition correctly without touching
the live sites. They follow the Zod schemas in `src/browser/*.ts`.

The weekly live check (`scripts/live-check.ts`, `.github/workflows/live-check.yml`) calls the real
sites and uploads the raw responses it saw as a workflow artifact. When a chain changes its format,
copy the new response from that artifact over the matching file here, then update the client until
`bun test` passes again.
