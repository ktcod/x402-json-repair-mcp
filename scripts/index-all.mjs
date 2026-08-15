#!/usr/bin/env node
/**
 * Get every paid route into the x402 Bazaar index.
 *
 * CDP indexes PER RESOURCE, not per origin: a settled payment on one route indexes only that
 * route. Verified 2026-08-14 — after a settlement on /x402/onchain_gas that resource reported
 * `index.active: true` while every sibling still reported no index at all. So each route needs at
 * least one real settlement.
 *
 * The plan is driven by /openapi.json, which already carries each route's price and a valid
 * example body, so it cannot drift from what the server actually serves.
 *
 * Idempotent: already-indexed routes are skipped, so re-running costs nothing for those. Nothing
 * is spent without --yes.
 *
 * Usage:
 *   node scripts/index-all.mjs                              # dry run: show plan and total cost
 *   PAYER_PRIVATE_KEY=0x<key> node scripts/index-all.mjs --yes
 */
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";

const BASE = (process.env.X402_BASE_URL || "https://x402.agentfund.net").replace(/\/$/, "");
const VALIDATE = "https://api.cdp.coinbase.com/platform/v2/x402/validate";
const commit = process.argv.includes("--yes");

const openapi = await (await fetch(`${BASE}/openapi.json`)).json();

const routes = Object.entries(openapi.paths).map(([path, item]) => ({
  path,
  tool: path.replace("/x402/", ""),
  price: Number(item.post["x-payment-info"].price.amount),
  body: item.post.requestBody?.content?.["application/json"]?.example ?? {},
}));

/** Ask CDP whether this exact resource is already catalogued. */
async function isIndexed(path) {
  try {
    const res = await fetch(VALIDATE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resource: `${BASE}${path}`, method: "POST" }),
    });
    const d = await res.json();
    return Boolean(d.index);
  } catch {
    return false; // unknown → treat as not indexed and let the payment decide
  }
}

console.error(`Checking index status for ${routes.length} routes...\n`);
const checked = await Promise.all(
  routes.map(async (r) => ({ ...r, indexed: await isIndexed(r.path) })),
);

const todo = checked.filter((r) => !r.indexed);
const done = checked.filter((r) => r.indexed);
const cost = todo.reduce((s, r) => s + r.price, 0);

for (const r of done) console.error(`  [indexed] ${r.tool}`);
for (const r of todo) console.error(`  [  pay  ] ${r.tool.padEnd(30)} $${r.price.toFixed(3)}`);
console.error(`\n${done.length} already indexed, ${todo.length} to pay, total $${cost.toFixed(3)}`);

if (!todo.length) {
  console.error("\nNothing to do — every route is indexed.");
  process.exit(0);
}
if (!commit) {
  console.error("\nDry run. Re-run with --yes (and PAYER_PRIVATE_KEY set) to spend.");
  process.exit(0);
}

const pk = process.env.PAYER_PRIVATE_KEY;
if (!pk) {
  console.error("\nERROR: --yes needs PAYER_PRIVATE_KEY=0x... (a Base wallet holding USDC).");
  process.exit(1);
}

const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
const client = new x402Client();
registerExactEvmScheme(client, { signer: account });
const pay = wrapFetchWithPayment(fetch, client);
console.error(`\nPayer: ${account.address}\n`);

let paid = 0;
let failed = 0;
// Sequential on purpose: the payer's EIP-3009 nonces and the facilitator both dislike bursts,
// and a failure part-way should be obvious rather than interleaved.
for (const r of todo) {
  process.stderr.write(`  ${r.tool.padEnd(30)} `);
  try {
    const res = await pay(`${BASE}${r.path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(r.body),
    });
    const receipt = res.headers.get("payment-response") || res.headers.get("x-payment-response");
    if (res.status === 200 && receipt) {
      let tx = "";
      try {
        tx = decodePaymentResponseHeader(receipt).transaction ?? "";
      } catch {
        /* receipt present but undecodable — the settle still happened */
      }
      console.error(`OK   ${tx.slice(0, 14)}`);
      paid++;
    } else {
      const challenge = res.headers.get("payment-required");
      let why = `HTTP ${res.status}`;
      if (challenge) {
        try {
          why = JSON.parse(Buffer.from(challenge, "base64").toString("utf8")).error ?? why;
        } catch {
          /* keep the status */
        }
      }
      console.error(`FAIL ${String(why).slice(0, 90)}`);
      failed++;
    }
  } catch (e) {
    console.error(`FAIL ${(e instanceof Error ? e.message : String(e)).slice(0, 90)}`);
    failed++;
  }
}

console.error(`\nSettled ${paid}, failed ${failed}.`);
console.error("CDP crawls on settlement; re-run this script to confirm index status.");
