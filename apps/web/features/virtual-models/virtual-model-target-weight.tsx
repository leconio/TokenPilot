"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function VirtualModelTargetWeight({
  value,
  pending,
  onSave,
}: Readonly<{
  value: string;
  pending: boolean;
  onSave: (weight: number) => void;
}>) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const weight = Number(draft);
  const valid = Number.isFinite(weight) && weight > 0 && weight <= 1_000;
  return (
    <div className="flex items-center gap-2">
      <Input
        aria-label="流量权重"
        className="w-24"
        inputMode="decimal"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <Button
        disabled={!valid || pending || String(weight) === String(Number(value))}
        size="sm"
        type="button"
        variant="outline"
        onClick={() => onSave(weight)}
      >
        保存权重
      </Button>
    </div>
  );
}
