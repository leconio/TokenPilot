"use client";

import * as echarts from "echarts";
import { useEffect, useRef } from "react";

import { useLocale } from "@/i18n/locale-provider";

export function ActivityTrendChart({
  points,
  label,
  unit,
}: Readonly<{
  points: readonly { readonly key: string; readonly value: string | null }[];
  label: string;
  unit: "calls" | "tokens" | "users" | "percent" | "milliseconds";
}>) {
  const element = useRef<HTMLDivElement>(null);
  const { locale, text } = useLocale();
  const displayUnit =
    locale === "zh-CN"
      ? { calls: "次", tokens: "Token", users: "人", percent: "%", milliseconds: "ms" }[unit]
      : { calls: "calls", tokens: "tokens", users: "users", percent: "%", milliseconds: "ms" }[
          unit
        ];

  useEffect(() => {
    if (element.current === null) return;
    const chart = echarts.init(element.current);
    chart.setOption({
      animation: false,
      grid: { left: 48, right: 12, top: 16, bottom: 34 },
      tooltip: {
        trigger: "axis",
        valueFormatter: (value: unknown) => `${String(value)} ${displayUnit}`.trim(),
      },
      xAxis: {
        type: "category",
        boundaryGap: false,
        data: points.map((point) => point.key),
        axisLabel: { hideOverlap: true, formatter: (value: string) => value.slice(5, 16) },
      },
      yAxis: {
        type: "value",
        ...(["calls", "tokens", "users"].includes(unit) ? { minInterval: 1 } : {}),
      },
      series: [
        {
          name: label,
          type: "line",
          smooth: true,
          connectNulls: false,
          showSymbol: points.length < 16,
          areaStyle: { opacity: 0.12 },
          lineStyle: { width: 2 },
          data: points.map((point) =>
            point.value === null || !Number.isFinite(Number(point.value))
              ? null
              : Number(point.value),
          ),
        },
      ],
    });
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(element.current);
    return () => {
      observer.disconnect();
      chart.dispose();
    };
  }, [displayUnit, label, points, unit]);

  return (
    <div
      aria-label={text("所选时间范围内的指标趋势", "Metric trend for the selected time range")}
      className="h-64 w-full"
      ref={element}
      role="img"
    />
  );
}
