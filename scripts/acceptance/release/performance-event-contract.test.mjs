import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runner = await readFile(
  new URL("../../performance/remote-acceptance-runner.mjs", import.meta.url),
  "utf8",
);

test("remote performance events use the current content-free usage contract", () => {
  assert.match(runner, /conversation_id: null/u);
  assert.doesNotMatch(runner, /billing_context/u);
  assert.match(runner, /usageBatchSchema\.parse/u);
  assert.match(runner, /\.\.\/\.\.\/packages\/contracts\/dist\/index\.js/u);
  assert.doesNotMatch(runner, /import\("@tokenpilot\/contracts"\)/u);
});
