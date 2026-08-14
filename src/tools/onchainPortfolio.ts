import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolModule } from "./types.js";
import { UpstreamError } from "../upstream/http.js";
import {
  CHAINS,
  SELECTOR,
  assertAddress,
  encodeBalanceOf,
  formatUnits,
  hexToBigInt,
  rpcBatch,
} from "../upstream/evm.js";

export const TOOL_NAME = "onchain_portfolio";
export const TOOL_PRICE = "$0.02";

/**
 * Priced assets on Base. Prices come from Chainlink aggregators read directly on-chain, so this
 * tool depends on no price-API vendor and carries no third-party terms of service.
 * Only feeds verified to respond on Base are listed.
 */
interface AssetSpec {
  symbol: string;
  /** ERC-20 contract, or "native" for the chain's gas token. */
  token: string | "native";
  decimals: number;
  /** Chainlink USD aggregator for this asset. */
  feed: string;
}

const BASE_ASSETS: AssetSpec[] = [
  {
    symbol: "ETH",
    token: "native",
    decimals: 18,
    feed: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
  },
  {
    symbol: "WETH",
    token: "0x4200000000000000000000000000000000000006",
    decimals: 18,
    feed: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
  },
  {
    symbol: "USDC",
    token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    decimals: 6,
    feed: "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B",
  },
  {
    symbol: "cbBTC",
    token: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
    decimals: 8,
    feed: "0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F",
  },
];

export interface Holding {
  symbol: string;
  kind: "native" | "erc20";
  address: string | null;
  raw: string;
  balance: string;
  /** Chainlink USD price, or null when the feed could not be read. */
  priceUsd: number | null;
  /** balance * priceUsd, or null when unpriced. */
  valueUsd: number | null;
}

export interface PortfolioResult {
  address: string;
  chain: string;
  chainId: number;
  blockNumber: number | null;
  /** Only assets with a non-zero balance appear here. */
  holdings: Holding[];
  totalValueUsd: number;
  /** Assets checked but held at zero balance. */
  emptyAssets: string[];
  priceSource: string;
}

/** Slice ABI word `index` out of an eth_call return value. */
export function abiWord(hex: string | null | undefined, index: number): string | null {
  if (!hex || hex === "0x") return null;
  const body = hex.slice(2);
  const start = index * 64;
  if (body.length < start + 64) return null;
  return "0x" + body.slice(start, start + 64);
}

/**
 * Decode a Chainlink `latestRoundData` return into a USD price.
 * Layout: (roundId, answer, startedAt, updatedAt, answeredInRound) — `answer` is word 1.
 */
export function decodeChainlinkAnswer(hex: string | null, feedDecimals: number): number | null {
  const raw = hexToBigInt(abiWord(hex, 1));
  if (raw === null || raw <= 0n) return null;
  const scaled = Number(raw) / 10 ** feedDecimals;
  return Number.isFinite(scaled) ? scaled : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function getPortfolio(
  address: string,
  env?: Record<string, string | undefined>,
): Promise<PortfolioResult> {
  const holder = assertAddress(address);
  const chain = "base" as const;
  const assets = BASE_ASSETS;

  // One batched request: block number, every balance, then each feed's price and decimals.
  const balanceCalls = assets.map((a) =>
    a.token === "native"
      ? { method: "eth_getBalance", params: [holder, "latest"] }
      : { method: "eth_call", params: [{ to: a.token, data: encodeBalanceOf(holder) }, "latest"] },
  );
  const feedCalls = assets.flatMap((a) => [
    { method: "eth_call", params: [{ to: a.feed, data: SELECTOR.latestRoundData }, "latest"] },
    { method: "eth_call", params: [{ to: a.feed, data: SELECTOR.decimals }, "latest"] },
  ]);

  const results = await rpcBatch(
    chain,
    [{ method: "eth_blockNumber", params: [] }, ...balanceCalls, ...feedCalls],
    env,
  );

  const blockNumber = hexToBigInt(results[0]);
  const balances = results.slice(1, 1 + assets.length);
  const feeds = results.slice(1 + assets.length);

  // Distinguish "every read failed" from "wallet is genuinely empty" so we never bill for a
  // total RPC failure.
  if (balances.every((b) => b === null)) {
    throw new UpstreamError(
      `${CHAINS[chain].name} RPC`,
      `all ${assets.length} balance reads failed`,
    );
  }

  const holdings: Holding[] = [];
  const emptyAssets: string[] = [];
  let total = 0;

  for (let i = 0; i < assets.length; i++) {
    const asset = assets[i];
    const amount = hexToBigInt(balances[i]);
    if (amount === null || amount === 0n) {
      emptyAssets.push(asset.symbol);
      continue;
    }
    const feedDecimals = Number(hexToBigInt(feeds[i * 2 + 1]) ?? 8n);
    const priceUsd = decodeChainlinkAnswer(feeds[i * 2], feedDecimals);
    const balance = formatUnits(amount, asset.decimals);
    const valueUsd = priceUsd === null ? null : round2(Number(balance) * priceUsd);
    if (valueUsd !== null) total += valueUsd;
    holdings.push({
      symbol: asset.symbol,
      kind: asset.token === "native" ? "native" : "erc20",
      address: asset.token === "native" ? null : asset.token,
      raw: amount.toString(),
      balance,
      priceUsd: priceUsd === null ? null : round2(priceUsd),
      valueUsd,
    });
  }

  holdings.sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));

  return {
    address: holder,
    chain,
    chainId: CHAINS[chain].id,
    blockNumber: blockNumber === null ? null : Number(blockNumber),
    holdings,
    totalValueUsd: round2(total),
    emptyAssets,
    priceSource: "Chainlink on-chain price feeds (Base)",
  };
}

