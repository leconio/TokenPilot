import { ArrowUpRight } from "lucide-react";
import Link from "next/link";

import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { useLocale } from "@/i18n/locale-provider";
import { translateText } from "@/i18n/translator";

export function OverviewCard({
  label,
  value,
  detail,
  href,
}: Readonly<{ label: string; value: string; detail?: string; href?: string }>) {
  const { locale } = useLocale();
  const card = (
    <Card className="overview-card h-full transition-[border-color,box-shadow,transform] group-hover:-translate-y-0.5 group-hover:border-ring/40 group-hover:shadow-[0_12px_30px_rgb(16_40_32/0.08)] group-focus-visible:border-ring/50 group-focus-visible:ring-3 group-focus-visible:ring-ring/20">
      <CardHeader className="gap-2">
        <CardTitle className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
          {label}
          {href ? <ArrowUpRight aria-hidden="true" className="size-4 opacity-45" /> : null}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-[clamp(1.3rem,2vw,1.65rem)] font-semibold tracking-tight tabular-nums">
          {value}
        </div>
      </CardContent>
      {detail ? <CardFooter className="text-xs text-muted-foreground">{detail}</CardFooter> : null}
    </Card>
  );
  return href ? (
    <Link
      className="group block h-full rounded-xl outline-none"
      aria-label={locale === "en" ? `View ${translateText(label, locale)}` : `查看${label}`}
      href={href}
    >
      {card}
    </Link>
  ) : (
    card
  );
}
