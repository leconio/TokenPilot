"use client";

import { ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLocale } from "@/i18n/locale-provider";
import { CustomRateFields } from "./custom-rate-fields";
import type { EditableRates, RateField } from "./types";

const extraFields: readonly { key: RateField; label: string }[] = [
  { key: "cache_read_per_million", label: "缓存读取（每百万 Token）" },
  { key: "cache_write_per_million", label: "缓存写入（每百万 Token）" },
  { key: "reasoning_per_million", label: "推理输出（每百万 Token）" },
  { key: "embedding_per_million", label: "向量输入（每百万 Token）" },
  { key: "input_image", label: "输入图片（每张）" },
  { key: "output_image", label: "输出图片（每张）" },
  { key: "input_audio_second", label: "输入语音（每秒）" },
  { key: "output_audio_second", label: "输出语音（每秒）" },
  { key: "input_video_second", label: "输入视频（每秒）" },
  { key: "output_video_second", label: "输出视频（每秒）" },
  { key: "unknown_unit", label: "其他用量（每单位）" },
];

function Field({
  field,
  label,
  prefix,
  value,
  onChange,
}: Readonly<{
  field: RateField;
  label: string;
  prefix: string;
  value: string;
  onChange: (field: RateField, value: string) => void;
}>) {
  const id = `${prefix}-${field}`;
  return (
    <div className="field">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        inputMode="decimal"
        min="0"
        placeholder="0"
        step="any"
        type="number"
        value={value}
        onChange={(event) => onChange(field, event.target.value)}
      />
    </div>
  );
}

export function ModelRateCard({
  kind,
  version,
  currency,
  values,
  saving,
  error,
  onChange,
  onCustomUnitsChange,
  onSave,
}: Readonly<{
  kind: "cost" | "aiu";
  version: number | null;
  currency?: string | undefined;
  values: Readonly<EditableRates>;
  saving: boolean;
  error?: string | undefined;
  onChange: (field: RateField, value: string) => void;
  onCustomUnitsChange: (values: EditableRates["custom_units"]) => void;
  onSave: () => void;
}>) {
  const cost = kind === "cost";
  const { text } = useLocale();
  const prefix = cost ? "cost" : "aiu";
  return (
    <Card>
      <CardHeader>
        <CardTitle>{cost ? "模型花费" : "AIU 单价"}</CardTitle>
        <CardDescription>
          {cost
            ? text(
                `记录服务商价格${currency ? `，币种为 ${currency}` : ""}。`,
                `Record provider rates${currency ? ` in ${currency}` : ""}.`,
              )
            : "定义每种用量折算成多少 AIU。"}
        </CardDescription>
        {version === null ? null : (
          <CardAction>{text(`版本 ${version}`, `Version ${version}`)}</CardAction>
        )}
      </CardHeader>
      <CardContent className="form-grid">
        {cost ? (
          <Field
            field="request"
            label="每次请求"
            prefix={prefix}
            value={values.request}
            onChange={onChange}
          />
        ) : null}
        <Field
          field="input_per_million"
          label="输入（每百万 Token）"
          prefix={prefix}
          value={values.input_per_million}
          onChange={onChange}
        />
        <Field
          field="output_per_million"
          label="输出（每百万 Token）"
          prefix={prefix}
          value={values.output_per_million}
          onChange={onChange}
        />
        <Collapsible className="md:col-span-2">
          <CollapsibleTrigger asChild>
            <Button size="sm" type="button" variant="ghost">
              更多设置 <ChevronDown />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="form-grid pt-3">
            {extraFields.map((item) => (
              <Field
                field={item.key}
                key={item.key}
                label={item.label}
                prefix={prefix}
                value={values[item.key]}
                onChange={onChange}
              />
            ))}
            <CustomRateFields
              kind={kind}
              values={values.custom_units}
              onChange={onCustomUnitsChange}
            />
          </CollapsibleContent>
        </Collapsible>
        {error ? <p className="text-sm text-destructive md:col-span-2">{error}</p> : null}
      </CardContent>
      <CardFooter className="justify-end">
        <Button disabled={saving} onClick={onSave}>
          {saving ? "正在保存…" : "保存并生效"}
        </Button>
      </CardFooter>
    </Card>
  );
}
