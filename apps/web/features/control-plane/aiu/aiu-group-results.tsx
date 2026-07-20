import Decimal from "decimal.js";
import Link from "next/link";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PageState } from "@/features/shared/components/page-state";
import { useLocale } from "@/i18n/locale-provider";
import { translateText } from "@/i18n/translator";
import {
  analysisGroupLabel,
  type AnalysisGrain,
  type AnalysisGroup,
} from "../usage/analysis-config";
import { aiuGroupLabel, aiuTimeLabel, formatAiuMicros, type AiuGroupRow } from "./aiu-group-values";

function trendPoints(groups: readonly AiuGroupRow[]): string {
  const values = groups.map((group) => new Decimal(group.aiu_micros));
  if (values.length === 0) return "";
  const minimum = Decimal.min(new Decimal(0), ...values);
  const maximum = Decimal.max(new Decimal(0), ...values);
  const spread = maximum.minus(minimum);
  return values
    .map((value, index) => {
      const x = values.length === 1 ? 300 : 24 + (index * 552) / (values.length - 1);
      const y = spread.isZero() ? 90 : 156 - value.minus(minimum).div(spread).mul(132).toNumber();
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

function TrendChart({
  groups,
  grain,
}: Readonly<{ groups: readonly AiuGroupRow[]; grain: AnalysisGrain }>) {
  const { locale } = useLocale();
  const points = trendPoints(groups);
  return (
    <div className="grid gap-2">
      <svg
        role="img"
        aria-label="AIU 用量趋势图"
        viewBox="0 0 600 180"
        className="h-auto w-full overflow-visible rounded-lg bg-muted/20"
      >
        <title>AIU 用量趋势</title>
        {[24, 68, 112, 156].map((y) => (
          <line key={y} x1="24" x2="576" y1={y} y2={y} className="stroke-border" strokeWidth="1" />
        ))}
        <polyline
          points={points}
          fill="none"
          className="stroke-primary"
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        {points.split(" ").map((point, index) => {
          const [cx, cy] = point.split(",");
          const group = groups[index];
          return group ? (
            <circle key={`${group.key}-${index}`} cx={cx} cy={cy} r="5" className="fill-primary">
              <title>
                {aiuTimeLabel(group.key, grain, locale)}:{" "}
                {formatAiuMicros(group.aiu_micros, locale)}
              </title>
            </circle>
          ) : null;
        })}
      </svg>
      {groups.length > 0 ? (
        <div className="flex justify-between gap-3 text-xs text-muted-foreground">
          <span>{aiuTimeLabel(groups[0]!.key, grain, locale)}</span>
          <span>{aiuTimeLabel(groups.at(-1)!.key, grain, locale)}</span>
        </div>
      ) : null}
    </div>
  );
}

function TimeTable({
  groups,
  grain,
}: Readonly<{ groups: readonly AiuGroupRow[]; grain: AnalysisGrain }>) {
  const { locale } = useLocale();
  return (
    <Table aria-label="AIU 时间明细" className="table-fixed">
      <TableHeader>
        <TableRow>
          <TableHead className="w-[55%]">时间</TableHead>
          <TableHead className="w-[45%] text-right">AIU 用量</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {groups.map((group) => (
          <TableRow key={`${group.dimension}-${group.key}`}>
            <TableCell className="whitespace-normal break-words">
              {aiuTimeLabel(group.key, grain, locale)}
            </TableCell>
            <TableCell className="whitespace-normal break-words text-right tabular-nums">
              {formatAiuMicros(group.aiu_micros, locale)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function GroupRanking({
  groups,
  group,
  grain,
  userLabels,
  drillHref,
}: Readonly<{
  groups: readonly AiuGroupRow[];
  group: AnalysisGroup;
  grain: AnalysisGrain;
  userLabels: ReadonlyMap<string, string>;
  drillHref?: ((row: AiuGroupRow) => string | null) | undefined;
}>) {
  const { locale } = useLocale();
  const maximum = groups.reduce(
    (current, row) => Decimal.max(current, new Decimal(row.aiu_micros).abs()),
    new Decimal(0),
  );
  return (
    <div className="grid gap-4">
      {groups.map((row) => {
        const width = maximum.isZero()
          ? 0
          : new Decimal(row.aiu_micros).abs().div(maximum).mul(100).toNumber();
        const label = aiuGroupLabel(row, group, grain, userLabels, locale);
        const content = (
          <>
            <div className="flex min-w-0 items-center justify-between gap-3 text-sm">
              <span className="truncate" title={label} data-i18n-skip>
                {label}
              </span>
              <span className="shrink-0 font-medium tabular-nums">
                {formatAiuMicros(row.aiu_micros, locale)}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${Math.max(width, width > 0 ? 2 : 0)}%` }}
              />
            </div>
          </>
        );
        const href = drillHref?.(row) ?? null;
        return href === null ? (
          <div key={`${row.dimension}-${row.key}`} className="grid min-w-0 gap-1.5">
            {content}
          </div>
        ) : (
          <Link
            key={`${row.dimension}-${row.key}`}
            className="grid min-w-0 gap-1.5 rounded-md outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
            href={href}
          >
            {content}
          </Link>
        );
      })}
    </div>
  );
}

export function AiuGroupResults({
  groups,
  group,
  grain,
  totalGroups,
  userLabels,
  drillHref,
}: Readonly<{
  groups: readonly AiuGroupRow[];
  group: AnalysisGroup;
  grain: AnalysisGrain;
  totalGroups: number;
  userLabels: ReadonlyMap<string, string>;
  drillHref?: ((row: AiuGroupRow) => string | null) | undefined;
}>) {
  const { locale, text } = useLocale();
  const timeGroup = group.kind === "builtin" && group.dimension === "time";
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {timeGroup ? (
            text("AIU 用量趋势", "AIU usage trend")
          ) : (
            <>
              {text("按", "By ")}
              <span data-i18n-skip={group.kind === "property" ? true : undefined}>
                {group.kind === "property"
                  ? analysisGroupLabel(group)
                  : translateText(analysisGroupLabel(group), locale).toLocaleLowerCase(locale)}
              </span>
              {locale === "zh-CN" ? "查看" : ""}
            </>
          )}
        </CardTitle>
        <CardDescription>
          {text("当前结果", "Current results")} {groups.length} {text("项", "items")}
          {totalGroups > groups.length
            ? text(`，共 ${totalGroups} 项`, `, ${totalGroups} items total`)
            : ""}
          {text("。", ".")}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid min-w-0 gap-5">
        {groups.length === 0 ? (
          <PageState state="empty" message="所选条件下没有可展示的 AIU 用量。" />
        ) : timeGroup ? (
          <>
            <TrendChart groups={groups} grain={grain} />
            <TimeTable groups={groups} grain={grain} />
          </>
        ) : (
          <GroupRanking
            groups={groups}
            group={group}
            grain={grain}
            userLabels={userLabels}
            drillHref={drillHref}
          />
        )}
      </CardContent>
    </Card>
  );
}
