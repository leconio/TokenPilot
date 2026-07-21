"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { PageHeading } from "@/features/shared/components/page-heading";
import { PageState } from "@/features/shared/components/page-state";
import { useLocale } from "@/i18n/locale-provider";
import { controlApi } from "@/lib/api";
import { costRulesRequestBody, editableCostRules, type EditableCostRule } from "./cost-rule-values";
import { ModelInsights } from "./model-insights";
import { ModelAiuRateCard } from "./model-rate-card";
import { ModelCostRulesCard } from "./model-cost-rules-card";
import { ModelStatusControl } from "./model-status-control";
import { editableRates, emptyEditableRates, rateRequestBody } from "./rate-values";
import type { ModelDefinition, ModelRates } from "./types";

export function ModelDetailPage() {
  const { text } = useLocale();
  const match = /^\/apps\/([^/]+)\/models\/([^/]+)/u.exec(usePathname());
  const slug = match?.[1] ?? "";
  const modelId = match?.[2] ?? "";
  const path = `/applications/${slug}/models/${modelId}`;
  const client = useQueryClient();
  const [costRules, setCostRules] = useState<EditableCostRule[]>([]);
  const [aiu, setAiu] = useState(emptyEditableRates);
  const rates = useQuery({
    queryKey: ["model-rates", slug, modelId],
    queryFn: () => controlApi<ModelRates>(`${path}/rates`),
    enabled: slug.length > 0 && modelId.length > 0,
  });
  const details = useQuery({
    queryKey: ["model", slug, modelId],
    queryFn: () => controlApi<ModelDefinition>(path),
    enabled: slug.length > 0 && modelId.length > 0,
    retry: false,
  });

  useEffect(() => {
    if (rates.data === undefined) return;
    setCostRules(editableCostRules(rates.data.cost?.rules));
    setAiu(editableRates(rates.data.aiu?.rates));
  }, [rates.data]);

  const saveCostRules = useMutation({
    mutationFn: () =>
      controlApi<ModelRates>(`${path}/cost-rules`, {
        method: "PUT",
        body: JSON.stringify(costRulesRequestBody(costRules)),
      }),
    onSuccess: async () => client.invalidateQueries({ queryKey: ["model-rates", slug, modelId] }),
  });
  const saveAiu = useMutation({
    mutationFn: () =>
      controlApi<ModelRates>(`${path}/aiu`, {
        method: "PUT",
        body: JSON.stringify(rateRequestBody(aiu)),
      }),
    onSuccess: async () => client.invalidateQueries({ queryKey: ["model-rates", slug, modelId] }),
  });
  if (rates.isPending) return <PageState state="loading" />;
  if (rates.error) {
    return (
      <PageState state="error" message={rates.error.message} onRetry={() => rates.refetch()} />
    );
  }
  if (rates.data === undefined) return <PageState state="empty" />;

  return (
    <main className="page">
      <PageHeading
        title={<span data-i18n-skip>{rates.data.model.name}</span>}
        description={
          <>
            {text("模型标识：", "Model identifier: ")}
            <span data-i18n-skip>{rates.data.model.request_model}</span>
            {details.data?.connection ? (
              <>
                {text("，调用连接：", ", connection: ")}
                <span data-i18n-skip>{details.data.connection.name}</span>
              </>
            ) : null}
          </>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            {details.data === undefined ? null : (
              <ModelStatusControl applicationSlug={slug} model={details.data} />
            )}
            <Button asChild variant="outline">
              <Link href={`/apps/${slug}/models`}>
                <ArrowLeft />
                返回模型
              </Link>
            </Button>
          </div>
        }
      />
      {details.data === undefined ? null : <ModelInsights model={details.data} />}
      <div className="grid gap-4 xl:grid-cols-2">
        <ModelCostRulesCard
          version={rates.data.cost?.version ?? null}
          currency={rates.data.cost_currency}
          values={costRules}
          saving={saveCostRules.isPending}
          error={saveCostRules.error?.message}
          onChange={setCostRules}
          onSave={() => saveCostRules.mutate()}
        />
        <ModelAiuRateCard
          version={rates.data.aiu?.version ?? null}
          values={aiu}
          saving={saveAiu.isPending}
          error={saveAiu.error?.message}
          onChange={(field, value) => setAiu((current) => ({ ...current, [field]: value }))}
          onCustomUnitsChange={(custom_units) =>
            setAiu((current) => ({ ...current, custom_units }))
          }
          onSave={() => saveAiu.mutate()}
        />
      </div>
    </main>
  );
}
