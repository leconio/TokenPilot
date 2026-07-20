#!/usr/bin/env node

if (
  process.env.REMOTE_DOCKER_ACCEPTANCE !== "1" ||
  !/^tokenpilot-acceptance-\d{14}-\d+-[a-f0-9]{6}$/u.test(process.env.ACCEPTANCE_PROJECT ?? "")
) {
  throw new Error("An isolated remote acceptance project is required");
}
const requestId = process.env.ACCEPTANCE_CLICKHOUSE_REQUEST_ID;
const endpoint = process.env.CLICKHOUSE_URL;
const database = process.env.CLICKHOUSE_DATABASE;
const username = process.env.CLICKHOUSE_USERNAME;
const password = process.env.CLICKHOUSE_PASSWORD;
if (
  requestId === undefined ||
  !/^outage-[0-9a-hjkmnp-tv-z]{26}$/u.test(requestId) ||
  endpoint === undefined ||
  database === undefined ||
  username === undefined ||
  password === undefined ||
  password.length < 32
) {
  throw new Error("ClickHouse application query inputs are invalid");
}
const url = new URL(endpoint);
if (url.hostname !== "clickhouse" || username === "default" || /migrat/iu.test(username)) {
  throw new Error("The event check must use the isolated ClickHouse application identity");
}
url.searchParams.set("database", database);
url.searchParams.set("param_request_id", requestId);
const query =
  "SELECT toUInt64(count()) AS count FROM current_usage_events_raw " +
  "WHERE request_id={request_id:String} FORMAT JSONEachRow";
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "x-clickhouse-user": username,
      "x-clickhouse-key": password,
    },
    body: query,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`ClickHouse application query failed (${response.status})`);
  const row = JSON.parse((await response.text()).trim() || "{}");
  const rowCount = Number(row.count);
  if (Number.isSafeInteger(rowCount) && rowCount === 2) {
    process.stdout.write(
      `${JSON.stringify({
        status: "passed",
        request_id: requestId,
        current_view: "current_usage_events_raw",
        row_count: rowCount,
        identity: "application",
      })}\n`,
    );
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
throw new Error("Recovered ClickHouse current view did not contain exactly two Provider attempts");
