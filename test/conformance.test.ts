import { describe, it, expect } from "vitest";
import {
  CHECK_SPECS,
  checkHoldingsValueScale,
  checkSeriesNotEmpty,
  checkNationalMagnitude,
  checkFiniteNumbers,
  checkDerivedCompleteness,
  checkUnitsDeclared,
  checkFreshness,
  checkDecimalsAdjusted,
  summarize,
} from "../src/conformance/checks.js";

/**
 * These checks are the product claim, so they are tested against the ACTUAL defects that
 * motivated them — real figures from real filings — not invented fixtures that would pass by
 * construction. A check that cannot catch the bug it was written for is worse than no check.
 */
describe("holdings-value-scale (the 13F x1000 trap)", () => {
  // Real figures from Berkshire Hathaway's 13F. The correct reading of <value> is whole USD.
  const CORRECT = [
    { issuer: "ALLY FINL INC", valueUsd: 577_211_815, shares: 12_561_737 }, // ~$45.95/share
    { issuer: "APPLE INC", valueUsd: 57_000_000_000, shares: 300_000_000 }, // ~$190/share
    { issuer: "COCA COLA CO", valueUsd: 24_000_000_000, shares: 400_000_000 }, // ~$60/share
    { issuer: "AMERICAN EXPRESS", valueUsd: 34_000_000_000, shares: 151_000_000 }, // ~$225/share
  ];

  it("passes correctly-scaled holdings", () => {
    expect(checkHoldingsValueScale(CORRECT).status).toBe("pass");
  });

  it("catches the x1000 bug that SEC's own documentation leads you into", () => {
    const inflated = CORRECT.map((h) => ({ ...h, valueUsd: h.valueUsd * 1000 }));
    const f = checkHoldingsValueScale(inflated);
    expect(f.status).toBe("fail");
    expect(f.detail).toMatch(/1000/);
  });

  it("does not accuse a portfolio holding one genuinely expensive share class", () => {
    // Berkshire class-A really does trade near $700k. One outlier must not fail the check.
    const withBrkA = [
      ...CORRECT,
      { issuer: "BERKSHIRE HATHAWAY A", valueUsd: 7_000_000, shares: 10 },
    ];
    expect(checkHoldingsValueScale(withBrkA).status).toBe("pass");
  });

  it("skips rather than guesses when there is too little to judge", () => {
    expect(checkHoldingsValueScale([{ issuer: "X", valueUsd: 1e9, shares: 1 }]).status).toBe("skip");
  });
});

describe("series-not-empty (the BEA month-format and Census time-param traps)", () => {
  it("fails a successful-looking response with zero observations", () => {
    const f = checkSeriesNotEmpty(0, "PCE");
    expect(f.status).toBe("fail");
    expect(f.detail).toMatch(/zero observations/);
  });
  it("passes when observations are present", () => {
    expect(checkSeriesNotEmpty(24, "PCE").status).toBe("pass");
  });
});

describe("national-not-regional (the Census resconst trap)", () => {
  const NATIONAL = { min: 500, max: 3000 }; // housing starts, thousands SAAR

  it("passes a plausible national figure", () => {
    expect(checkNationalMagnitude(1385, "housing starts", NATIONAL).status).toBe("pass");
  });

  it("catches a single census region reported as the national total", () => {
    // 177 + 751 + 295 + 162 = 1385: the four regions that summed to the national figure.
    const f = checkNationalMagnitude(295, "housing starts", NATIONAL);
    expect(f.status).toBe("fail");
    expect(f.detail).toMatch(/regional/);
  });

  it("skips an unavailable value instead of failing it", () => {
    expect(checkNationalMagnitude(null, "housing starts", NATIONAL).status).toBe("skip");
  });
});

describe("finite-numbers (the typeof NaN trap)", () => {
  it("finds NaN nested inside arrays and objects", () => {
    const f = checkFiniteNumbers({ a: { b: [1, 2, NaN] } }, "payload");
    expect(f.status).toBe("fail");
    expect(f.detail).toMatch(/a\.b\[2\]/);
  });
  it("finds Infinity", () => {
    expect(checkFiniteNumbers({ x: Infinity }, "payload").status).toBe("fail");
  });
  it("passes clean payloads, including nulls", () => {
    expect(checkFiniteNumbers({ a: 1, b: null, c: "text" }, "payload").status).toBe("pass");
  });
});

describe("derived-completeness (the silent-null YoY trap)", () => {
  it("fails a null derived value when its inputs were available", () => {
    expect(checkDerivedCompleteness(null, true, "yoyPercent").status).toBe("fail");
  });
  it("skips when the inputs genuinely were not in range", () => {
    expect(checkDerivedCompleteness(null, false, "yoyPercent").status).toBe("skip");
  });
  it("passes a present value", () => {
    expect(checkDerivedCompleteness(3.4, true, "yoyPercent").status).toBe("pass");
  });
});

describe("units-declared", () => {
  it("fails a bare number with no as-of and no unit", () => {
    expect(checkUnitsDeclared({ value: 4.17 }).status).toBe("fail");
  });
  it("fails when the unit is stated but the as-of date is missing", () => {
    const f = checkUnitsDeclared({ salesMillions: 766192 });
    expect(f.status).toBe("fail");
    expect(f.detail).toMatch(/as-of/);
  });
  it("passes when both are present", () => {
    expect(checkUnitsDeclared({ asOf: "2026-06", salesMillions: 766192 }).status).toBe("pass");
  });
});

describe("freshness", () => {
  const NOW = new Date("2026-08-14T00:00:00Z");
  it("passes data inside the publication lag", () => {
    expect(checkFreshness("2026-06", 90, "CPI", NOW).status).toBe("pass");
  });
  it("fails stale data", () => {
    expect(checkFreshness("2024-01", 90, "CPI", NOW).status).toBe("fail");
  });
  it("fails a future as-of date", () => {
    expect(checkFreshness("2027-01-01", 90, "CPI", NOW).status).toBe("fail");
  });
  it("fails a missing as-of date", () => {
    expect(checkFreshness(null, 90, "CPI", NOW).status).toBe("fail");
  });
});

describe("decimals-adjusted", () => {
  it("catches a raw 18-decimal base-unit balance", () => {
    const f = checkDecimalsAdjusted(1.5e18, 18, "WETH");
    expect(f.status).toBe("fail");
    expect(f.detail).toMatch(/raw base units/);
  });
  it("passes an adjusted balance", () => {
    expect(checkDecimalsAdjusted(1.5, 18, "WETH").status).toBe("pass");
  });
  it("fails when decimals are not reported at all", () => {
    expect(checkDecimalsAdjusted(1234, null, "TOKEN").status).toBe("fail");
  });
});

describe("suite plumbing", () => {
  it("summarizes findings and is not ok when anything failed", () => {
    const s = summarize([
      { checkId: "a", status: "pass", detail: "" },
      { checkId: "b", status: "fail", detail: "" },
      { checkId: "c", status: "skip", detail: "" },
    ]);
    expect(s).toMatchObject({ passed: 1, failed: 1, skipped: 1, ok: false });
  });

  it("documents every check id it exports", () => {
    const ids = CHECK_SPECS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const spec of CHECK_SPECS) {
      expect(spec.title.length).toBeGreaterThan(0);
      expect(spec.catches.length).toBeGreaterThan(40);
    }
  });
});
