import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const preparation = await readFile(
  new URL("../remote/prepare-web-acceptance.mjs", import.meta.url),
  "utf8",
);
const verification = await readFile(
  new URL("../../../apps/web/e2e/real-stack-verification.ts", import.meta.url),
  "utf8",
);

test("Web-session preparation uses the same-origin control proxy", () => {
  assert.match(
    preparation,
    /const appPath = `\/api\/control\/applications\/\$\{encodeURIComponent\(applicationSlug\)\}`/u,
  );
  assert.doesNotMatch(
    preparation,
    /const appPath = `\/applications\/\$\{encodeURIComponent\(applicationSlug\)\}`/u,
  );
  assert.match(preparation, /HTTP \$\{response\.status\}, content-type \$\{contentType\}/u);
});

test("remote model pricing acceptance rates the model that actually served the request", () => {
  assert.match(preparation, /text\.fast\.demo-primary/u);
  assert.match(preparation, /text\.fast\.demo-fallback/u);
  assert.match(preparation, /driver: "litellm"/u);
  assert.match(preparation, /request_model: "text\.fast\.demo-primary"/u);
  assert.match(preparation, /connection_id: connection\.id/u);
  assert.match(preparation, /models\/\$\{model\.id\}\/cost/u);
  assert.match(preparation, /input_per_million: "1000"/u);
  assert.match(preparation, /output_per_million: "2000"/u);
  assert.match(preparation, /models\/\$\{model\.id\}\/aiu/u);
  assert.match(
    verification,
    /candidate\.request_id === target && candidate\.status === "success"/u,
  );
  assert.match(verification, /requestModel: "text\.fast\.demo-fallback"/u);
  assert.match(verification, /provider_cost_amount/u);
  assert.match(verification, /Number\(usage\.providerCostAmount\)/u);
  assert.match(verification, /BigInt\(usage\.aiuMicros/u);
});

test("remote preparation enables the routed virtual model before publication", () => {
  const enable = preparation.indexOf(
    '`${appPath}/virtual-models/${virtualModel.id}`, { enabled: true }, session, "PATCH"',
  );
  const publish = preparation.indexOf("/runtime-configurations/publish");
  assert.notEqual(enable, -1);
  assert.notEqual(publish, -1);
  assert.ok(enable < publish);
});
