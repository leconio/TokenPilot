"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { SlidersHorizontal } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiFetch, postJson } from "../../lib/api";

const schema = z.object({
  email: z.string().email("请输入有效邮箱"),
  password: z.string().min(1, "请输入密码"),
});
type LoginForm = z.infer<typeof schema>;

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<LoginForm>({
    resolver: zodResolver(schema),
    defaultValues: { email: "", password: "" },
  });
  useEffect(() => {
    void apiFetch<{ setup_required: boolean }>("/web/setup/status").then((status) => {
      if (status.setup_required) router.replace("/setup");
    });
  }, [router]);
  async function login(value: LoginForm) {
    setError(null);
    try {
      await postJson("/web/session/login", value);
      router.replace("/apps");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "登录失败");
    }
  }
  return (
    <div className="auth-page">
      <section className="auth-story">
        <div className="brand-mark">
          <span className="brand-glyph">
            <SlidersHorizontal size={17} />
          </span>
          <span>TokenPilot</span>
        </div>
        <div className="auth-story-copy">
          <div className="eyebrow" style={{ color: "var(--mint)" }}>
            管理平台
          </div>
          <h1>花费清晰，调用可控。</h1>
          <p>集中查看模型用量、模型花费、AIU、用户剩余额度和调用策略。</p>
        </div>
        <div className="boundary-note">默认不采集用户输入和模型回复正文</div>
      </section>
      <section className="auth-panel">
        <div className="auth-card">
          <div className="eyebrow">安全登录</div>
          <h2>欢迎回来</h2>
          <p>使用本实例的管理员凭据继续。</p>
          {error === null ? null : (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <form className="form-grid" onSubmit={form.handleSubmit(login)}>
            <div className="field">
              <Label htmlFor="email">邮箱</Label>
              <Input id="email" type="email" autoComplete="email" {...form.register("email")} />
              <small>{form.formState.errors.email?.message}</small>
            </div>
            <div className="field">
              <Label htmlFor="password">密码</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                {...form.register("password")}
              />
              <small>{form.formState.errors.password?.message}</small>
            </div>
            <Button className="w-full" disabled={form.formState.isSubmitting} type="submit">
              {form.formState.isSubmitting ? "正在登录…" : "登录控制台"}
            </Button>
          </form>
        </div>
      </section>
    </div>
  );
}
