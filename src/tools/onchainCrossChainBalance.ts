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

export const TOOL_NAME = "onchain_cross_chain_balances";
export const TOOL_PRICE = "$0.015";

export interface ChainBalance {
  chain: string;
  chainId: number;
  raw: string | null;
  balance: string | null;
  /** True when this specific chain's RPC could not be reached. */
  failed: boolean;
}

export interface CrossChainResult {
  address: string;
  token: { symbol: string | null; decimals: number };
  totalBalance: string;
  chains: ChainBalance[];
}

/**
 * Same ERC-20 symbol, resolved per-chain to its own canonical contract address (USDC's address
 * differs on every chain). A token map keeps this generic without hardcoding one asset.
 */
const KNOWN_TOKENS: Record<string, Partial<Record<ChainKey, string>>> = {
  USDC: {
    base: CHAINS.base.usdc,
    ethereum: CHAINS.ethereum.usdc,
    optimism: CHAINS.optimism.usdc,
    arbitrum: CHAINS.arbitrum.usdc,
    polygon: CHAINS.polygon.usdc,
  },
};

export async function getCrossChainBalances(
  address: string,
  token = "USDC",
  chains: ChainKey[] = [...CHAIN_KEYS],
  env?: Record<string, string | undefined>,
): Promise<CrossChainResult> {
  const holder = assertAddress(address);
  const tokenKey = token.trim().toUpperCase();
  const perChainAddress = KNOWN_TOKENS[tokenKey];
  if (!perChainAddress) {
    throw new UpstreamError(
      "EVM",
      `unknown token "${token}" — supported: ${Object.keys(KNOWN_TOKENS).join(", ")}`,
    );
  }

  let symbol: string | null = null;
  let decimals = 6;
  let total = 0n;
  const results: ChainBalance[] = [];

  for (const chain of chains) {
    const tokenAddress = perChainAddress[chain];
    if (!tokenAddress) {
      results.push({ chain, chainId: CHAINS[chain].id, raw: null, balance: null, failed: true });
      continue;
    }
    try {
      const [balRaw] = await rpcBatch(
        chain,
        [{ method: "eth_call", params: [{ to: tokenAddress, data: encodeBalanceOf(holder) }, "latest"] }],
        env,
      );
      const amount = hexToBigInt(balRaw);
      if (amount === null) {
        results.push({ chain, chainId: CHAINS[chain].id, raw: null, balance: null, failed: true });
        continue;
      }
      // Resolve symbol/decimals once, from whichever chain answers first.
      if (symbol === null) {
        const meta = await erc20Meta(chain, tokenAddress, env);
        symbol = meta.symbol;
        decimals = meta.decimals;
      }
      total += amount;
      results.push({
        chain,
        chainId: CHAINS[chain].id,
        raw: amount.toString(),
        balance: formatUnits(amount, decimals),
        failed: false,
      });
    } catch {
      results.push({ chain, chainId: CHAINS[chain].id, raw: null, balance: null, failed: true });
    }
  }

  // Every chain failing means we delivered nothing: throw so the gate skips settlement.
  if (results.every((r) => r.failed)) {
    throw new UpstreamError("EVM RPC", `balance reads failed on every requested chain`);
  }

  return {
    address: holder,
    token: { symbol: symbol ?? tokenKey, decimals },
    totalBalance: formatUnits(total, decimals),
    chains: results,
  };
}

const DESCRIPTION = `The same token's balance for one address across multiple EVM chains, in a single call.

USDC (and similar assets) has a DIFFERENT contract address on every chain; checking a wallet's total position means resolving each chain's canonical address and querying it separately. This does that and sums the total, so a multi-chain treasury view does not require N separate calls.

Supported chains: base, ethereum, optimism, arbitrum, polygon. Supported tokens: USDC (more may be added over time).

When to use: totaling a stablecoin position spread across chains, treasury reporting for a multi-chain operation, checking where a wallet's funds actually sit.

When NOT to use: you only care about one chain (use onchain_token_balances, which is cheaper), or a token not in the supported set.

Args:
  - address (string, required): the wallet address to check.
  - token (string, optional, default "USDC"): which token to check across chains.
  - chains (string[], optional): which chains to include. Defaults to all five supported chains.

Returns structuredContent:
  {
    "address": "0x...", "token": { "symbol": "USDC", "decimals": 6 },
    "totalBalance": "1234.56",
    "chains": [
      { "chain": "base", "chainId": 8453, "raw": "1000000000", "balance": "1000", "failed": false },
      { "chain": "ethereum", "chainId": 1, "raw": "234560000", "balance": "234.56", "failed": false }
    ]
  }

A chain that could not be read reports failed: true with null balances rather than a misleading 0;
if every chain fails the call errors and is not billed.`;

const inputSchema = {
  address: z.string().min(1).describe("Wallet address to check (0x + 40 hex)."),
  token: z.string().default("USDC").describe('Which token to check. Defaults to "USDC".'),
  chains: z
    .array(z.enum(CHAIN_KEYS as [ChainKey, ...ChainKey[]]))
    .optional()
    .describe("Which chains to include. Defaults to all five supported chains."),
};

export const onchainCrossChainBalanceTool: ToolModule = {
  name: TOOL_NAME,
  title: "Cross-chain Token Balance",
  description: DESCRIPTION,
  price: TOOL_PRICE,
  discovery: {
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Wallet address." },
        token: { type: "string", description: 'Token symbol, default "USDC".' },
        chains: { type: "array", items: { type: "string" }, description: "Chains to include." },
      },
      required: ["address"],
    },
    output: {
      example: {
        address: "0x0000000000000000000000000000000000000001",
        token: { symbol: "USDC", decimals: 6 },
        totalBalance: "1234.56",
        chains: [{ chain: "base", chainId: 8453, balance: "1000", failed: false }],
      },
    },
  },
  register(server: McpServer) {
    server.registerTool(
      TOOL_NAME,
      {
        title: "Cross-chain Token Balance",
        description: DESCRIPTION,
        inputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ address, token, chains }) => {
        // Let UpstreamError propagate: the gate must not settle payment for a failed read.
        const result = await getCrossChainBalances(
          address,
          token ?? "USDC",
          chains && chains.length > 0 ? (chains as ChainKey[]) : undefined,
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
