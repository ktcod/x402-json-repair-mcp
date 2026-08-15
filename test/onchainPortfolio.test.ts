import { describe, it, expect } from "vitest";
import { abiWord, decodeChainlinkAnswer } from "../src/tools/onchainPortfolio.js";

/** Build a synthetic ABI return of `words`, each given as a bigint. */
function encodeWords(words: bigint[]): string {
  return "0x" + words.map((w) => w.toString(16).padStart(64, "0")).join("");
}

/** Chainlink latestRoundData layout: (roundId, answer, startedAt, updatedAt, answeredInRound). */
function latestRoundData(answer: bigint): string {
  return encodeWords([12345n, answer, 1700000000n, 1700000000n, 12345n]);
}

describe("abiWord", () => {
  it("slices the requested 32-byte word", () => {
    const hex = encodeWords([1n, 2n, 3n]);
    expect(BigInt(abiWord(hex, 0) as string)).toBe(1n);
    expect(BigInt(abiWord(hex, 1) as string)).toBe(2n);
    expect(BigInt(abiWord(hex, 2) as string)).toBe(3n);
  });
  it("returns null past the end of the data", () => {
    expect(abiWord(encodeWords([1n]), 5)).toBeNull();
  });
  it("returns null for empty input", () => {
    expect(abiWord("0x", 0)).toBeNull();
    expect(abiWord(null, 0)).toBeNull();
  });
});

describe("decodeChainlinkAnswer", () => {
  it("reads the answer from word 1 and scales by feed decimals", () => {
    // 312044000000 at 8 decimals = 3120.44
    expect(decodeChainlinkAnswer(latestRoundData(312044000000n), 8)).toBeCloseTo(3120.44, 6);
  });

  it("handles a stablecoin feed at ~1.00", () => {
    expect(decodeChainlinkAnswer(latestRoundData(100000000n), 8)).toBeCloseTo(1, 8);
  });

  it("respects a non-8 decimal feed", () => {
    // 1500 at 2 decimals = 15.00
    expect(decodeChainlinkAnswer(latestRoundData(1500n), 2)).toBeCloseTo(15, 8);
  });

  it("returns null for a zero or negative answer (stale/invalid feed)", () => {
    expect(decodeChainlinkAnswer(latestRoundData(0n), 8)).toBeNull();
  });

  it("returns null when the response is empty or truncated", () => {
    expect(decodeChainlinkAnswer("0x", 8)).toBeNull();
    expect(decodeChainlinkAnswer(encodeWords([1n]), 8)).toBeNull();
  });

  it("does not confuse roundId (word 0) with the price (word 1)", () => {
    // roundId is deliberately large; the answer is small. Reading word 0 would give a wild price.
    const hex = encodeWords([999999999999n, 100000000n, 0n, 0n, 0n]);
    expect(decodeChainlinkAnswer(hex, 8)).toBeCloseTo(1, 8);
  });
});
