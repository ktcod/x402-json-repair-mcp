import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolModule } from "./types.js";
import { UpstreamError } from "../upstream/http.js";
import { CHAINS, CHAIN_KEYS, type ChainKey, hexToBigInt, rpcBatch } from "../upstream/evm.js";

export const TOOL_NAME = "onchain_gas";
export const TOOL_PRICE = "$0.001";

export interface ChainGas {
  chain: string;
  chainId: number;
  gasPriceGwei: number | null;
}

export interface GasResult {
  chains: ChainGas[];
  source: string;
}

function weiToGwei(wei: bigint | null): number | null {
  if (wei === null) return null;
  // 1e9 wei per gwei; round to 4 decimal places.
  return Math.round((Number(wei) / 1e9) * 10_000) / 10_000;
}

export async function getGas(
  chains: ChainKey[] = [...CHAIN_KEYS],
  env?: Record<string, string | undefined>,
): Promise<GasResult> {
  const results = await Promise.all(
    chains.map(async (chain) => {
      try {
        const [price] = await rpcBatch(chain, [{ method: "eth_gasPrice", params: [] }], env);
        return { chain, chainId: CHAINS[chain].id, gasPriceGwei: weiToGwei(hexToBigInt(price)) };
      } catch {
        // One chain's RPC being down should not fail the whole multi-chain call.
        return { chain, chainId: CHAINS[chain].id, gasPriceGwei: null };
      }
    }),
  );

  if (results.every((r) => r.gasPriceGwei === null)) {
    throw new UpstreamError("EVM RPC", "gas price could not be read on any requested chain");
  }

  return { chains: results, source: "Live RPC eth_gasPrice, each chain's public network" };
}

const DESCRIPTION = `Current gas price across multiple EVM chains in a single call.

Reads eth_gasPrice on every requested chain in parallel and returns gwei, so you do not have to query each chain's RPC separately and convert units yourself.

Supported chains: base, ethereum, optimism, arbitrum, polygon.

When to use: choosing the cheapest chain to transact on right now, cost estimation before submitting a transaction, monitoring for a low-gas window.

When NOT to use: you need an EIP-1559 fee breakdown (base fee vs priority fee) rather than a single legacy gas price, or historical gas data.

Args:
  - chains (string[], optional): which chains to check. Defaults to all five supported chains.

Returns structuredContent:
  {
    "chains": [
      { "chain": "base", "chainId": 8453, "gasPriceGwei": 0.006 },
      { "chain": "ethereum", "chainId": 1, "gasPriceGwei": 0.0986 },
      { "chain": "polygon", "chainId": 137, "gasPriceGwei": 278.97 }
    ],
    "source": "Live RPC eth_gasPrice, each chain's public network"
  }

A chain whose RPC could not be reached returns gasPriceGwei null rather than a stale or fabricated
value; if every requested chain fails the call errors and is not billed.`;

const inputSchema = {
  chains: z
    .array(z.enum(CHAIN_KEYS as [ChainKey, ...ChainKey[]]))
    .optional()
    .describe("Which chains to check. Defaults to all five supported chains."),
};

export const onchainGasTool: ToolModule = {
  name: TOOL_NAME,
  title: "Multi-chain Gas Price",
  description: DESCRIPTION,
  price: TOOL_PRICE,
  discovery: {
    inputSchema: {
      type: "object",
      properties: {
        chains: {
          type: "array",
          items: { type: "string" },
          description: "Chains to check; defaults to all five.",
        },
      },
    },
    output: {
      example: {
        chains: [
          { chain: "base", chainId: 8453, gasPriceGwei: 0.006 },
          { chain: "ethereum", chainId: 1, gasPriceGwei: 0.0986 },
        ],
      },
    },
  },
  register(server: McpServer) {
    server.registerTool(
      TOOL_NAME,
      {
        title: "Multi-chain Gas Price",
        description: DESCRIPTION,
        inputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ chains }) => {
        // Let UpstreamError propagate: the gate must not settle payment for a failed read.
        const result = await getGas(
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
