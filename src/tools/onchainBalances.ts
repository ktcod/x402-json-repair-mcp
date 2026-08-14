import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolModule } from "./types.js";
import { UpstreamError } from "../upstream/http.js";
import {
  CHAINS,
  CHAIN_KEYS,
  type ChainKey,
  assertAddress,
  encodeBalanceOf,
  erc20Meta,
  formatUnits,
  hexToBigInt,
  rpcBatch,
} from "../upstream/evm.js";

export const TOOL_NAME = "onchain_token_balances";
export const TOOL_PRICE = "$0.01";

/** Hard ceiling per call; also the documented limit in the tool description. */
export const MAX_ADDRESSES = 500;

export interface BalanceRow {
  address: string;
  /** Raw integer amount as a decimal string, or null when that specific read failed. */
  raw: string | null;
  /** Human-readable amount scaled by the token's decimals, or null on failure. */
  balance: string | null;
}

export interface BalancesResult {
  chain: string;
  chainId: number;
  blockNumber: number | null;
  token: { address: string; symbol: string | null; decimals: number };
  requested: number;
  /** Addresses actually queried after de-duplication. */
  queried: number;
  /** Reads that failed at the provider (balance reported as null, not 0). */
  failed: number;
  totalBalance: string;
  holders: BalanceRow[];
}

/** De-duplicate while preserving caller order, and validate every address up front. */
export function normalizeAddresses(addresses: string[]): string[] {
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new UpstreamError("EVM", "`addresses` must contain at least one address");
  }
  if (addresses.length > MAX_ADDRESSES) {
    throw new UpstreamError(
      "EVM",
      `too many addresses: ${addresses.length} (max ${MAX_ADDRESSES} per call)`,
    );
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of addresses) {
    const norm = assertAddress(a);
    if (!seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }
  return out;
}

export async function getTokenBalances(
  addresses: string[],
  chain: ChainKey = "base",
  token?: string,
  env?: Record<string, string | undefined>,
): Promise<BalancesResult> {
  const holders = normalizeAddresses(addresses);
  const tokenAddress = token ? assertAddress(token, "token") : CHAINS[chain].usdc;
  const meta = await erc20Meta(chain, tokenAddress, env);

  // One batched request: the current block plus a balanceOf per address.
  const results = await rpcBatch(
    chain,
    [
      { method: "eth_blockNumber", params: [] },
      ...holders.map((h) => ({
        method: "eth_call",
        params: [{ to: meta.address, data: encodeBalanceOf(h) }, "latest"],
      })),
    ],
    env,
  );

  const blockNumber = hexToBigInt(results[0]);
  const rows: BalanceRow[] = [];
  let total = 0n;
  let failed = 0;
  for (let i = 0; i < holders.length; i++) {
    const value = hexToBigInt(results[i + 1]);
    if (value === null) {
      // Report null rather than a misleading 0 for a read we could not complete.
      failed++;
      rows.push({ address: holders[i], raw: null, balance: null });
      continue;
    }
    total += value;
    rows.push({
      address: holders[i],
      raw: value.toString(),
      balance: formatUnits(value, meta.decimals),
    });
  }

  // Every read failing means we delivered nothing: throw so the gate skips settlement.
  if (failed === holders.length) {
    throw new UpstreamError(
      `${CHAINS[chain].name} RPC`,
      `all ${holders.length} balance reads failed`,
    );
  }

  return {
    chain,
    chainId: CHAINS[chain].id,
    blockNumber: blockNumber === null ? null : Number(blockNumber),
    token: { address: meta.address, symbol: meta.symbol, decimals: meta.decimals },
    requested: addresses.length,
    queried: holders.length,
    failed,
    totalBalance: formatUnits(total, meta.decimals),
    holders: rows,
  };
}

const DESCRIPTION = `Read an ERC-20 token balance for up to 500 wallet addresses in a SINGLE call.

Doing this yourself means issuing hundreds of eth_call requests, batching them, handling per-provider rate limits and partial failures, then scaling raw integers by token decimals. This does all of that and returns clean, ready-to-use numbers plus the block height the snapshot was taken at.

Supported chains: base (default), ethereum, optimism, arbitrum, polygon. Defaults to canonical USDC on the selected chain when no token is given.

When to use: portfolio or treasury roll-ups, airdrop and eligibility checks, holder analysis, reconciling a list of wallets.

When NOT to use: you need native ETH balances (this reads ERC-20 contracts) or balances at a historical block.

Args:
  - addresses (string[], required): 1-500 EVM addresses. Duplicates removed, order preserved.
  - chain (string, optional, default "base"): base | ethereum | optimism | arbitrum | polygon.
  - token (string, optional): ERC-20 contract address. Defaults to USDC on the chosen chain.

Returns structuredContent:
  {
    "chain": "base", "chainId": 8453, "blockNumber": 34567890,
    "token": { "address": "0x8335...", "symbol": "USDC", "decimals": 6 },
    "requested": 3, "queried": 3, "failed": 0,
    "totalBalance": "1234.56",
    "holders": [ { "address": "0x...", "raw": "1234560000", "balance": "1234.56" } ]
  }

A read that fails at the provider returns null for that address rather than a misleading 0, and
"failed" counts them. If every read fails the call errors and is not billed.`;

const inputSchema = {
  addresses: z
    .array(z.string())
    .min(1)
    .max(MAX_ADDRESSES)
    .describe(`1-${MAX_ADDRESSES} EVM wallet addresses (0x + 40 hex). Duplicates are removed.`),
  chain: z
    .enum(CHAIN_KEYS as [ChainKey, ...ChainKey[]])
    .default("base")
    .describe("Which EVM chain to query. Defaults to base."),
  token: z
    .string()
    .optional()
    .describe("ERC-20 contract address. Defaults to canonical USDC on the selected chain."),
};

export const onchainBalancesTool: ToolModule = {
  name: TOOL_NAME,
  title: "On-chain Token Balances (bulk)",
  description: DESCRIPTION,
  price: TOOL_PRICE,
  discovery: {
    inputSchema: {
      type: "object",
      properties: {
        addresses: { type: "array", items: { type: "string" }, description: "1-500 EVM addresses." },
        chain: { type: "string", description: "base | ethereum | optimism | arbitrum | polygon." },
        token: { type: "string", description: "ERC-20 contract; defaults to USDC." },
      },
      required: ["addresses"],
    },
    output: {
      example: {
        chain: "base",
        chainId: 8453,
        token: {
          address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          symbol: "USDC",
          decimals: 6,
        },
        queried: 1,
        failed: 0,
        totalBalance: "1234.56",
        holders: [
          {
            address: "0x0000000000000000000000000000000000000001",
            raw: "1234560000",
            balance: "1234.56",
          },
        ],
      },
    },
  },
  register(server: McpServer) {
    server.registerTool(
      TOOL_NAME,
      {
        title: "On-chain Token Balances (bulk)",
        description: DESCRIPTION,
        inputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ addresses, chain, token }) => {
        // Let UpstreamError propagate: the gate must not settle payment for a failed read.
        const result = await getTokenBalances(
          addresses,
          (chain ?? "base") as ChainKey,
          token,
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
