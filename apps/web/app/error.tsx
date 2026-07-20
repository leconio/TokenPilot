"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function ErrorPage({ reset }: Readonly<{ reset: () => void }>) {
  return (
    <main className="grid min-h-screen place-items-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>页面暂时无法打开</CardTitle>
          <CardDescription>请重试；如果仍然失败，可以稍后再回来。</CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={reset}>重新加载</Button>
        </CardContent>
      </Card>
    </main>
  );
}
