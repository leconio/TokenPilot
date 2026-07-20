import type { ReactNode } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function MetricCard({
  label,
  value,
  description,
  icon,
}: Readonly<{
  label: string;
  value: string;
  description: string;
  icon?: ReactNode;
}>) {
  return (
    <Card className="h-full">
      <CardHeader className="flex-row items-center justify-between gap-3">
        <div>
          <CardDescription>{label}</CardDescription>
          <CardTitle className="mt-2 text-2xl tabular-nums">{value}</CardTitle>
        </div>
        {icon ? (
          <span className="rounded-lg bg-muted p-2 text-muted-foreground">{icon}</span>
        ) : null}
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground">{description}</CardContent>
    </Card>
  );
}
