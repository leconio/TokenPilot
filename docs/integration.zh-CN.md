# LiteLLM 与 SDK 接入

[English](integration.md)

TokenPilot 接收用量并下发绑定应用的运行配置。LiteLLM 仍然是模型网关，也是唯一需要服务商密钥的地方。TokenPilot 不接收提示词、模型回复、工具参数或服务商密钥。

## 应用密钥

在目标应用的**设置**页面创建密钥，并按用途分开：

- 用量上传和 Connector 心跳；
- 运行快照、应用结果回传和 AIU 预留；
- 统计验证或管理操作。

密钥决定应用身份。不要在事件中添加 `application_id`，也不要让多个应用共用密钥。

## 安装 Connector

把 `connectors/litellm` 安装到 LiteLLM 所在 Python 环境，并把 `deploy/litellm/ai_control_callback.py` 注册为成功与失败 callback。项目提供的部署镜像已经包含两者。

```dotenv
AI_CONTROL_URL=https://tokenpilot.example.com
AI_CONTROL_API_KEY=<应用用量密钥>
AI_CONTROL_POLICY_API_KEY=<应用运行密钥>
AI_CONTROL_CONNECTOR_INSTANCE_ID=litellm-production-01
AI_CONTROL_SPOOL_PATH=/var/lib/tokenpilot/litellm-spool.sqlite3
AI_CONTROL_POLICY_LKG_PATH=/var/lib/tokenpilot/runtime-configuration.json
AI_CONTROL_POLICY_REQUIRED=true
AI_CONTROL_BATCH_SIZE=100
AI_CONTROL_FLUSH_INTERVAL_SECONDS=1
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

通用回调用于在请求前执行分流与额度判断；明确的成功、失败回调会记录每一次真实模型尝试，包括备用模型成功的那次。

本地缓冲目录必须持久化。TokenPilot 暂时不可用时，Connector 会写入 SQLite WAL 并按上限退避重试。运行配置采用原子替换；无效更新会被拒绝，最后一份成功配置继续可用。
保存文件同时绑定快照中的 `application_id` 和运行密钥指纹。Connector 重启时会重新验证绑定并补发“已生效”回执。默认 `AI_CONTROL_POLICY_REQUIRED=true`；当前配置和未过期的最后成功配置都不可用时，请求会被拒绝。

## 上报用户和自定义字段

每次模型调用都必须提供 `user_id`，推荐同时提供 `display_user`。首个有效上报会在该应用自动新增用户，后续上报可以更新显示名称。

把 TokenPilot 上下文放在保留的 `cp` metadata 对象中：

```python
response = await litellm.acompletion(
    model="customer-support",
    messages=[{"role": "user", "content": prompt}],
    metadata={
        "cp": {
            "user_id": "customer-42",
            "display_user": "Ada",
            "app_version": "2026.07.18",
            "event_properties": {
                "next_action": "review",
                "voice_enabled": False,
            },
            "user_properties": {
                "voice_type": "standard",
                "parse_context": "support",
            },
        }
    },
)
```

这些字段需要先在当前应用的**字段**页面定义。可分析类型包括文本、数字、是/否、时间、枚举和文本列表。Connector 会校验类型和上限、移除可能携带内容的键，只上传规范化元数据和用量计数。

## 虚拟模型与分流

业务代码调用 `customer-support` 这样的虚拟模型。已发布运行快照包含真实 LiteLLM 候选、备用顺序、时间条件、用户或用户组条件、临时切换、拉闸用户和额度行为。`GET /runtime/snapshot` 支持 `ETag`，内容未变化时返回 `304`。

应用配置后，Connector 向 `/runtime/configuration-acknowledgements` 回传结果。只有当前应用的 Connector 确认完全相同的版本，Web 发布页面才显示已生效。

## 严格 AIU 额度

启用严格额度后，可信运行端使用应用运行密钥：

1. 向 `/runtime/users/aiu/reservations` 发送 `user_id`、操作标识、虚拟模型和预计微 AIU；
2. 只有 `allowed` 为真时才调用 LiteLLM；
3. 成功后按实际 AIU 结算；
4. 取消或失败时释放。

操作标识保证重试幂等。服务端把签名 token 绑定到应用和用户。缺少 `user_id` 的调用会被拒绝，不能绕过统计或额度。

## SDK 与原生示例

Node 和 Python SDK 提供类型化上下文、快照缓存、分流和运行辅助函数，代码位于 `sdks/node` 和 `sdks/python`。完整的 Mac 原生 LiteLLM 练习见 [`examples/litellm-local`](../examples/litellm-local/README.md)。依赖和模型访问可以通过 `HTTP_PROXY` 与 `HTTPS_PROXY` 使用局域网代理，不需要安装本机容器环境。
