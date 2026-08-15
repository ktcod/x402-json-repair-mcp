# US Economic, SEC EDGAR & On-Chain Data

Pay-per-call data for agents. 21 tools over US government statistics, SEC filings, and public
blockchain state. Settled in USDC on Base via x402 — no account, no API key, no subscription.

- **MCP:** `https://x402.agentfund.net/mcp` (streamable-http, stateless)
- **HTTP:** `POST https://x402.agentfund.net/x402/<tool>` — arguments as a plain JSON body
- **OpenAPI:** `https://x402.agentfund.net/openapi.json`
- **Live settlements:** `https://x402.agentfund.net/monitor`

## How payment works

1. Call a tool. With no payment header you get **HTTP 402** and a `payment-required` header
   holding the x402 v2 requirements (network, asset, amount, `payTo`).
2. Sign an EIP-3009 authorization for that amount and retry with the `payment-signature` header.
3. On success you get the result plus a `payment-response` header with the settlement receipt.

Payment is **gasless for you** — the facilitator submits the transaction. You need USDC on Base
and no ETH. Prices run **$0.001–$0.03** per call.

**If a tool fails upstream, you are not charged.** The gate inspects the tool's result before
settling and returns the error unsettled. You never pay for a result you did not receive.

## Choosing a tool

| Question you're answering | Tool |
| --- | --- |
| Where are Treasury yields, is the curve inverted | `treasury_yield_curve` |
| Consumer inflation (headline/core CPI) | `bls_cpi` |
| The Fed's preferred inflation gauge | `macro_pce` |
| Unemployment, payrolls, wage growth | `macro_jobs` |
| Real GDP growth | `macro_gdp` |
| Consumer spending strength | `macro_retail_sales` |
| Housing momentum (starts, permits) | `macro_housing` |
| Crude price, inventories, nat-gas storage | `macro_energy` |
| When is the next CPI/jobs release | `macro_release_calendar` |
| What has a company filed recently | `edgar_filings_feed` |
| Revenue, net income, EPS, assets | `edgar_financials` |
| Insider buying and selling (Form 4) | `edgar_insider_transactions` |
| What an institution holds (13F) | `edgar_13f_holdings` |
| Find filings mentioning a phrase | `edgar_full_text_search` |
| Token balances for many addresses | `onchain_token_balances` |
| One wallet's multi-asset USD portfolio | `onchain_portfolio` |
| One token across several chains | `onchain_cross_chain_balances` |
| Trusted price from a Chainlink feed | `onchain_oracle_price` |
| Current gas across chains | `onchain_gas` |
| Fix malformed JSON, validate to a schema | `structured_json_repair` |
| CSV/TSV/Markdown table to typed JSON | `tabular_to_json` |

## What this data is, and is not

Every source is **free public-domain US government data or a direct on-chain read**. There is no
upstream vendor licence, so nothing here can be pulled out from under you. It also means the data
carries each publisher's own characteristics:

- **Government statistics are lagged and revised.** CPI, PCE, GDP, jobs, retail sales, and housing
  are periodic releases, not live feeds, and figures are revised after first publication — treat a
  recent number as provisional. Use `macro_release_calendar` to know when the next print lands.
- **This is not market data.** No equity quotes, no intraday prices, no order books.
  `onchain_oracle_price` reads a Chainlink feed and reports its own `ageSeconds`; check it before
  relying on the value.
- **SEC filings are as-filed.** `edgar_financials` reports what the company reported under the
  XBRL tag requested. It does not restate, normalize across companies, or adjust for one-offs.
- **13F is quarterly and stale by design.** Holdings reflect the filing date, not today, and cover
  only long US-listed positions.
- **Not investment advice.** These are raw figures for analysis.

## Units, and the mistakes that matter

Read these before interpreting a number:

- Yields are **percent** (`4.17` means 4.17%). Spreads are percentage points.
- CPI and PCE return an **index level** plus computed YoY/MoM percent change.
- Housing is **thousands of units, seasonally adjusted annual rate** (SAAR).
- Retail sales is **millions of USD**, seasonally adjusted, **excluding motor vehicles**.
- Crude stocks are **thousand barrels**; natural-gas storage is **Bcf**.
- 13F values are **whole USD** — despite SEC documentation describing them as thousands.
  See the [verification ledger](https://x402.agentfund.net/VERIFICATION.md).
- On-chain balances are returned **decimal-adjusted**, with the token's `decimals` reported
  alongside — never raw base units.

## Conventions

- Tools that take no arguments accept `{}`.
- Tickers are case-insensitive and resolved to a CIK automatically; a bare CIK also works.
- Addresses must be valid EVM addresses. Supported chains: base, ethereum, optimism, arbitrum,
  polygon.
- Failures are returned as a thrown tool error (`isError: true` over MCP), never as a
  plausible-looking empty result — and an errored call is not billed.
