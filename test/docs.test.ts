import { describe, it, expect } from "vitest";
// @ts-expect-error - plain .mjs helper, no type declarations
import { DOCS, readDoc } from "../scripts/gen-docs.mjs";
import { SKILL_MD, VERIFICATION_MD, CONFORMANCE_MD } from "../src/docs.generated.js";

/**
 * SKILL.md and VERIFICATION.md are served from the bundle (the Worker has no filesystem), so the
 * shipped copy is a generated mirror of the Markdown. Nothing stops the two diverging except this
 * test — and a stale verification ledger is worse than none, since its entire value is being
 * trustworthy about correctness.
 */
describe("generated docs match their Markdown sources", () => {
  const embedded: Record<string, string> = { SKILL_MD, VERIFICATION_MD, CONFORMANCE_MD };

  for (const { file, constName } of DOCS as Array<{ file: string; constName: string }>) {
    it(`${file} is in sync with ${constName} (run \`npm run gen:docs\`)`, () => {
      expect(embedded[constName]).toBe(readDoc(file));
    });
  }

  it("serves non-trivial content", () => {
    expect(SKILL_MD.length).toBeGreaterThan(500);
    expect(VERIFICATION_MD.length).toBeGreaterThan(500);
  });
});
