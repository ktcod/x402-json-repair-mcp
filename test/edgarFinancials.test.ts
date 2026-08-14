import { describe, it, expect } from "vitest";
import { selectPeriods } from "../src/tools/edgarFinancials.js";

/** A synthetic XBRL concept mixing annual (10-K) and quarterly (10-Q) observations. */
function concept(rows: Array<{ start?: string; end: string; val: number; form: string }>) {
  return { tag: "TestTag", units: { USD: rows } };
}

describe("selectPeriods", () => {
  it("classifies a ~365-day span as annual", () => {
    const r = selectPeriods(
      concept([{ start: "2024-09-30", end: "2025-09-27", val: 100, form: "10-K" }]),
    );
    expect(r.annual?.value).toBe(100);
    expect(r.quarterly).toBeNull();
  });

  it("classifies a ~90-day span as quarterly", () => {
    const r = selectPeriods(
      concept([{ start: "2026-03-29", end: "2026-06-27", val: 50, form: "10-Q" }]),
    );
    expect(r.quarterly?.value).toBe(50);
    expect(r.annual).toBeNull();
  });

  it("classifies an instant (no start) by form type", () => {
    const r = selectPeriods(concept([{ end: "2026-06-27", val: 999, form: "10-Q" }]));
    expect(r.quarterly?.value).toBe(999);
    expect(r.annual).toBeNull();
  });

  it("picks the NEWEST observation of each kind, not the first", () => {
    const r = selectPeriods(
      concept([
        { start: "2023-09-30", end: "2024-09-27", val: 10, form: "10-K" },
        { start: "2024-09-29", end: "2025-09-27", val: 20, form: "10-K" },
      ]),
    );
    expect(r.annual?.value).toBe(20);
    expect(r.annual?.end).toBe("2025-09-27");
  });

  it("ignores an observation with a nonsensical period length", () => {
    // A ~15-day span is neither annual nor quarterly and should be dropped.
    const r = selectPeriods(
      concept([{ start: "2026-06-01", end: "2026-06-16", val: 1, form: "10-Q" }]),
    );
    expect(r.annual).toBeNull();
    expect(r.quarterly).toBeNull();
  });

  it("returns null for both periods when there is no data", () => {
    const r = selectPeriods({ units: {} });
    expect(r.annual).toBeNull();
    expect(r.quarterly).toBeNull();
    expect(r.unit).toBeNull();
  });

  it("skips rows with a non-numeric or missing value", () => {
    const r = selectPeriods(
      concept([{ start: "2024-09-30", end: "2025-09-27", val: Number.NaN, form: "10-K" }]),
    );
    expect(r.annual).toBeNull();
  });
});
