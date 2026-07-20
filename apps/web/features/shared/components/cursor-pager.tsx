"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";

export function CursorPager({
  page,
  hasNext,
  onPrevious,
  onNext,
}: Readonly<{
  page: number;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
}>) {
  return (
    <div className="flex items-center justify-end gap-2">
      <span className="text-sm text-muted-foreground">第 {page} 页</span>
      <Button
        aria-label="上一页"
        disabled={page <= 1}
        size="icon-sm"
        variant="outline"
        onClick={onPrevious}
      >
        <ChevronLeft />
      </Button>
      <Button
        aria-label="下一页"
        disabled={!hasNext}
        size="icon-sm"
        variant="outline"
        onClick={onNext}
      >
        <ChevronRight />
      </Button>
    </div>
  );
}
