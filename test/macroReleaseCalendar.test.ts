import { describe, it, expect } from "vitest";
import { parseIcsReleases, parseIcsDate, unfoldIcs } from "../src/tools/macroReleaseCalendar.js";
import { UpstreamError } from "../src/upstream/http.js";

/** Synthetic iCalendar fixture in the shape BLS publishes. */
const ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "DTSTART:20260910T083000Z",
  "SUMMARY:Consumer Price Index",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART;VALUE=DATE:20260905",
  "SUMMARY:Employment Situation",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART:20260801T083000Z",
  "SUMMARY:Producer Price Index",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("unfoldIcs", () => {
  it("joins RFC 5545 folded continuation lines", () => {
    const folded = "SUMMARY:Consumer Price\r\n  Index\r\nDTSTART:20260101";
    expect(unfoldIcs(folded)[0]).toBe("SUMMARY:Consumer Price Index");
  });
  it("leaves unfolded lines untouched", () => {
    expect(unfoldIcs("A:1\r\nB:2")).toEqual(["A:1", "B:2"]);
  });
});

describe("parseIcsDate", () => {
  it("parses a date-only value as an all-day entry", () => {
    expect(parseIcsDate("20260905")).toEqual({ date: "2026-09-05", datetime: null });
  });
  it("parses a UTC timestamp", () => {
    expect(parseIcsDate("20260910T083000Z")).toEqual({
      date: "2026-09-10",
      datetime: "2026-09-10T08:30:00Z",
    });
  });
  it("returns null for an unrecognised value", () => {
    expect(parseIcsDate("not-a-date")).toBeNull();
  });
});

describe("parseIcsReleases", () => {
  it("returns only releases on or after the cutoff, soonest first", () => {
    const out = parseIcsReleases(ICS, "2026-08-14", 10);
    expect(out.map((r) => r.title)).toEqual(["Employment Situation", "Consumer Price Index"]);
  });

  it("keeps an event falling exactly on the cutoff date", () => {
    expect(parseIcsReleases(ICS, "2026-09-05", 10)).toHaveLength(2);
  });

  it("carries the time through when the feed supplies one", () => {
    const [, cpi] = parseIcsReleases(ICS, "2026-08-14", 10);
    expect(cpi.datetime).toBe("2026-09-10T08:30:00Z");
  });

  it("reports null datetime for all-day entries", () => {
    const [emp] = parseIcsReleases(ICS, "2026-08-14", 10);
    expect(emp.datetime).toBeNull();
    expect(emp.date).toBe("2026-09-05");
  });

  it("honours the limit", () => {
    expect(parseIcsReleases(ICS, "2026-08-14", 1)).toHaveLength(1);
  });

  it("filters by case-insensitive title substring", () => {
    expect(parseIcsReleases(ICS, "2026-08-14", 10, "cpi")).toHaveLength(0);
    expect(parseIcsReleases(ICS, "2026-08-14", 10, "CONSUMER")[0].title).toBe(
      "Consumer Price Index",
    );
  });

  it("throws UpstreamError when the feed has no events", () => {
    expect(() => parseIcsReleases("BEGIN:VCALENDAR\r\nEND:VCALENDAR", "2026-01-01", 10)).toThrow(
      UpstreamError,
    );
  });
});
