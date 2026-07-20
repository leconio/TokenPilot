"use client";

import * as echarts from "echarts";
import { useEffect, useRef } from "react";

import { useLocale } from "@/i18n/locale-provider";

export function UserActivityChart({
  points,
}: Readonly<{ points: readonly { readonly bucket: string; readonly calls: number }[] }>) {
  const element = useRef<HTMLDivElement>(null);
  const { locale, text } = useLocale();
  const seriesName = text("调用次数", "Calls");
  useEffect(() => {
    if (element.current === null) return;
    const chart = echarts.init(element.current);
    chart.setOption({
      animation: false,
      grid: { left: 42, right: 12, top: 18, bottom: 32 },
      tooltip: {
        trigger: "axis",
        valueFormatter: (value: unknown) =>
          locale === "zh-CN" ? `${String(value)} 次` : `${String(value)} calls`,
      },
      xAxis: {
        type: "category",
        boundaryGap: false,
        data: points.map((point) => point.bucket),
        axisLabel: { hideOverlap: true, formatter: (value: string) => value.slice(5, 10) },
      },
      yAxis: { type: "value", minInterval: 1 },
      series: [
        {
          name: seriesName,
          type: "line",
          smooth: true,
          showSymbol: points.length < 16,
          areaStyle: { opacity: 0.12 },
          data: points.map((point) => point.calls),
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
  return (
    <div
      aria-label={text("用户调用趋势", "User call trend")}
      className="h-56 w-full"
      ref={element}
      role="img"
    />
  );
}
