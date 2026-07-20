# 应用接入指南

[English](integration.md)

TokenPilot 支持三种同等接入方式：Node SDK、Python SDK 和 LiteLLM Connector。它们读取同一份已发布虚拟模型策略，也使用同一种不含业务内容的用量事件。选择最贴近现有应用的方式即可，统计和 AIU 口径不会改变。

## 1. 准备应用

完成首次配置并选择应用后，保存只显示一次的应用密钥。它包含读取与确认运行配置、预留 AIU、上报 Connector 状态和上传用量所需的权限。密钥只属于一个应用，不要跨应用共用，也不要自行在事件中添加 `application_id`。

在**模型**中按下面顺序配置：

1. 新增调用连接：LiteLLM、OpenAI 兼容服务或 Anthropic。
2. 填写 `OPENAI_API_KEY` 这样的凭据引用。它只是应用本地查找名称，不是密钥值。
3. 新增真实模型。每条记录把一个连接与实际发送给该服务的模型名称绑定起来。
4. 给真实模型配置 AI Cost 和 AI Unit 单价。
5. 创建 `customer-support` 这样的虚拟模型，排列首选与备用模型，并按需添加时间或用户条件。
6. 发布。发布中心会一次返回全部校验问题。

服务商凭据只放在应用或 LiteLLM 进程中。TokenPilot 不要求上传凭据，已发布配置也不会包含凭据值。

## 2. Node SDK

```ts
import { createAiRuntimeClient, withAiContext } from "@tokenpilot/node-sdk";

const pilot = createAiRuntimeClient({
  controlPlaneUrl: process.env.TOKENPILOT_URL!,
  apiKey: process.env.TOKENPILOT_APPLICATION_KEY!,
  instanceId: "orders-node-1",
  credentials: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY!,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
  },
});

await pilot.start();

const answer = await withAiContext(
  {
    userId: "customer-42",
    displayUser: "Ada",
    applicationVersion: "orders-2026.07",
    callSource: "support_reply",
    eventProperties: { voice_enabled: false, next_action: "review" },
    userProperties: { member_level: "gold", parse_context: "support" },
  },
  () =>
    pilot.chat({
      model: "customer-support",
      messages: [{ role: "user", content: "这段内容只发给模型服务。" }],
    }),
);

console.log(answer.target.request_model);
pilot.close();
```

流式调用使用 `chatStream()`，取消请求时传入 `signal`。如果应用已经有官方 SDK Client，可以按连接 ID 注册适配器，复用已有代理、连接池和重试配置。完整说明见 [`sdks/node/README.md`](../sdks/node/README.md)。

## 3. Python SDK

```python
import os

from ai_control_sdk import AiRuntimeClient, AiRuntimeContext, ai_context

pilot = AiRuntimeClient(
    control_plane_url=os.environ["TOKENPILOT_URL"],
    api_key=os.environ["TOKENPILOT_APPLICATION_KEY"],
    instance_id="orders-python-1",
    credentials={
        "OPENAI_API_KEY": os.environ["OPENAI_API_KEY"],
        "ANTHROPIC_API_KEY": os.environ["ANTHROPIC_API_KEY"],
    },
)
pilot.start()

with ai_context(
    AiRuntimeContext(
        user_id="customer-42",
        display_user="Ada",
        application_version="orders-2026.07",
        call_source="support_reply",
        event_properties={"voice_enabled": False, "next_action": "review"},
        user_properties={"member_level": "gold", "parse_context": "support"},
    )
):
    answer = pilot.chat(
        model="customer-support",
        messages=[{"role": "user", "content": "这段内容只发给模型服务。"}],
    )

print(answer.target.request_model)
pilot.close()
```

`AsyncAiRuntimeClient` 支持异步调用和异步流。已有服务商 Client 可以包装成连接适配器。完整说明见 [`sdks/python/README.md`](../sdks/python/README.md)。

## 4. LiteLLM Connector

把 `connectors/litellm` 安装到 LiteLLM 所在的 Python 环境，并把 `deploy/litellm/ai_control_callback.py` 同时注册为通用、成功和失败 callback。

```dotenv
AI_CONTROL_URL=https://tokenpilot.example.com
AI_CONTROL_API_KEY=<应用密钥>
AI_CONTROL_POLICY_API_KEY=<同一个应用密钥>
AI_CONTROL_CONNECTOR_INSTANCE_ID=litellm-production-01
AI_CONTROL_SPOOL_PATH=/var/lib/tokenpilot/litellm-spool.sqlite3
AI_CONTROL_POLICY_LKG_PATH=/var/lib/tokenpilot/runtime-configuration.json
AI_CONTROL_POLICY_REQUIRED=true
AI_CONTROL_POLICY_POLL_INTERVAL_SECONDS=5
```

```yaml
litellm_settings:
  callbacks:
    - ai_control_callback.proxy_handler_instance
  success_callback:
    - ai_control_callback.proxy_handler_instance
  failure_callback:
    - ai_control_callback.proxy_handler_instance
```

业务代码仍然只调用虚拟模型：

```python
response = await litellm.acompletion(
    model="customer-support",
    messages=[{"role": "user", "content": prompt}],
    metadata={
        "cp": {
            "user_id": "customer-42",
            "display_user": "Ada",
            "application_version": "orders-2026.07",
            "event_properties": {"next_action": "review", "voice_enabled": False},
            "user_properties": {"member_level": "gold", "parse_context": "support"},
        }
    },
)
```

不要在 LiteLLM YAML 中再维护一套业务分流。首选模型、权重、条件和备用顺序都由 TokenPilot 管理；只有选中 LiteLLM 连接时，Connector 才把真实模型的 `request_model` 转换为 LiteLLM 模型名。

请持久化本地缓冲和最后可用配置目录。无效更新会被原子拒绝，上一份有效策略继续工作。使用 `AI_CONTROL_POLICY_REQUIRED=true` 时，当前配置和未过期的最后可用配置都不存在才会拒绝请求。

## 用户与自定义字段

每次模型操作都必须包含 `user_id`，推荐同时提供 `display_user`。首个有效事件会在当前应用自动新增用户，后续事件可以更新显示名称和类型化用户属性。

自定义字段需要先在**设置 → 字段**中定义。事件字段描述一次操作，例如 `voice_enabled`、`next_action`；用户字段描述应用用户，例如 `member_level`、`parse_context`。可分析类型包括文本、数字、是/否、时间、枚举和文本列表。未声明或类型不正确的字段会按应用策略拒绝或丢弃；可能承载提示词、回复或凭据的保留字段始终拒绝。

## 额度与结算

严格额度模式会在任何服务商调用前预留一个保守估算值。用户已拉闸或剩余额度不足时，不会产生模型成本。成功事件会带上预留标识和实际用量；处理链路按真实命中的模型计算最终 AIU，并把估算值校准为实际值。失败或取消会释放未使用额度。状态变更和事件重放都可以安全重试。

## 无需重新部署的配置切换

`start()` 使用 ETag 定时拉取，并且只应用签名正确、属于当前应用的配置。把 `customer-support` 从 LiteLLM 发布到已经注册的直连连接后，下一次请求就会使用新连接，虚拟模型名不变，进程也不用重启。第一次引入新服务商时，仍需先在应用中准备相应的凭据引用或 Client。

## 手动上报

暂未实现完整适配器的服务可以使用 SDK 的 `recordUsage` / `record_usage`。调用方需要提供稳定的事件与尝试标识、实际计量、虚拟模型和候选真实模型 ID。SDK 仍会校验当前应用用户、已发布路由和隐私白名单，并通过可靠缓冲上报，不能借此绕过应用隔离。
