import { describe, it, expect } from "vitest";
import { parseYieldCurveCsv, yieldCurveCsvUrl } from "../src/tools/treasuryYieldCurve.js";
import { UpstreamError } from "../src/upstream/http.js";

/** Synthetic fixture matching Treasury's real header shape (quoted, space-separated tenors). */
const CSV = `Date,"1 Mo","1.5 Month","2 Mo","3 Mo","4 Mo","6 Mo","1 Yr","2 Yr","3 Yr","5 Yr","7 Yr","10 Yr","20 Yr","30 Yr"
01/03/2026,3.70,3.71,3.72,3.80,3.82,3.90,3.95,4.10,4.20,4.30,4.45,4.60,5.20,5.20
01/02/2026,3.60,3.61,3.62,3.70,3.72,3.80,3.85,4.00,4.10,4.20,4.35,4.50,5.10,5.10`;

describe("yieldCurveCsvUrl", () => {
  it("targets the requested calendar year", () => {
    const url = yieldCurveCsvUrl(2026);
    expect(url).toContain("/2026/all");
    expect(url).toContain("type=daily_treasury_yield_curve");
    expect(url).toContain("_format=csv");
  });
});

describe("parseYieldCurveCsv", () => {
  it("returns the newest day first with canonical tenor keys", () => {
    const [latest] = parseYieldCurveCsv(CSV, 1);
    expect(latest.date).toBe("2026-01-03");
    expect(latest.tenors["3M"]).toBe(3.8);
    expect(latest.tenors["2Y"]).toBe(4.1);
    expect(latest.tenors["10Y"]).toBe(4.6);
    expect(latest.tenors["30Y"]).toBe(5.2);
  });

  it("converts MM/DD/YYYY into ISO dates", () => {
    expect(parseYieldCurveCsv(CSV, 2)[1].date).toBe("2026-01-02");
  });

  it("computes the 2s10s and 3m10y spreads", () => {
    const [latest] = parseYieldCurveCsv(CSV, 1);
    // 4.60 - 4.10 = 0.50 ; 4.60 - 3.80 = 0.80
    expect(latest.spread2s10s).toBe(0.5);
    expect(latest.spread3m10y).toBe(0.8);
    expect(latest.inverted).toBe(false);
  });

  it("flags an inverted curve when 10Y sits below 2Y", () => {
    const inverted = `Date,"3 Mo","2 Yr","10 Yr"
02/02/2026,5.30,4.90,4.10`;
    const [day] = parseYieldCurveCsv(inverted, 1);
    expect(day.inverted).toBe(true);
    expect(day.spread2s10s).toBe(-0.8);
  });

  it("honours the requested number of days", () => {
    expect(parseYieldCurveCsv(CSV, 2)).toHaveLength(2);
    expect(parseYieldCurveCsv(CSV, 1)).toHaveLength(1);
    // A limit below 1 still yields the latest day rather than an empty result.
    expect(parseYieldCurveCsv(CSV, 0)).toHaveLength(1);
  });

  it("skips blank tenor cells instead of emitting NaN", () => {
    const gappy = `Date,"3 Mo","2 Yr","10 Yr"
03/03/2026,,4.00,4.50`;
    const [day] = parseYieldCurveCsv(gappy, 1);
    expect(day.tenors["3M"]).toBeUndefined();
    expect(day.spread3m10y).toBeNull();
    expect(day.spread2s10s).toBe(0.5);
  });

  it("throws UpstreamError when the CSV has no data rows", () => {
    expect(() => parseYieldCurveCsv(`Date,"10 Yr"`, 1)).toThrow(UpstreamError);
  });
});
