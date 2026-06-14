#!/usr/bin/env node
/**
 * Buyer-side x402 test client for x402-json-repair-mcp.
 *
 * Runs a REAL paid `structured_json_repair` call against the live server. You supply the
 * payer wallet key via env — it stays on your machine and is never transmitted anywhere
 * except as an EIP-3009 signature to the facilitator.
 *
 * Usage:
 *   PAYER_PRIVATE_KEY=0x<key> node scripts/pay-test.mjs
 *   # optional override:
 *   X402_MCP_URL=https://x402.agentfund.net/mcp PAYER_PRIVATE_KEY=0x<key> node scripts/pay-test.mjs
 *
 * The payer wallet needs a little USDC on Base (~$0.01+). EIP-3009 is gasless for the payer
 * (the facilitator submits the tx and pays gas), so no ETH is required. On mainnet this moves
 * real USDC to the server's payout address.
 *
 * Requires dev deps: @x402/fetch, @x402/evm, viem (already in this repo's devDependencies).
 */
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";

const url = process.env.X402_MCP_URL || "https://x402.agentfund.net/mcp";
const pk = process.env.PAYER_PRIVATE_KEY;
if (!pk) {
  console.error(
    "ERROR: set PAYER_PRIVATE_KEY=0x... (a Base wallet funded with a little USDC).\n" +
      "It stays local — only an EIP-3009 signature is sent.",
  );
  process.exit(1);
}

const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
const client = new x402Client();
registerExactEvmScheme(client, { signer: account });
const fetchWithPay = wrapFetchWithPayment(fetch, client);

const body = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: {
    name: "structured_json_repair",
    arguments: {
      input: "{name: 'Ada', age: '36',}",
      schema: {
        type: "object",
        properties: { name: { type: "string" }, age: { type: "integer" } },
        required: ["name", "age"],
      },
    },
  },
};

function parseMcp(text) {
  try {
    return JSON.parse(text);
  } catch {
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("data:")) {
        try {
          return JSON.parse(line.slice(5).trim());
        } catch {
          /* keep scanning */
        }
      }
    }
    return null;
  }
}

console.error(`Payer:    ${account.address}`);
console.error(`Endpoint: ${url}`);
console.error("Calling structured_json_repair (will pay on the 402)...\n");

const res = await fetchWithPay(url, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
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
  console.error("(no settlement receipt header — check status above)");
}

const text = await res.text();
const json = parseMcp(text);
const structured = json?.result?.structuredContent;
console.log("\nTool result:");
console.log(JSON.stringify(structured ?? json ?? text.slice(0, 1000), null, 2));
