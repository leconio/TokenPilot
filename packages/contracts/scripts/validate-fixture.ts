import { readFile } from "node:fs/promises";

import { contractDefinitions } from "../src/registry.js";

const aliases: Readonly<Record<string, string>> = {
  usage: "UsageEvent",
  usageBatch: "UsageBatch",
  normalizedUsage: "NormalizedUsage",
  heartbeat: "ConnectorHeartbeat",
  batchResponse: "BatchIngestionResponse",
  error: "ApiError",
};

interface BatchCase {
  readonly contract: string;
  readonly fixture: string;
}

async function validateFixture(contractName: string, fixturePath: string): Promise<unknown> {
  const canonicalName = aliases[contractName] ?? contractName;
  const definition = contractDefinitions.find((candidate) => candidate.name === canonicalName);
  if (definition === undefined) {
    throw new Error(`Unknown Contract ${contractName}`);
  }

  const input: unknown = JSON.parse(await readFile(fixturePath, "utf8"));
  const result = definition.schema.safeParse(input);
  return result.success ? { valid: true, value: result.data } : { valid: false };
}

async function readStandardInput(): Promise<string> {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    input += String(chunk);
  }
  return input;
}

const [contractName, fixturePath] = process.argv.slice(2);

if (contractName === "--batch") {
  const cases = JSON.parse(await readStandardInput()) as readonly BatchCase[];
  const results = await Promise.all(
    cases.map(({ contract, fixture }) => validateFixture(contract, fixture)),
  );
  process.stdout.write(JSON.stringify(results));
} else {
  if (contractName === undefined || fixturePath === undefined) {
    throw new Error("Usage: validate-fixture.ts <contract-name> <fixture-path> | --batch");
  }
  process.stdout.write(JSON.stringify(await validateFixture(contractName, fixturePath)));
}
