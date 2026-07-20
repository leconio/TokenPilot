export function performanceModelFromSnapshot(snapshot) {
  const targets = snapshot?.routing?.["acceptance.chat"]?.default?.targets;
  const model = Array.isArray(targets)
    ? targets.find((candidate) => candidate?.request_model === "text.fast.demo-fallback")
    : undefined;
  const connection =
    typeof model?.connection_id === "string"
      ? snapshot?.connections?.[model.connection_id]
      : undefined;
  if (
    typeof model?.model_id !== "string" ||
    typeof model?.connection_id !== "string" ||
    typeof connection?.driver !== "string" ||
    typeof model?.request_model !== "string"
  ) {
    throw new Error("Performance model is unavailable");
  }
  return {
    id: model.model_id,
    connection_id: model.connection_id,
    connection_driver: connection.driver,
    request_model: model.request_model,
    provider: typeof model.provider === "string" ? model.provider : null,
  };
}
