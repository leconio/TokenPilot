# Mac 原生 LiteLLM 接入示例

这个示例在 Mac 上直接运行 Python，不使用 Docker、Podman、Lima 或 Colima。它会启动一个
OpenAI 兼容的本地假模型服务，通过真正的 LiteLLM Router 完成一次成功调用，以及一次“主模型
失败后自动改用备用模型”的调用。TokenPilot Connector 会把三个模型尝试写入本地 SQLite
缓冲并上报。

## 准备应用

在 TokenPilot 中完成以下设置：

1. 新建或选择一个应用。
2. 新建接入密钥，允许用量上报和连接状态上报。
3. 新建运行配置密钥，允许读取配置、回传状态和申请额度。
4. 新建只读验证密钥，允许读取报表和调用详情。
5. 添加 `next_action`（文本）、`voice_enabled`（是/否）两个事件字段。
6. 添加 `parse_context`（文本）、`voice_type`（文本）两个用户字段。
7. 登记 `openai/local-success`、`openai/local-primary`、`openai/local-fallback` 三个模型；如需
   验证 AIU，再录入这些模型的 AIU 换算率。

## 安装和运行

依赖只安装到本目录的 `.venv`。局域网代理可直接写进 `.env`：

```bash
cd examples/litellm-local
cp .env.example .env
uv sync --all-groups
uv run python app.py
uv run python verify_reporting.py
```

`app.py` 的终端输出只有运行标识、用户和最终备用模型，不包含密钥、Prompt 或 Response。
`verify_reporting.py` 会等待异步处理完成，再从当前应用的 ClickHouse 报表读取事件，输出应用、
事件 ID、用户、模型、AIU 和自定义字段摘要。

如需调用真实模型，把 `TOKENPILOT_USE_FAKE_PROVIDER` 改成 `false`，并通过
`LITELLM_SUCCESS_MODEL`、`LITELLM_PRIMARY_MODEL`、`LITELLM_FALLBACK_MODEL` 填写任意 LiteLLM
模型标签。OpenAI 兼容服务可以设置 `LITELLM_API_BASE` 和 `LITELLM_API_KEY`；OpenAI、Anthropic、
Gemini 等原生 Provider 直接使用 LiteLLM 对应的标准密钥变量。Provider 密钥只交给 LiteLLM，
不会保存到 TokenPilot，也不会进入上报事件。

验证脚本会先确认 PostgreSQL 已生成模型花费和 AIU 处理证据，再确认 ClickHouse 报表包含三次
模型尝试。验证密钥因此需要同时拥有 `reports:read` 和 `usage:read`。

## 测试

```bash
uv run pytest
uv run ruff check .
```
