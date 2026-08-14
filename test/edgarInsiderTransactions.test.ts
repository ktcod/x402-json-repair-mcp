import { describe, it, expect } from "vitest";
import {
  parseOwnershipXml,
  rawOwnershipDocUrl,
  tagValue,
} from "../src/tools/edgarInsiderTransactions.js";

/**
 * Synthetic Form 4 fixture with TWO non-derivative transactions, mirroring the real SEC layout
 * (values wrapped in <value>, and one transaction missing a price as happens with code M).
 */
const FORM4 = `<?xml version="1.0"?>
<ownershipDocument>
  <issuer>
    <issuerName>Example Corp.</issuerName>
    <issuerTradingSymbol>EXMP</issuerTradingSymbol>
  </issuer>
  <reportingOwner>
    <reportingOwnerId><rptOwnerName>Doe Jane</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship>
      <isDirector>0</isDirector>
      <isOfficer>1</isOfficer>
      <officerTitle>Chief Financial Officer</officerTitle>
    </reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <transactionDate><value>2026-03-02</value></transactionDate>
      <transactionCoding><transactionCode>S</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>1,000</value></transactionShares>
        <transactionPricePerShare><value>250.50</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
      <postTransactionAmounts>
        <sharesOwnedFollowingTransaction><value>4000</value></sharesOwnedFollowingTransaction>
      </postTransactionAmounts>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <transactionDate><value>2026-03-03</value></transactionDate>
      <transactionCoding><transactionCode>M</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>500</value></transactionShares>
        <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
      <postTransactionAmounts>
        <sharesOwnedFollowingTransaction><value>4500</value></sharesOwnedFollowingTransaction>
      </postTransactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>`;

describe("tagValue", () => {
  it("reads a plain tag", () => {
    expect(tagValue("<a>hello</a>", "a")).toBe("hello");
  });
  it("unwraps an inner <value> element", () => {
    expect(tagValue("<a><value>42</value></a>", "a")).toBe("42");
  });
  it("returns null for a missing tag", () => {
    expect(tagValue("<a>1</a>", "zzz")).toBeNull();
  });
  it("returns null for an empty tag", () => {
    expect(tagValue("<a></a>", "a")).toBeNull();
  });
});

describe("rawOwnershipDocUrl", () => {
  it("strips the XSL rendering path to reach the machine-readable XML", () => {
    expect(rawOwnershipDocUrl(320193, "0001140361-26-032884", "xslF345X06/form4.xml")).toBe(
      "https://www.sec.gov/Archives/edgar/data/320193/000114036126032884/form4.xml",
    );
  });
  it("leaves an already-raw document path alone", () => {
    expect(rawOwnershipDocUrl(1, "0000000000-26-000001", "form4.xml")).toBe(
      "https://www.sec.gov/Archives/edgar/data/1/000000000026000001/form4.xml",
    );
  });
});

describe("parseOwnershipXml", () => {
  it("extracts issuer and reporting-owner details", () => {
    const p = parseOwnershipXml(FORM4);
    expect(p.issuer).toBe("Example Corp.");
    expect(p.ticker).toBe("EXMP");
    expect(p.owner).toBe("Doe Jane");
    expect(p.ownerTitle).toBe("Chief Financial Officer");
    expect(p.isOfficer).toBe(true);
    expect(p.isDirector).toBe(false);
  });

  it("parses EVERY transaction, not just the first", () => {
    expect(parseOwnershipXml(FORM4).transactions).toHaveLength(2);
  });

  it("computes dollar value and translates the transaction code", () => {
    const [sale] = parseOwnershipXml(FORM4).transactions;
    expect(sale.date).toBe("2026-03-02");
    expect(sale.code).toBe("S");
    expect(sale.codeMeaning).toBe("Open-market or private sale");
    expect(sale.acquiredDisposed).toBe("D");
    expect(sale.shares).toBe(1000);
    expect(sale.pricePerShare).toBe(250.5);
    expect(sale.value).toBe(250500);
    expect(sale.sharesOwnedAfter).toBe(4000);
  });

  it("reports null (not 0) when a transaction has no price, as with code M", () => {
    const [, exercise] = parseOwnershipXml(FORM4).transactions;
    expect(exercise.code).toBe("M");
    expect(exercise.codeMeaning).toBe("Exercise or conversion of a derivative security");
    expect(exercise.pricePerShare).toBeNull();
    expect(exercise.value).toBeNull();
    expect(exercise.shares).toBe(500);
  });

  it("returns no transactions for a filing without a non-derivative table", () => {
    expect(parseOwnershipXml("<ownershipDocument><issuer/></ownershipDocument>").transactions).toEqual(
      [],
    );
  });
});
