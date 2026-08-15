import { describe, it, expect } from "vitest";
import { recentFilings, filingUrl } from "../src/upstream/sec.js";

const SUBS = {
  name: "Example Corp.",
  filings: {
    recent: {
      form: ["10-K", "8-K", "8-K", "4", "10-Q"],
      filingDate: ["2026-01-10", "2026-02-01", "2026-03-01", "2026-03-15", "2026-04-01"],
      reportDate: ["2025-12-31", "2026-01-30", "2026-02-28", "", "2026-03-31"],
      accessionNumber: [
        "0001-26-000001",
        "0001-26-000002",
        "0001-26-000003",
        "0001-26-000004",
        "0001-26-000005",
      ],
      primaryDocument: ["10k.htm", "8k1.htm", "8k2.htm", "form4.xml", "10q.htm"],
      primaryDocDescription: ["10-K", "8-K", "8-K", "4", "10-Q"],
      items: ["", "2.02,9.01", "5.02", "", ""],
    },
  },
};

describe("recentFilings", () => {
  it("returns everything when no form filter is given", () => {
    expect(recentFilings(SUBS)).toHaveLength(5);
  });

  it("filters to the requested form types only", () => {
    const eightKs = recentFilings(SUBS, ["8-K"]);
    expect(eightKs).toHaveLength(2);
    expect(eightKs.every((f) => f.form === "8-K")).toBe(true);
  });

  it("respects the limit", () => {
    expect(recentFilings(SUBS, undefined, 2)).toHaveLength(2);
  });

  it("carries through the 8-K item codes", () => {
    const [first] = recentFilings(SUBS, ["8-K"], 1);
    expect(first.items).toBe("2.02,9.01");
  });

  it("treats an empty reportDate as null rather than an empty string", () => {
    const [form4] = recentFilings(SUBS, ["4"]);
    expect(form4.reportDate).toBeNull();
  });

  it("returns an empty array when nothing matches the filter", () => {
    expect(recentFilings(SUBS, ["S-1"])).toEqual([]);
  });
});

describe("filingUrl", () => {
  it("strips dashes from the accession number and builds the Archives path", () => {
    expect(filingUrl(320193, "0001193125-26-032884", "form4.xml")).toBe(
      "https://www.sec.gov/Archives/edgar/data/320193/000119312526032884/form4.xml",
    );
  });
});
