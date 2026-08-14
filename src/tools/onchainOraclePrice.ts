import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolModule } from "./types.js";
import { UpstreamError } from "../upstream/http.js";
import {
  CHAIN_KEYS,
  type ChainKey,
  SELECTOR,
  assertAddress,
  hexToBigInt,
  rpcBatch,
} from "../upstream/evm.js";
import { abiWord, decodeChainlinkAnswer } from "./onchainPortfolio.js";

export const TOOL_NAME = "onchain_oracle_price";
export const TOOL_PRICE = "$0.002";

/** A short catalog of well-known Chainlink feeds on Base, so most callers never need an address. */
const NAMED_FEEDS: Record<string, string> = {
  "ETH/USD": "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
  "BTC/USD": "0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F",
  "USDC/USD": "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B",
};

export interface OracleResult {
  chain: string;
  feed: string;
  pair: string | null;
  price: number;
  decimals: number;
  updatedAt: string | null;
  /** Seconds since the feed last updated, so callers can judge staleness themselves. */
  ageSeconds: number | null;
  source: string;
}

export async function getOraclePrice(
  feedOrPair: string,
  chain: ChainKey = "base",
  env?: Record<string, string | undefined>,
): Promise<OracleResult> {
  const key = feedOrPair.trim();
  const address = /^0x/i.test(key) ? assertAddress(key, "feed") : NAMED_FEEDS[key.toUpperCase()];
  if (!address) {
    throw new UpstreamError(
      "EVM",
      `unknown feed pair "${key}" — pass a feed address, or one of: ${Object.keys(NAMED_FEEDS).join(", ")}`,
    );
  }

  const [roundData, decimalsRaw] = await rpcBatch(
    chain,
    [
      { method: "eth_call", params: [{ to: address, data: SELECTOR.latestRoundData }, "latest"] },
      { method: "eth_call", params: [{ to: address, data: SELECTOR.decimals }, "latest"] },
    ],
    env,
  );
  const decimals = Number(hexToBigInt(decimalsRaw) ?? 8n);
  const price = decodeChainlinkAnswer(roundData, decimals);
  if (price === null) {
    throw new UpstreamError("EVM", `feed ${address} returned no valid answer`);
  }

  const updatedAtRaw = hexToBigInt(abiWord(roundData, 3));
  const updatedAt = updatedAtRaw ? new Date(Number(updatedAtRaw) * 1000).toISOString() : null;
  const ageSeconds = updatedAtRaw
    ? Math.max(0, Math.floor(Date.now() / 1000) - Number(updatedAtRaw))
    : null;

  return {
    chain,
    feed: address,
    pair: /^0x/i.test(key) ? null : key.toUpperCase(),
    price,
    decimals,
    updatedAt,
    ageSeconds,
    source: "Chainlink on-chain price feed",
  };
}

const DESCRIPTION = `Read any Chainlink price feed directly on-chain — a named pair or a raw feed address.

Calls latestRoundData on the feed contract itself, so there is no price-API vendor, no rate limit, and no key. Includes the feed's last-updated timestamp and its age in seconds, so you can judge staleness yourself rather than trusting an unlabeled number.

Known named pairs on Base: ETH/USD, BTC/USD, USDC/USD. Any other feed address on any supported chain also works.

When to use: getting a specific asset's price without depending on a centralized price API, verifying a feed is fresh before using it, cross-checking a price from another source.

When NOT to use: you need a token that has no Chainlink feed (use onchain_portfolio's covered set, or a DEX quote instead), or historical/point-in-time prices.

Args:
  - pair (string, required): a named pair (e.g. "ETH/USD") or a raw feed contract address (0x...).
  - chain (string, optional, default "base"): base | ethereum | optimism | arbitrum | polygon.

Returns structuredContent:
  {
    "chain": "base", "feed": "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
    "pair": "ETH/USD", "price": 1877.86, "decimals": 8,
    "updatedAt": "2026-08-14T12:00:00.000Z", "ageSeconds": 120,
    "source": "Chainlink on-chain price feed"
  }`;

const inputSchema = {
  pair: z
    .string()
    .min(1)
    .describe('A named pair (e.g. "ETH/USD") or a raw Chainlink feed contract address.'),
  chain: z
    .enum(CHAIN_KEYS as [ChainKey, ...ChainKey[]])
    .default("base")
    .describe("Which chain the feed lives on. Defaults to base."),
};

export const onchainOraclePriceTool: ToolModule = {
  name: TOOL_NAME,
  title: "Chainlink Oracle Price",
  description: DESCRIPTION,
  price: TOOL_PRICE,
  discovery: {
    inputSchema: {
      type: "object",
      properties: {
        pair: { type: "string", description: 'Named pair (e.g. "ETH/USD") or feed address.' },
        chain: { type: "string", description: "Chain the feed lives on; defaults to base." },
      },
      required: ["pair"],
    },
    output: {
      example: { chain: "base", pair: "ETH/USD", price: 1877.86, decimals: 8, ageSeconds: 120 },
    },
  },
  register(server: McpServer) {
    server.registerTool(
      TOOL_NAME,
      {
        title: "Chainlink Oracle Price",
        description: DESCRIPTION,
        inputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ pair, chain }) => {
        // Let UpstreamError propagate: the gate must not settle payment for a failed read.
        const result = await getOraclePrice(
          pair,
          (chain ?? "base") as ChainKey,
          globalThis.process?.env as Record<string, string | undefined> | undefined,
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result as unknown as Record<string, unknown>,
          isError: false,
        };
      },
    );
  },
};
