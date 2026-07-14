// ============================================================================
// PACKAGE VERSION
// ============================================================================
// Single source for the executant version, read from package.json relative to
// this file. Both src/*.ts in tsx dev and dist/index.js in the esbuild bundle
// sit one directory below the package root, so the "../package.json" hop
// resolves identically in both layouts.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CURRENT_VERSION = (
  JSON.parse(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../package.json"),
      "utf-8",
    ),
  ) as { version: string }
).version;
