#!/usr/bin/env node

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeBase32(value, length) {
  let remaining = BigInt(value);
  let result = "";
  for (let index = 0; index < length; index += 1) {
    result = alphabet[Number(remaining & 31n)] + result;
    remaining >>= 5n;
  }
  return result;
}

function deterministicUlid(instant, index, seed) {
  const timestamp = encodeBase32(BigInt(instant.getTime()), 10);
  const digest = createHash("sha256").update(`${seed}:${index}`).digest();
  let randomness = 0n;
  for (const byte of digest.subarray(0, 10)) randomness = (randomness << 8n) | BigInt(byte);
  return `${timestamp}${encodeBase32(randomness, 16)}`;
}

function parseArguments(argv) {
  const values = { count: 1, scenario: "peak", output: "-" };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === "--count" && value !== undefined) values.count = Number.parseInt(value, 10);
    else if (name === "--scenario" && value !== undefined) values.scenario = value;
    else if (name === "--output" && value !== undefined) values.output = value;
    else if (name === "--url" && value !== undefined) values.url = value;
    else if (name === "--api-key" && value !== undefined) values.apiKey = value;
    else if (name === "--seed" && value !== undefined) values.seed = value;
    else throw new Error(`Unknown or incomplete argument: ${name}`);
    index += 1;
  }
  if (!Number.isInteger(values.count) || values.count < 1 || values.count > 500) {
    throw new Error("--count must be an integer from 1 through 500");
  }
  if (!["peak", "offpeak", "fallback", "override"].includes(values.scenario)) {
    throw new Error("--scenario must be peak, offpeak, fallback, or override");
  }
  return values;
}

const scenarioDetails = {
  peak: {
    hour: 10,
    provider: "openai",
    modelTag: "fake/openai-fast",
    tag: "cp:text.fast:peak",
    rule: "peak",
    reason: "scheduled_peak",
  },
  offpeak: {
    hour: 2,
    provider: "google",
    modelTag: "fake/gemini-fast",
    tag: "cp:text.fast:offpeak",
    rule: "offpeak",
    reason: "scheduled_offpeak",
  },
  fallback: {
    hour: 10,
    provider: "azure",
    modelTag: "fake/azure-fast",
    tag: "cp:text.fast:peak",
    rule: "peak",
    reason: "provider_fallback",
    fallback: "fake/openai-fast",
  },
  override: {
    hour: 10,
    provider: "google",
    modelTag: "fake/gemini-fast",
    tag: "cp:text.fast:emergency",
    rule: "emergency-override",
    reason: "manual_override",
  },
};

function eventFor(scenario, index, seed) {
  const isPrimaryFailure = scenario === "fallback" && index % 2 === 0;
  const details = isPrimaryFailure ? scenarioDetails.peak : scenarioDetails[scenario];
  const instant = new Date(
    Date.UTC(2026, 6, 15 + Math.floor(index / 100), details.hour, index % 60),
  );
  const eventId = deterministicUlid(instant, index, seed);
  const requestIndex = scenario === "fallback" ? Math.floor(index / 2) : index;
  const requestId = `demo-${scenario}-${requestIndex.toString().padStart(4, "0")}`;
  return {
    schema_version: "2.0",
    event_id: eventId,
    event_time: instant.toISOString(),
    user: {
      user_id: `demo-user-${requestIndex % 5}`,
      display_user: `Demo user ${(requestIndex % 5) + 1}`,
    },
    source: {
      type: "gateway",
      name: "litellm-fake-demo",
      version: "1.80.0",
      instance_id: "litellm-demo-01",
    },
    request: {
      request_id: requestId,
      attempt_id: `${requestId}-attempt-${isPrimaryFailure ? "01" : scenario === "fallback" ? "02" : "01"}`,
      operation_id: `business-${requestIndex.toString().padStart(4, "0")}`,
      parent_request_id: `business-${index.toString().padStart(4, "0")}`,
      conversation_id: null,
      session_id: null,
      trace_id: `trace-${requestId}`,
    },
    model: {
      virtual_model: "text.fast",
      model_tag: details.modelTag,
      provider: details.provider,
    },
    route: {
      configuration_version: "current-demo-configuration",
      rule: details.rule,
      reason: details.reason,
      tags: [details.tag],
      fallback_from: isPrimaryFailure ? null : (details.fallback ?? null),
      is_final_success_attempt: !isPrimaryFailure,
      is_user_visible_operation: !isPrimaryFailure,
    },
    usage: {
      uncached_input_tokens: isPrimaryFailure ? "0" : "400",
      output_tokens: isPrimaryFailure ? "0" : "300",
      cache_read_input_tokens: isPrimaryFailure ? "0" : "800",
      cache_write_input_tokens: "0",
      reasoning_output_tokens: isPrimaryFailure ? "0" : "50",
      request_count: "1",
    },
    event_properties: { feature: "checklist-demo" },
    analytics_dimensions: {
      scenario,
      region: "global",
      service_tier: "standard",
    },
    result: isPrimaryFailure
      ? {
          status: "failure",
          http_status: 503,
          latency_ms: 90 + index,
          error_class: "FAKE_PRIMARY_UNAVAILABLE",
        }
      : { status: "success", http_status: 200, latency_ms: 210 + index, error_class: null },
    source_cost: isPrimaryFailure
      ? null
      : { amount: "0.001820000000000000", currency: "USD", is_estimated: false },
    privacy: { contains_prompt: false, contains_response: false },
  };
}

const options = parseArguments(process.argv.slice(2));
const seed = options.seed ?? `tokenpilot-${options.scenario}`;
const payload = {
  schema_version: "2.0",
  batch_id: `demo-batch-${createHash("sha256").update(seed).digest("hex").slice(0, 24)}`,
  sent_at: new Date(Date.UTC(2026, 6, 16, 0, 0)).toISOString(),
  events: Array.from({ length: options.count }, (_, index) =>
    eventFor(options.scenario, index, seed),
  ),
};
const serialized = `${JSON.stringify(payload, null, 2)}\n`;

if (options.output !== "-") await writeFile(options.output, serialized, { mode: 0o600 });
else if (options.url === undefined) process.stdout.write(serialized);

const endpoint = options.url ?? process.env.AI_CONTROL_URL;
if (endpoint !== undefined) {
  const apiKey = options.apiKey ?? process.env.AI_CONTROL_INGEST_API_KEY;
  if (apiKey === undefined || apiKey.length < 16) throw new Error("An ingest API key is required");
  const response = await fetch(`${endpoint.replace(/\/$/u, "")}/usage-events/batch`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.text();
  if (!response.ok) throw new Error(`Ingestion failed with ${response.status}: ${result}`);
  process.stdout.write(`${result}\n`);
}
