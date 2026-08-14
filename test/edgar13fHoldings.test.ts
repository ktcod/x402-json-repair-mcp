import { describe, it, expect } from "vitest";
import { parseInfoTable, aggregateHoldings } from "../src/tools/edgar13fHoldings.js";

/**
 * Synthetic 13F information-table fixture. The value (577211815) and shares (12561737) are
 * the EXACT figures from a live Berkshire Hathaway filing pulled during development — chosen
 * deliberately because dividing them gives a plausible ~$45.95/share, which is what proved the
 * SEC's own "value is in thousands" documentation does not hold for this field in practice.
 */
const INFO_TABLE = `<?xml version="1.0"?>
<informationTable>
  <infoTable>
    <nameOfIssuer>ALLY FINL INC</nameOfIssuer>
    <cusip>02005N100</cusip>
    <value>577211815</value>
    <shrsOrPrnAmt>
      <sshPrnamt>12561737</sshPrnamt>
      <sshPrnamtType>SH</sshPrnamtType>
    </shrsOrPrnAmt>
  </infoTable>
  <infoTable>
    <nameOfIssuer>ALLY FINL INC</nameOfIssuer>
    <cusip>02005N100</cusip>
    <value>128838056</value>
    <shrsOrPrnAmt>
      <sshPrnamt>2803875</sshPrnamt>
      <sshPrnamtType>SH</sshPrnamtType>
    </shrsOrPrnAmt>
  </infoTable>
  <infoTable>
    <nameOfIssuer>EXAMPLE CORP</nameOfIssuer>
    <cusip>999999999</cusip>
    <value>1000000</value>
    <shrsOrPrnAmt>
      <sshPrnamt>10000</sshPrnamt>
    </shrsOrPrnAmt>
  </infoTable>
</informationTable>`;

describe("parseInfoTable", () => {
  it("extracts every infoTable entry", () => {
    expect(parseInfoTable(INFO_TABLE)).toHaveLength(3);
  });

  it("reads value and shares as plain numbers", () => {
    const [first] = parseInfoTable(INFO_TABLE);
    expect(first.issuer).toBe("ALLY FINL INC");
    expect(first.cusip).toBe("02005N100");
    expect(first.valueUsd).toBe(577211815);
    expect(first.shares).toBe(12561737);
  });

  it("treats the raw value as whole USD, NOT thousands", () => {
    // Regression guard for the 1000x bug: dividing value by shares must give a plausible
    // per-share price (tens of dollars), not an absurd one (tens of thousands).
    const [first] = parseInfoTable(INFO_TABLE);
    const impliedPrice = first.valueUsd / first.shares;
    expect(impliedPrice).toBeGreaterThan(1);
    expect(impliedPrice).toBeLessThan(1000);
    expect(impliedPrice).toBeCloseTo(45.95, 1);
  });

  it("skips a malformed entry missing required fields", () => {
    const partial = `<infoTable><nameOfIssuer>Bad Corp</nameOfIssuer></infoTable>`;
    expect(parseInfoTable(partial)).toHaveLength(0);
  });

  it("returns an empty array for a document with no holdings", () => {
    expect(parseInfoTable("<informationTable></informationTable>")).toEqual([]);
  });
});

describe("aggregateHoldings", () => {
  it("rolls up multiple lots of the same issuer+CUSIP into one row", () => {
    const agg = aggregateHoldings(parseInfoTable(INFO_TABLE));
    const ally = agg.find((h) => h.cusip === "02005N100");
    expect(ally).toBeDefined();
    expect(ally!.lots).toBe(2);
    expect(ally!.shares).toBe(12561737 + 2803875);
    expect(ally!.valueUsd).toBe(577211815 + 128838056);
  });

  it("does NOT multiply by 1000 (regression guard for the value-scaling bug)", () => {
    const agg = aggregateHoldings(parseInfoTable(INFO_TABLE));
    const ally = agg.find((h) => h.cusip === "02005N100")!;
    expect(ally.valueUsd).toBe(706049871); // sum of raw values, unscaled
  });

  it("keeps distinct issuers as separate rows", () => {
    expect(aggregateHoldings(parseInfoTable(INFO_TABLE))).toHaveLength(2);
  });

  it("sorts by value descending", () => {
    const agg = aggregateHoldings(parseInfoTable(INFO_TABLE));
    expect(agg[0].cusip).toBe("02005N100");
    expect(agg[0].valueUsd).toBeGreaterThan(agg[1].valueUsd);
  });

  it("gives a single-lot holding lots === 1", () => {
    const agg = aggregateHoldings(parseInfoTable(INFO_TABLE));
    const example = agg.find((h) => h.cusip === "999999999")!;
    expect(example.lots).toBe(1);
  });
});
