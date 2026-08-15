#!/usr/bin/env node
/**
 * Buyer-side x402 test client for the PER-TOOL HTTP routes (`POST /x402/<tool>`).
 *
 * Distinct from pay-test.mjs, which exercises the MCP endpoint with a JSON-RPC body. These routes
 * are the ones the x402 Bazaar can actually index, and a settlement made through them carries the
 * `http` discovery declaration — which is what CDP needs in order to catalog the resource.
 *
 * The payer key stays on your machine; only an EIP-3009 signature leaves it. Payment is gasless
 * for the payer (the facilitator submits the transaction), so the wallet needs USDC and no ETH.
 *
 * Usage:
 *   PAYER_PRIVATE_KEY=0x<key> node scripts/pay-http.mjs                       # onchain_gas, $0.001
 *   PAYER_PRIVATE_KEY=0x<key> node scripts/pay-http.mjs treasury_yield_curve '{"days":5}'
 *   X402_BASE_URL=https://x402-json-repair-mcp.agentfund.workers.dev ... node scripts/pay-http.mjs
 */
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";

const base = (process.env.X402_BASE_URL || "https://x402.agentfund.net").replace(/\/$/, "");
// onchain_gas is the cheapest tool at $0.001 — the least expensive way to trigger a real settle.
const tool = process.argv[2] || "onchain_gas";
const args = process.argv[3] || "{}";
const pk = process.env.PAYER_PRIVATE_KEY;

if (!pk) {
  console.error(
    "ERROR: set PAYER_PRIVATE_KEY=0x... (a Base wallet holding a little USDC).\n" +
      "It stays local — only an EIP-3009 signature is sent. No ETH needed.",
  );
  process.exit(1);
}

let body;
try {
  body = JSON.parse(args);
} catch {
  console.error(`ERROR: arguments must be valid JSON. Got: ${args}`);
  process.exit(1);
}

const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
const client = new x402Client();
registerExactEvmScheme(client, { signer: account });
const fetchWithPay = wrapFetchWithPayment(fetch, client);

const url = `${base}/x402/${tool}`;
console.error(`Payer:    ${account.address}`);
console.error(`Endpoint: ${url}`);
console.error(`Args:     ${JSON.stringify(body)}`);
console.error("Calling (will pay on the 402)...\n");

const res = await fetchWithPay(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

console.error(`HTTP ${res.status}`);

const receipt = res.headers.get("payment-response") || res.headers.get("x-payment-response");
if (receipt) {
  try {
    console.error("settlement receipt:", JSON.stringify(decodePaymentResponseHeader(receipt)));
  } catch {
    console.error("settlement receipt (raw):", receipt.slice(0, 160));
  }
} else {
  // A second 402 means the payment was rejected; the envelope carries the reason.
  const challenge = res.headers.get("payment-required");
  if (challenge) {
    try {
      const decoded = JSON.parse(Buffer.from(challenge, "base64").toString("utf8"));
      console.error("NOT SETTLED —", decoded.error);
    } catch {
      console.error("NOT SETTLED — could not decode the payment-required header.");
    }
  } else {
    console.error("(no settlement receipt header — check the status above)");
  }
}

const text = await res.text();
console.log("\nResult:");
try {
  console.log(JSON.stringify(JSON.parse(text), null, 2));
} catch {
  console.log(text.slice(0, 1000));
}
