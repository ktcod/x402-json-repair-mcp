import { describe, it, expect } from "vitest";
import { normalizeAddresses, MAX_ADDRESSES } from "../src/tools/onchainBalances.js";
import { UpstreamError } from "../src/upstream/http.js";
import {
  assertAddress,
  decodeAbiString,
  encodeBalanceOf,
  formatUnits,
  hexToBigInt,
  padAddress,
  CHAINS,
} from "../src/upstream/evm.js";

const A1 = "0x0000000000000000000000000000000000000001";
const A2 = "0x0000000000000000000000000000000000000002";

describe("assertAddress", () => {
  it("lowercases a valid address", () => {
    expect(assertAddress("0xABCDEF0123456789abcdef0123456789ABCDEF01")).toBe(
      "0xabcdef0123456789abcdef0123456789abcdef01",
    );
  });
  it("rejects a malformed address", () => {
    expect(() => assertAddress("0x123")).toThrow(UpstreamError);
    expect(() => assertAddress("not-an-address")).toThrow(UpstreamError);
  });
  it("rejects an address containing a non-hex character", () => {
    expect(() => assertAddress("0x00000000000000000000000000000000000000zz")).toThrow(UpstreamError);
  });
});

describe("ABI encoding helpers", () => {
  it("pads an address to a 32-byte word", () => {
    const padded = padAddress(A1);
    expect(padded).toHaveLength(64);
    expect(padded.endsWith("0000000000000000000000000000000000000001")).toBe(true);
  });

  it("encodes balanceOf with the correct selector and argument", () => {
    const data = encodeBalanceOf(A2);
    expect(data.startsWith("0x70a08231")).toBe(true);
    // "0x" + 8-char selector + one 32-byte word (64 chars)
    expect(data).toHaveLength(74);
  });

  it("decodes hex quantities, treating 0x and null as null", () => {
    expect(hexToBigInt("0x2710")).toBe(10000n);
    expect(hexToBigInt("0x")).toBeNull();
    expect(hexToBigInt(null)).toBeNull();
    expect(hexToBigInt("nonsense")).toBeNull();
  });
});

describe("formatUnits", () => {
  it("scales by token decimals without floating-point drift", () => {
    expect(formatUnits(10000n, 6)).toBe("0.01");
    expect(formatUnits(1234560000n, 6)).toBe("1234.56");
    expect(formatUnits(1n, 18)).toBe("0.000000000000000001");
  });
  it("renders whole amounts without a trailing dot", () => {
    expect(formatUnits(5000000n, 6)).toBe("5");
    expect(formatUnits(0n, 6)).toBe("0");
  });
  it("handles zero-decimal tokens", () => {
    expect(formatUnits(42n, 0)).toBe("42");
  });
});

describe("decodeAbiString", () => {
  it("decodes a dynamic string return (USDC symbol)", () => {
    // offset = 0x20, length = 4, then "USDC" right-padded to a full word
    const hex =
      "0x" +
      "0".repeat(62) +
      "20" +
      "0".repeat(62) +
      "04" +
      Buffer.from("USDC").toString("hex").padEnd(64, "0");
    expect(decodeAbiString(hex)).toBe("USDC");
  });
  it("returns null for empty data", () => {
    expect(decodeAbiString("0x")).toBeNull();
    expect(decodeAbiString(null)).toBeNull();
  });
});

describe("normalizeAddresses", () => {
  it("de-duplicates while preserving caller order", () => {
    expect(normalizeAddresses([A2, A1, A2])).toEqual([A2, A1]);
  });
  it("treats differing case as the same address", () => {
    expect(normalizeAddresses([A1, "0x" + A1.slice(2).toUpperCase()])).toHaveLength(1);
  });
  it("rejects an empty list", () => {
    expect(() => normalizeAddresses([])).toThrow(UpstreamError);
  });
  it(`rejects more than ${MAX_ADDRESSES} addresses`, () => {
    const many = Array.from(
      { length: MAX_ADDRESSES + 1 },
      (_, i) => "0x" + (i + 1).toString(16).padStart(40, "0"),
    );
    expect(() => normalizeAddresses(many)).toThrow(UpstreamError);
  });
  it(`accepts exactly ${MAX_ADDRESSES} addresses`, () => {
    const many = Array.from(
      { length: MAX_ADDRESSES },
      (_, i) => "0x" + (i + 1).toString(16).padStart(40, "0"),
    );
    expect(normalizeAddresses(many)).toHaveLength(MAX_ADDRESSES);
  });
});

describe("chain registry", () => {
  it("knows Base and its canonical USDC", () => {
    expect(CHAINS.base.id).toBe(8453);
    expect(CHAINS.base.usdc.toLowerCase()).toBe("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
  });
  it("gives every chain at least one RPC endpoint", () => {
    for (const spec of Object.values(CHAINS)) {
      expect(spec.rpcs.length).toBeGreaterThan(0);
    }
  });
});
