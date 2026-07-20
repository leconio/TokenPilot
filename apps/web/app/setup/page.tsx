"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Check, Copy, KeyRound, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiFetch, postJson } from "../../lib/api";
import { PipelineReadiness } from "@/features/setup/pipeline-readiness";
import {
  datastoreUnavailableMessage,
  requiredDatastoreHealth,
  type RequiredDatastoreHealth,
} from "@/features/shared/required-datastores";
import {
  setupSchema,
  type IssuedKey,
  type SetupForm,
  type SetupStatus,
} from "@/features/setup/model";

export default function SetupPage() {
  const router = useRouter();
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [issued, setIssued] = useState<{
    ingest: IssuedKey;
    policy: IssuedKey;
    applicationSlug: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creatingKeys, setCreatingKeys] = useState(false);
  const [storageHealth, setStorageHealth] = useState<RequiredDatastoreHealth | null>(null);
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const form = useForm<SetupForm>({
    resolver: zodResolver(setupSchema),
    defaultValues: { name: "", email: "", password: "", application_name: "" },
  });

  useEffect(() => {
    async function load() {
      let health: RequiredDatastoreHealth;
      try {
        health = requiredDatastoreHealth(await apiFetch<unknown>("/health/ready"));
      } catch {
        setStorageUnavailable(true);
        return;
      }
      if (!health.ready) {
        setStorageUnavailable(true);
        return;
      }
      setStorageHealth(health);
      try {
        const value = await apiFetch<SetupStatus>("/web/setup/status");
        if (!value.setup_required) {
          router.replace("/login");
          return;
        }
        setStatus(value);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "无法读取实例");
      }
    }
    void load();
  }, [form, router]);

  async function initialize(value: SetupForm) {
    setError(null);
    try {
      const initialized = await postJson<{ application: { slug: string } }>(
        "/web/setup/initialize",
        value,
      );
      setCreatingKeys(true);
      const keysPath = `/applications/${initialized.application.slug}/service-api-keys`;
      const [ingest, policy] = await Promise.all([
        postJson<IssuedKey>(keysPath, {
          name: "用量接入",
          scopes: ["usage:write", "connector:heartbeat"],
          reason: "首次配置创建用量接入密钥",
        }),
        postJson<IssuedKey>(keysPath, {
          name: "调用策略读取",
          scopes: ["runtime:read", "runtime:write", "runtime:ack"],
          reason: "首次配置创建调用策略读取密钥",
        }),
      ]);
      setIssued({ ingest, policy, applicationSlug: initialized.application.slug });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "初始化失败");
    } finally {
      setCreatingKeys(false);
    }
  }

  const heading = storageUnavailable
    ? "数据连接不完整"
    : storageHealth === null
      ? "正在检查数据连接"
      : status === null
        ? "正在读取配置"
        : issued === null
          ? "创建管理员"
          : "配置已完成";
  const introduction = storageUnavailable
    ? "完成两项数据连接后才能继续。"
    : storageHealth === null
      ? "确认主数据和分析数据均可用。"
      : status === null
        ? "确认当前实例是否已经完成首次配置。"
        : issued === null
          ? "创建管理员和第一个应用。"
          : "应用和接入密钥已创建。密钥只显示一次，请立即保存。";

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
            多应用 · 独立统计
          </div>
          <h1>看清模型花费和 AIU 用量，集中管理调用策略。</h1>
          <p>
            连接现有 LiteLLM。模型服务密钥始终留在你的环境中；这里负责模型配置、调用策略和用量统计。
          </p>
        </div>
        <div className="boundary-note">主数据与分析数据必须同时连接</div>
      </section>
      <section className="auth-panel">
        <div className="auth-card">
          <div className="eyebrow">首次配置</div>
          <h2>{heading}</h2>
          <p>{introduction}</p>
          {storageUnavailable ? (
            <div className="form-grid">
              <Alert variant="destructive">
                <AlertDescription>{datastoreUnavailableMessage}</AlertDescription>
              </Alert>
              <Button className="w-full" type="button" onClick={() => window.location.reload()}>
                重新检查
              </Button>
            </div>
          ) : storageHealth === null ? (
            <div className="form-grid">
              <p className="text-sm text-muted-foreground">正在检查，请稍候…</p>
            </div>
          ) : error === null ? null : (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {storageUnavailable || storageHealth === null || status === null ? null : issued ===
            null ? (
            <form className="form-grid" onSubmit={form.handleSubmit(initialize)}>
              <div className="field">
                <Label htmlFor="application_name">应用名称</Label>
                <Input id="application_name" {...form.register("application_name")} />
                <small>
                  只需填写用户能够识别的名称。{form.formState.errors.application_name?.message}
                </small>
              </div>
              <div className="form-row">
                <div className="field">
                  <Label htmlFor="name">管理员姓名</Label>
                  <Input id="name" autoComplete="name" {...form.register("name")} />
                  <small>{form.formState.errors.name?.message}</small>
                </div>
                <div className="field">
                  <Label htmlFor="email">管理员邮箱</Label>
                  <Input id="email" type="email" autoComplete="email" {...form.register("email")} />
                  <small>{form.formState.errors.email?.message}</small>
                </div>
              </div>
              <div className="field">
                <Label htmlFor="password">管理员密码</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="new-password"
                  {...form.register("password")}
                />
                <small>
                  至少 12 个字符。
                  {form.formState.errors.password?.message}
                </small>
              </div>
              <div className="note">
                <ShieldCheck size={15} style={{ verticalAlign: "text-bottom", marginRight: 7 }} />
                完成后，首次配置入口会自动关闭。
              </div>
              <Button
                className="w-full"
                type="submit"
                disabled={form.formState.isSubmitting || creatingKeys}
              >
                {form.formState.isSubmitting || creatingKeys ? "正在创建…" : "创建管理员"}
              </Button>
            </form>
          ) : (
            <div className="form-grid">
              {[
                { label: "用量接入密钥", value: issued.ingest.api_key },
                { label: "策略读取密钥", value: issued.policy.api_key },
              ].map((item) => (
                <div className="field" key={item.label}>
                  <Label>
                    <KeyRound size={14} style={{ verticalAlign: "text-bottom", marginRight: 6 }} />
                    {item.label}
                  </Label>
                  <div className="key-copy-row">
                    <Input
                      className="mono"
                      readOnly
                      value={item.value}
                      aria-label={`${item.label} key`}
                    />
                    <Button
                      size="icon"
                      variant="outline"
                      type="button"
                      aria-label={`复制 ${item.label}`}
                      onClick={() => void navigator.clipboard.writeText(item.value)}
                    >
                      <Copy size={15} />
                    </Button>
                  </div>
                </div>
              ))}
              <Alert>
                <Check />
                <AlertDescription>管理员和两枚接入密钥已创建。</AlertDescription>
              </Alert>
              <div className="note">
                <strong>1. 安装 LiteLLM 接入组件</strong>
                <pre className="code" style={{ marginTop: 10 }}>
                  uv pip install -e connectors/litellm
                </pre>
              </div>
              <div className="note">
                <strong>2. 设置接入参数</strong>
                <pre
                  className="code"
                  style={{ marginTop: 10 }}
                >{`AI_CONTROL_URL=http://api:4000\nAI_CONTROL_API_KEY=${issued.ingest.api_key}\nAI_CONTROL_POLICY_API_KEY=${issued.policy.api_key}\nAI_CONTROL_CONNECTOR_INSTANCE_ID=litellm-primary\nAI_CONTROL_SPOOL_PATH=/var/lib/tokenpilot/litellm-spool.sqlite3`}</pre>
              </div>
              <div className="note">
                <strong>3. 让 LiteLLM 上报用量</strong>
                <pre
                  className="code"
                  style={{ marginTop: 10 }}
                >{`litellm_settings:\n  callbacks: [ai_control_callback.proxy_handler_instance]\n  turn_off_message_logging: true`}</pre>
                模型服务密钥继续通过 LiteLLM 环境变量提供，不会提交到这里。
              </div>
              <Alert>
                <Check />
                <AlertDescription>
                  初始化完成。进入应用后，只需录入 LiteLLM 模型名称，再按需创建虚拟模型。
                </AlertDescription>
              </Alert>
              <PipelineReadiness status={storageHealth} />
              <Button
                className="w-full"
                type="button"
                onClick={() => router.replace(`/apps/${issued.applicationSlug}/dashboard`)}
              >
                进入应用
              </Button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