const DESCRIPTION = `USD-valued portfolio for a wallet on Base, priced from Chainlink on-chain oracles.

Reads the wallet's native ETH plus major ERC-20 balances, reads each asset's Chainlink USD aggregator directly on-chain, and returns holdings with per-asset prices and dollar values, sorted largest first, stamped with the block height.

Prices come from Chainlink contracts rather than a price API, so there is no vendor key, no rate limit, and no third-party terms attached to the result.

Covered assets: ETH (native), WETH, USDC, cbBTC. Zero-balance assets are listed in "emptyAssets" rather than cluttering holdings.

When to use: valuing a wallet, treasury reporting, checking what an address actually holds in dollar terms.

When NOT to use: you need an exhaustive scan of every token a wallet has ever received (this checks a curated major-asset set, not an indexer), LP or staked positions, NFTs, or chains other than Base.

Args:
  - address (string, required): the wallet address to value.

Returns structuredContent:
  {
    "address": "0x...", "chain": "base", "chainId": 8453, "blockNumber": 49976942,
    "holdings": [
      { "symbol": "ETH", "kind": "native", "address": null,
        "raw": "1500000000000000000", "balance": "1.5",
        "priceUsd": 3120.44, "valueUsd": 4680.66 }
    ],
    "totalValueUsd": 4680.66,
    "emptyAssets": ["cbBTC"],
    "priceSource": "Chainlink on-chain price feeds (Base)"
  }

If every balance read fails the call errors and is not billed; a genuinely empty wallet returns an
empty holdings list with totalValueUsd 0.`;

const inputSchema = {
  address: z.string().min(1).describe("Wallet address to value (0x + 40 hex), on Base."),
};

export const onchainPortfolioTool: ToolModule = {
  name: TOOL_NAME,
  title: "On-chain Portfolio (USD-valued)",
  description: DESCRIPTION,
  price: TOOL_PRICE,
  discovery: {
    inputSchema: {
      type: "object",
      properties: { address: { type: "string", description: "Wallet address on Base." } },
      required: ["address"],
    },
    output: {
      example: {
        address: "0x0000000000000000000000000000000000000001",
        chain: "base",
        chainId: 8453,
        totalValueUsd: 4680.66,
        holdings: [
          { symbol: "ETH", kind: "native", balance: "1.5", priceUsd: 3120.44, valueUsd: 4680.66 },
        ],
        priceSource: "Chainlink on-chain price feeds (Base)",
      },
    },
  },
  register(server: McpServer) {
    server.registerTool(
      TOOL_NAME,
      {
        title: "On-chain Portfolio (USD-valued)",
        description: DESCRIPTION,
        inputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ address }) => {
        // Let UpstreamError propagate: the gate must not settle payment for a failed read.
        const result = await getPortfolio(
          address,
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
