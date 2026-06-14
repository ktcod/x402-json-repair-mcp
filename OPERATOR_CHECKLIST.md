# Operator Checklist — x402-json-repair-mcp

Steps that require **accounts, money, private keys, or publishing**. The build agent does **not** perform these — run them yourself, under your own accounts. Order matters top to bottom.

> **Golden rule:** this server only ever needs your **public wallet address**. Never put a private key, seed phrase, or mnemonic in this repo, in `.dev.vars`, in `wrangler secret`, in env vars, or in any prompt. If you ever paste a 64-hex string as `PAYOUT_WALLET_ADDRESS`, the server refuses to start by design.

---

## 1. Create + fund a wallet (USDC on Base)

- [ ] Create a wallet you control (e.g. Coinbase Wallet, MetaMask, or a CDP-managed wallet). Keep the **private key/seed offline and private**.
- [ ] Copy the **public address** (`0x…`, 40 hex chars). This is your `PAYOUT_WALLET_ADDRESS`.
- [ ] **Sandbox:** no funding needed to *receive*. Payers use Base **Sepolia** test USDC (faucet: <https://faucet.circle.com>).
- [ ] **Production:** ensure the address can receive **USDC on Base mainnet** (asset `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`).

## 2. Cloudflare account + login

```bash
npm install
npx wrangler login          # opens a browser; authorize Wrangler
```

## 3. Set secrets (never commit these)

```bash
# Sandbox worker
npx wrangler secret put PAYOUT_WALLET_ADDRESS      # paste your PUBLIC 0x address

# Production worker (Base mainnet via Coinbase CDP facilitator)
npx wrangler secret put PAYOUT_WALLET_ADDRESS --env production
npx wrangler secret put CDP_API_KEY_ID --env production
npx wrangler secret put CDP_API_KEY_SECRET --env production
```

- [ ] CDP API keys come from the [Coinbase Developer Platform portal](https://portal.cdp.coinbase.com) → API Keys. Needed only for **production** (mainnet settlement).

## 4. Deploy (sandbox + production)

```bash
npm run build
npx wrangler deploy                 # sandbox  → https://x402-json-repair-mcp.<subdomain>.workers.dev/mcp
npx wrangler deploy --env production # production → https://x402-json-repair-mcp-prod.<subdomain>.workers.dev/mcp
```

Verify each after deploy:

```bash
curl -s https://<your-worker-url>/health
curl -s -X POST https://<your-worker-url>/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

- [ ] `/health` shows the right `mode`/`network`.
- [ ] An unpaid `tools/call` to `structured_json_repair` returns **HTTP 402** with a `payment-required` header.

## 5. Publish the npm package (optional, enables self-hosting)

```bash
npm whoami || npm login
npm version patch        # bump if re-publishing
npm publish --access public
```

## 6. List for discovery

### Official MCP Registry
- [ ] Edit **`server.json`**: replace `OWNER` in `name` (`io.github.<your-gh-username>/x402-json-repair-mcp`) and `repository.url`, and set `remotes[0].url` to your deployed `/mcp` URL.
- [ ] Install the registry CLI and publish (GitHub-auth verifies the `io.github.<you>` namespace):

```bash
# Install the MCP Registry publisher CLI (see github.com/modelcontextprotocol/registry for the current install command)
mcp-publisher login github
mcp-publisher publish        # validates server.json against the registry schema and submits
```

The registry feeds downstream consumers (Smithery, PulseMCP, Docker Hub, VS Code).

### x402 Bazaar / Agentic.market
- [ ] Your server already serves discovery metadata at `GET /<your-worker-url>/.well-known/x402` (capability + pricing per tool).
- [ ] Submit the endpoint to the x402 Bazaar / Agentic.market per the current x402 docs (<https://docs.x402.org>). The **tool description is your primary marketing asset** — discovery is semantic + reputation-weighted.

## 7. Seed the reputation flywheel

- [ ] Reach out to agent builders / MCP-client developers who handle messy JSON (LLM output cleanup, data pipelines, scraping). Get a handful of real calls flowing.
- [ ] Watch on-chain receipts to your payout address (e.g. on a Base block explorer) to confirm settlements.

---

## Things the agent already did (no action needed)

- Implemented + unit-tested the tool and the paywall (`npm test` → green).
- `npm run build` passes with full TypeScript types.
- Verified the live 402 flow against the public testnet facilitator and confirmed the Cloudflare Workers bundle builds (`wrangler deploy --dry-run`).
- Wrote `server.json`, the `/.well-known/x402` discovery endpoint, and this checklist.
