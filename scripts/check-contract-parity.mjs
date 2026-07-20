import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(
  readFileSync(`${root}/fixtures/contracts/current/manifest.json`, "utf8"),
);
const cases = manifest.cases.map(({ contract, fixture, expected_valid: expectedValid }) => [
  contract,
  `fixtures/contracts/current/${fixture}`,
  expectedValid,
]);

function execute(command, args, input) {
  return JSON.parse(execFileSync(command, args, { cwd: root, encoding: "utf8", input }));
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

const batchInput = JSON.stringify(cases.map(([contract, fixture]) => ({ contract, fixture })));
const typescriptResults = execute(
  process.execPath,
  ["--import", "tsx", "packages/contracts/scripts/validate-fixture.ts", "--batch"],
  batchInput,
);
const pythonResults = execute(
  "uv",
  [
    "run",
    "--quiet",
    "--project",
    "connectors/litellm",
    "python",
    "connectors/litellm/scripts/validate_fixture.py",
    "--batch",
  ],
  batchInput,
);

if (typescriptResults.length !== cases.length || pythonResults.length !== cases.length) {
  throw new Error("A batch validator returned the wrong number of results");
}

for (const [index, [contractName, fixturePath, expectedValid]] of cases.entries()) {
  const typescriptResult = typescriptResults[index];
  const pythonResult = pythonResults[index];

  if (typescriptResult.valid !== expectedValid) {
    throw new Error(
      `TypeScript produced valid=${String(typescriptResult.valid)}, expected ${String(expectedValid)} for ${contractName} fixture ${fixturePath}`,
    );
  }
  if (pythonResult.valid !== expectedValid) {
    throw new Error(
      `Python produced valid=${String(pythonResult.valid)}, expected ${String(expectedValid)} for ${contractName} fixture ${fixturePath}`,
    );
  }

  const typescriptCanonical = JSON.stringify(canonicalize(typescriptResult));
  const pythonCanonical = JSON.stringify(canonicalize(pythonResult));
  if (typescriptCanonical !== pythonCanonical) {
    throw new Error(
      `Contract parity failed for ${fixturePath}\nTypeScript: ${typescriptCanonical}\nPython: ${pythonCanonical}`,
    );
  }
}

process.stdout.write(`Contract parity passed for ${cases.length} fixtures.\n`);
