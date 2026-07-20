import { readFile } from "node:fs/promises";

import AjvDraft2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { describe, expect, it } from "vitest";

import { contractDefinitions } from "../src/registry.js";

interface FixtureCase {
  readonly contract: string;
  readonly fixture: string;
  readonly expected_valid: boolean;
  readonly json_schema_valid?: boolean;
}

interface FixtureManifest {
  readonly schema_version: "2.0";
  readonly cases: readonly FixtureCase[];
}

const fixtures = new URL("../../../fixtures/contracts/current/", import.meta.url);
const generated = new URL("../generated/", import.meta.url);
const definitions = contractDefinitions;

async function readJson<T>(url: URL): Promise<T> {
  return JSON.parse(await readFile(url, "utf8")) as T;
}

function isNonnegativeInt64(value: string): boolean {
  try {
    const parsed = BigInt(value);
    return parsed >= 0n && parsed <= 9_223_372_036_854_775_807n;
  } catch {
    return false;
  }
}

function isSignedInt64(value: string): boolean {
  try {
    const parsed = BigInt(value);
    return parsed >= -9_223_372_036_854_775_808n && parsed <= 9_223_372_036_854_775_807n;
  } catch {
    return false;
  }
}

describe("Contracts generated JSON Schema", () => {
  it("strictly compiles every artifact and validates the fixture manifest", async () => {
    const manifest = await readJson<FixtureManifest>(new URL("manifest.json", fixtures));
    expect(manifest.schema_version).toBe("2.0");
    const ajv = new AjvDraft2020Module.default({ allErrors: true, strict: true });
    addFormatsModule.default(ajv);
    ajv.addFormat("nonnegative-int64-string", {
      type: "string",
      validate: isNonnegativeInt64,
    });
    ajv.addFormat("int64-string", { type: "string", validate: isSignedInt64 });

    const validators = new Map<string, ReturnType<typeof ajv.compile>>();
    for (const definition of definitions) {
      const schema = await readJson<Record<string, unknown>>(
        new URL(definition.fileName, generated),
      );
      validators.set(definition.name, ajv.compile(schema));
    }

    for (const fixtureCase of manifest.cases) {
      const validate = validators.get(fixtureCase.contract);
      expect(validate, `Missing generated schema ${fixtureCase.contract}`).toBeDefined();
      const payload = await readJson<unknown>(new URL(fixtureCase.fixture, fixtures));
      const expected = fixtureCase.json_schema_valid ?? fixtureCase.expected_valid;
      expect(validate?.(payload), `${fixtureCase.contract}: ${fixtureCase.fixture}`).toBe(expected);
    }
  });

  it("covers every public artifact with a valid cross-language fixture", async () => {
    const manifest = await readJson<FixtureManifest>(new URL("manifest.json", fixtures));
    const covered = new Set(
      manifest.cases
        .filter((fixtureCase) => fixtureCase.expected_valid)
        .map(({ contract }) => contract),
    );
    expect(covered).toEqual(new Set(definitions.map(({ name }) => name)));
  });

  it("keeps semantic-only invalid cases explicit for Zod/Pydantic parity", async () => {
    const manifest = await readJson<FixtureManifest>(new URL("manifest.json", fixtures));
    const semanticCases = manifest.cases.filter(
      (fixtureCase) => fixtureCase.json_schema_valid !== undefined,
    );
    expect(semanticCases.length).toBeGreaterThan(0);
    expect(
      semanticCases.every(
        (fixtureCase) =>
          fixtureCase.expected_valid === false && fixtureCase.json_schema_valid === true,
      ),
    ).toBe(true);
  });
});
