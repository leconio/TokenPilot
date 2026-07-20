import type { AnalysisKind } from "./analysis-types";

export function analysisFileName(kind: AnalysisKind): string {
  const day = new Date().toISOString().slice(0, 10);
  const label = kind === "aiu" ? "aiu-用量" : kind === "cost" ? "模型花费" : "调用明细";
  return `${label}-${day}.csv`;
}

function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[\t\r\n ]*[=+\-@]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function rowsToCsv(rows: readonly Readonly<Record<string, unknown>>[]): string {
  const headers = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  if (headers.length === 0) return "";
  return [
    headers.map(csvCell).join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(",")),
  ].join("\n");
}
