"use client";

import * as echarts from "echarts";
import { useEffect, useRef } from "react";

import { useLocale } from "@/i18n/locale-provider";

export function RequestTrendChart({
  points,
}: Readonly<{
  points: readonly { readonly bucket: string; readonly requests: number }[];
}>) {
  const element = useRef<HTMLDivElement>(null);
  const { locale, text } = useLocale();
  const seriesName = text("调用次数", "Calls");
  const accessibleName = text("所选时间范围内的调用趋势", "Call trend for the selected time range");

  useEffect(() => {
    if (element.current === null) return;
    const chart = echarts.init(element.current);
    chart.setOption({
      animation: false,
      grid: { left: 42, right: 12, top: 16, bottom: 34 },
      tooltip: {
        trigger: "axis",
        valueFormatter: (value: unknown) =>
          locale === "zh-CN" ? `${String(value)} 次调用` : `${String(value)} calls`,
      },
      xAxis: {
        type: "category",
        boundaryGap: false,
        data: points.map((point) => point.bucket),
        axisLabel: { hideOverlap: true, formatter: (value: string) => value.slice(5, 16) },
      },
      yAxis: { type: "value", minInterval: 1 },
      series: [
        {
          name: seriesName,
          type: "line",
          smooth: true,
          showSymbol: points.length < 16,
          areaStyle: { opacity: 0.12 },
          lineStyle: { width: 2 },
          data: points.map((point) => point.requests),
        },
      ],
    });
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(element.current);
    return () => {
      observer.disconnect();
      chart.dispose();
    };
  }, [locale, points, seriesName]);

  return <div aria-label={accessibleName} className="h-64 w-full" ref={element} role="img" />;
}
