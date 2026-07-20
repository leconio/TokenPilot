import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { contractDefinitions } from "../src/registry.js";

const contractVersion = "0.2.0";
const outputDirectory = fileURLToPath(new URL("../generated/", import.meta.url));

function toJsonSchema(
  name: string,
  schema: z.ZodType,
  reused: "ref" | "inline" = "ref",
): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    reused,
  }) as Record<string, unknown>;
  delete generated.id;
  delete generated.$id;
  return {
    $id: `https://tokenpilot.dev/schemas/${name}`,
    ...generated,
  };
}

function withoutSchemaMetadata(schema: Record<string, unknown>): Record<string, unknown> {
  const component = { ...schema };
  delete component.$id;
  delete component.$schema;
  return component;
}

function inlineLocalDefinitions(schema: Record<string, unknown>): Record<string, unknown> {
  const definitions =
    schema.$defs !== null && typeof schema.$defs === "object" && !Array.isArray(schema.$defs)
      ? (schema.$defs as Record<string, unknown>)
      : {};

  function expand(value: unknown, stack: readonly string[] = []): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => expand(item, stack));
    }
    if (value === null || typeof value !== "object") {
      return value;
    }

    const record = value as Record<string, unknown>;
    const reference = record.$ref;
    if (typeof reference === "string" && reference.startsWith("#/$defs/")) {
      const definitionName = decodeURIComponent(reference.slice("#/$defs/".length));
      const definition = definitions[definitionName];
      if (definition === undefined) {
        throw new Error(`Missing local JSON Schema definition ${definitionName}`);
      }
      if (stack.includes(definitionName)) {
        throw new Error(`Recursive local JSON Schema definition ${definitionName} is unsupported`);
      }
      const siblings = Object.fromEntries(
        Object.entries(record)
          .filter(([key]) => key !== "$ref")
          .map(([key, child]) => [key, expand(child, stack)]),
      );
      return {
        ...(expand(definition, [...stack, definitionName]) as Record<string, unknown>),
        ...siblings,
      };
    }

    return Object.fromEntries(
      Object.entries(record)
        .filter(([key]) => key !== "$defs")
        .map(([key, child]) => [key, expand(child, stack)]),
    );
  }

  return expand(schema) as Record<string, unknown>;
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const artifacts = contractDefinitions.map((definition) => {
  if ("dto" in definition && definition.dto.schema !== definition.schema) {
    throw new Error(`${definition.name} DTO is not backed by its canonical Zod schema`);
  }
  const schema = toJsonSchema(definition.fileName, definition.schema);
  const content = serialize(schema);
  return {
    ...definition,
    sourceSchema: definition.schema,
    schema,
    content,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
});

const openApiComponents = {
  openapi: "3.1.0",
  info: {
    title: "TokenPilot Contracts",
    version: contractVersion,
  },
  paths: {},
  components: {
    schemas: Object.fromEntries(
      artifacts.map((artifact) => [
        artifact.name,
        inlineLocalDefinitions(
          withoutSchemaMetadata(toJsonSchema(artifact.fileName, artifact.sourceSchema, "inline")),
        ),
      ]),
    ),
  },
};

const manifest = {
  schema_version: "2.0",
  contract_version: contractVersion,
  artifacts: artifacts.map((artifact) => ({
    name: artifact.name,
    file: artifact.fileName,
    sha256: artifact.sha256,
  })),
};

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  ...artifacts.map((artifact) =>
    writeFile(join(outputDirectory, artifact.fileName), artifact.content),
  ),
  writeFile(join(outputDirectory, "openapi-components.json"), serialize(openApiComponents)),
  writeFile(join(outputDirectory, "contracts-manifest.json"), serialize(manifest)),
]);
