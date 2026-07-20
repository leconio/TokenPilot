"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiFetch } from "@/lib/api";

interface ApplicationList {
  readonly applications: readonly { readonly slug: string }[];
}

export default function ApplicationsEntryPage() {
  const router = useRouter();
  const client = useQueryClient();
  const [name, setName] = useState("");
  const applications = useQuery({
    queryKey: ["applications"],
    queryFn: () => apiFetch<ApplicationList>("/applications"),
    retry: false,
  });

  useEffect(() => {
    if (applications.isError) router.replace("/login");
    const first = applications.data?.applications[0];
    if (first !== undefined) router.replace(`/apps/${first.slug}/dashboard`);
  }, [applications.data, applications.isError, router]);

  const create = useMutation({
    mutationFn: () =>
      apiFetch<{ slug: string }>("/applications", {
        method: "POST",
        body: JSON.stringify({ name: name.trim() }),
      }),
    onSuccess: async (application) => {
      await client.invalidateQueries({ queryKey: ["applications"] });
      router.replace(`/apps/${application.slug}/dashboard`);
    },
  });

  if (applications.data?.applications.length === 0) {
    return (
      <main className="grid min-h-screen place-items-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>创建第一个应用</CardTitle>
            <CardDescription>应用会分别保存自己的模型、用户和统计数据。</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="first-application-name">应用名称</Label>
              <Input
                autoFocus
                id="first-application-name"
                onChange={(event) => setName(event.target.value)}
                value={name}
              />
            </div>
            {create.error ? (
              <Alert variant="destructive">
                <AlertDescription>{create.error.message}</AlertDescription>
              </Alert>
            ) : null}
            <Button
              disabled={name.trim().length === 0 || create.isPending}
              onClick={() => create.mutate()}
            >
              {create.isPending ? "正在创建…" : "创建应用"}
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }
  return <div className="loading">正在打开应用…</div>;
}
