import { readFile } from "node:fs/promises";
import { Ajv, type ValidateFunction } from "ajv";
import { beforeAll, describe, expect, it } from "vitest";
import { validateManifest } from "../../../src/core/manifest.js";
import {
  MANIFEST_JSON_SCHEMA_PATH,
  renderManifestJsonSchema,
} from "../../../src/plugins/plugin-builder/src/generate-manifest-json-schema.js";
import { isOk } from "../../../src/core/types.js";
import { MANIFEST_FIXTURES } from "../../fixtures/plugin-manifests.js";

describe("published plugin.json JSON Schema (feature #74)", () => {
  it("the checked-in schema file is exactly what generatePluginManifestJsonSchema() produces right now — never hand-edited out of sync with src/core/manifest.ts", async () => {
    const committed = await readFile(MANIFEST_JSON_SCHEMA_PATH, "utf-8");
    expect(committed).toBe(renderManifestJsonSchema());
  });

  describe("validating fixtures against the exported schema", () => {
    let validate: ValidateFunction;

    beforeAll(async () => {
      const raw = await readFile(MANIFEST_JSON_SCHEMA_PATH, "utf-8");
      const schema = JSON.parse(raw) as Record<string, unknown>;
      // `strict: true` doubles as a check that the generated document is a
      // well-formed schema ajv is happy to compile — no unknown/misused
      // keywords slipped in by the generator or a hand-edit of the file.
      const ajv = new Ajv({ allErrors: true, strict: true });
      validate = ajv.compile(schema);
    });

    it.each(MANIFEST_FIXTURES)("$description", ({ input, valid, schemaParity = true }) => {
      const kernelAccepts = isOk(validateManifest(input));
      // Fixture sanity check: confirms this shared fixture list still means what
      // tests/core/manifest.test.ts (feature #4) expects it to mean.
      expect(kernelAccepts).toBe(valid);

      const schemaAccepts = validate(input);

      if (schemaParity) {
        expect(schemaAccepts).toBe(kernelAccepts);
      } else {
        // Documented gap (see manifest-json-schema.ts): full semver-*range*
        // grammar has no static JSON Schema equivalent, so the exported
        // schema is intentionally more permissive than the kernel here.
        expect(kernelAccepts).toBe(false);
        expect(schemaAccepts).toBe(true);
      }
    });
  });
});
