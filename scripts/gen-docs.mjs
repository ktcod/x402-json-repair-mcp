#!/usr/bin/env node
/**
 * Generate src/docs.generated.ts from the Markdown docs.
 *
 * The Worker runtime has no filesystem, and the Node entrypoint shares the same module graph, so
 * the docs have to be embedded as strings rather than read at request time. The Markdown files
 * stay canonical (they are what GitHub renders); this mirrors them into the bundle.
 *
 * Run `npm run gen:docs` after editing either file. `test/docs.test.ts` fails if they drift.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const DOCS = [
  { file: "SKILL.md", constName: "SKILL_MD" },
  { file: "VERIFICATION.md", constName: "VERIFICATION_MD" },
];

export function readDoc(file) {
  return readFileSync(join(root, file), "utf8");
}

export function renderModule() {
  const body = DOCS.map(
    ({ file, constName }) =>
      `/** Verbatim contents of ${file}. Regenerate with \`npm run gen:docs\`. */\n` +
      `export const ${constName} = ${JSON.stringify(readDoc(file))};`,
  ).join("\n\n");

  return (
    "// GENERATED FILE — do not edit by hand.\n" +
    "// Source: SKILL.md, VERIFICATION.md. Regenerate with `npm run gen:docs`.\n" +
    "// test/docs.test.ts fails if this drifts from the Markdown.\n\n" +
    body +
    "\n"
  );
}

export const OUT = join(root, "src", "docs.generated.ts");

// Only write when invoked directly, so the test can import the helpers without side effects.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(OUT, renderModule());
  console.log(`wrote ${OUT}`);
}
