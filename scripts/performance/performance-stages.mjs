function safeErrorType(error) {
  const candidate = error instanceof Error ? error.name : "UnknownError";
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(candidate) ? candidate : "UnknownError";
}

function safeFailureReason(error) {
  const message = error instanceof Error ? error.message : "";
  const missingSetting = /^([A-Z][A-Z0-9_]*) is required$/u.exec(message)?.[1];
  if (missingSetting !== undefined) return `required setting missing: ${missingSetting}`;
  if (/timeout|timed out|AbortError/iu.test(message)) return "operation timed out";
  if (/ECONNREFUSED|connection refused/iu.test(message)) return "dependency connection refused";
  if (/ENOTFOUND|EAI_AGAIN|name resolution/iu.test(message)) {
    return "dependency name resolution failed";
  }
  if (/authentication|authorization|unauthorized|forbidden|permission denied/iu.test(message)) {
    return "dependency authentication or authorization failed";
  }
  if (/schema|migration/iu.test(message)) return "required schema validation failed";
  if (/threshold|exceeded/iu.test(message)) return "performance threshold validation failed";
  if (message === "Performance batch was not accepted completely") {
    return "ingestion batch was not accepted completely";
  }
  if (message === "Performance model is unavailable") {
    return "published runtime model is unavailable";
  }
  const pipelineStep = /^Performance pipeline step failed: ([a-z][a-z-]{0,63})$/u.exec(
    message,
  )?.[1];
  if (pipelineStep !== undefined) return `pipeline step failed: ${pipelineStep}`;
  if (message === "Rated usage timed out") return "rated usage did not become queryable in time";
  if (message === "Performance rating did not use the actual model") {
    return "rating did not use the reported model";
  }
  const httpStatus = message.match(/(?:http )?status(?: code)?[^0-9]*([45][0-9]{2})/iu)?.[1];
  if (httpStatus !== undefined) return `dependency returned HTTP status ${httpStatus}`;
  if (/JSON|structured response|parse/iu.test(message)) return "dependency returned invalid data";
  return "stage failed; inspect the isolated stage evidence";
}

class PerformanceStageFailure extends Error {
  constructor(stage, error) {
    super(safeFailureReason(error));
    this.name = "PerformanceStageFailure";
    this.stage = stage;
    this.originalType = safeErrorType(error);
  }
}

export async function runPerformanceStage(stage, operation) {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(stage)) throw new TypeError("invalid performance stage");
  try {
    return await operation();
  } catch (error) {
    throw new PerformanceStageFailure(stage, error);
  }
}

export function performanceFailureDiagnostic(error) {
  const stage = error instanceof PerformanceStageFailure ? error.stage : "initialization";
  const type = error instanceof PerformanceStageFailure ? error.originalType : safeErrorType(error);
  const message =
    error instanceof PerformanceStageFailure ? error.message : safeFailureReason(error);
  return `Remote performance acceptance failed: stage=${stage} type=${type} message=${message}`;
}

export async function collectPerformanceStages(definitions) {
  const results = {};
  const stages = [];
  const statuses = {};
  for (const definition of definitions) {
    const blockers = (definition.blockedBy ?? []).filter(
      (dependency) => statuses[dependency] !== "PASS",
    );
    if (blockers.length > 0) {
      statuses[definition.name] = "BLOCKED";
      stages.push({
        name: definition.name,
        status: "BLOCKED",
        reason: `blocked by ${blockers.join(", ")}`,
      });
      continue;
    }
    try {
      results[definition.name] = await definition.operation(results);
      statuses[definition.name] = "PASS";
      stages.push({ name: definition.name, status: "PASS" });
    } catch (error) {
      statuses[definition.name] = "FAIL";
      stages.push({
        name: definition.name,
        status: "FAIL",
        error_type: safeErrorType(error),
        reason: safeFailureReason(error),
      });
    }
  }
  return { results, stages, statuses };
}
