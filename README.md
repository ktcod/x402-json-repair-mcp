# US Economic, SEC EDGAR & On-Chain Data — a pay-per-call MCP server

21 data tools that AI agents discover and pay for **per call**, settled in USDC on **Base** via the
[x402](https://x402.org) payment protocol. No account, no API key, no subscription.

**Live:** <https://x402.agentfund.net> · [Agent guide](https://x402.agentfund.net/SKILL.md) ·
[Verification ledger](https://x402.agentfund.net/VERIFICATION.md) ·
[Settlements](https://x402.agentfund.net/monitor)

| Endpoint | Purpose |
| --- | --- |
| `POST /mcp` | MCP over streamable-HTTP (stateless) |
| `POST /x402/<tool>` | One HTTP route per tool; arguments as a plain JSON body |
| `GET /openapi.json` | OpenAPI 3.1 discovery document with `x-payment-info` per route |
| `GET /SKILL.md` | Agent-facing usage guide |
| `GET /VERIFICATION.md` | How each tool was verified, and the upstream traps found |
| `GET /monitor` | Live on-chain settlement dashboard |
| `GET /health` | Liveness and configuration mode |

## The tools

**US macro** — `treasury_yield_curve`, `bls_cpi`, `macro_pce`, `macro_jobs`, `macro_gdp`,
`macro_retail_sales`, `macro_housing`, `macro_energy`, `macro_release_calendar`

**SEC EDGAR** — `edgar_filings_feed`, `edgar_financials`, `edgar_insider_transactions`,
`edgar_13f_holdings`, `edgar_full_text_search`

**On-chain EVM** — `onchain_token_balances`, `onchain_portfolio`, `onchain_cross_chain_balances`,
`onchain_oracle_price`, `onchain_gas`

**Pure compute** — `structured_json_repair`, `tabular_to_json`

Prices run **$0.001–$0.03** per call.

## Why these sources

Every tool wraps **free public-domain US government data** (Treasury, BLS, BEA, Census, EIA, SEC
EDGAR) or a **direct on-chain read** via public RPC. There is no upstream vendor licence, so
nothing here can be revoked or repriced by a third party, and the cost of goods is zero.

The trade-off is inherited from the publishers: government statistics are **lagged and revised**,
13F is quarterly and stale by design, and none of this is market data. Those limits are stated
plainly in [SKILL.md](SKILL.md) rather than buried.

## Correctness

Every tool was checked against **live upstream data** before shipping — not only against unit
tests, because a test written from the same wrong assumption as the code passes happily.

That caught six real defects, including 13F values being 1000× too large by following SEC's *own*
documentation, and Census silently returning five regional rows where a national figure was
expected. Each is documented with the evidence that exposed it, and locked in by a regression
test: **[VERIFICATION.md](VERIFICATION.md)**.

**A failed call is never billed.** The MCP SDK turns a thrown tool error into an HTTP 200 carrying
`isError: true`; the payment gate inspects the result and returns errors **unsettled** rather than
charging for a result the caller never received.

## Architecture

- **x402 v2** (`@x402/core`, `@x402/evm`) with the Coinbase CDP facilitator on Base mainnet.
- **MCP on Workers** via `@hono/mcp` `StreamableHTTPTransport` (the SDK's own transport is
  Node-`http`-based). Stateless JSON.
- **Two entry points, one payment path.** `/mcp` and `/x402/<tool>` both run through
  `PaymentGate.chargeAndRun`, so money-safety rules cannot drift between them.
- **Per-tool HTTP routes exist for discovery.** The x402 Bazaar indexes plain HTTP resources only
  — every catalog entry is `type: "http"` — so an MCP endpoint alone can never be listed.
- **Discovery needs no secrets.** `initialize`, `tools/list` and `ping` are answered without
  payment configuration, so the server introspects cleanly on a fresh clone or in a CI sandbox.
- **Validation uses `@cfworker/json-schema`, not Ajv** — Ajv compiles via `Function`, which
  Workers forbid, and the schema is a runtime input so it cannot be precompiled.
- **No private keys.** The server holds only a public payout address; `config.ts` refuses
  private-key- or seed-shaped input.

Adding a tool is a one-file change plus a line in `src/tools/index.ts`.

## Development

```bash
npm install
npm test          # 174 tests
npm run typecheck
npm run dev       # wrangler dev
npm run dev:node  # tsx watch src/node.ts
```

Copy `.dev.vars.example` to `.dev.vars` for local configuration. Only the **public** payout
address is ever needed — never a private key or seed phrase.

Docs are mirrored into the bundle (Workers have no filesystem); run `npm run gen:docs` after
editing `SKILL.md` or `VERIFICATION.md`, or `test/docs.test.ts` will fail on the drift.

## Deployment

Production runs on **Cloudflare Workers**. Secrets are set with `wrangler secret put`, never in
`wrangler.toml`:

```bash
npx wrangler deploy --env production
```

A `Dockerfile` is included for self-hosting the Node entrypoint; it needs no secrets, so the
container starts and passes introspection out of the box. See
[OPERATOR_CHECKLIST.md](OPERATOR_CHECKLIST.md) for the full runbook.

## Buyer-side test clients

```bash
PAYER_PRIVATE_KEY=0x… node scripts/pay-test.mjs      # pay via /mcp
PAYER_PRIVATE_KEY=0x… node scripts/pay-http.mjs      # pay via /x402/<tool>
node scripts/index-all.mjs                            # dry run: Bazaar index status
```

Payment is **gasless for the payer** (the facilitator submits the transaction), so a test wallet
needs USDC and no ETH. `index-all.mjs` skips already-indexed routes and refuses to spend without
`--yes`.

## Licence

MIT (declared in `package.json`; no `LICENSE` file has been added yet).
