export const modelCostTranslations = {
  未统计花费: "Cost unavailable",
  "优先检查上报金额、备用规则或模型名称。":
    "Check the reported amount, fallback rules, or model name first.",
  条调用还没有统计花费: "calls do not have cost yet",
  "次调用没有上报金额，也没有匹配备用规则，当前总花费不包含这些调用。":
    "calls have neither a reported amount nor a matching fallback rule and are excluded from the current total.",
  "没有上报金额或匹配规则的调用不会按 0 计算":
    "Calls without a reported amount or matching rule are never counted as zero",
  "上报金额无需配置，币种以调用记录为准。下列备用规则使用应用币种":
    "Reported amounts need no setup and retain their reported currency. Fallback rules use",
  "优先采用调用方上报的本次实际金额；未上报时，从上到下使用第一条匹配规则。这里不会影响 AIU。":
    "The reported amount is used first. When it is absent, the first matching rule below is used. AIU is not affected.",
  其他用量: "Other usage",
  删除自定义用量: "Remove custom usage",
  更多用量类型: "More usage types",
  "标识需与程序上报一致。": "The key must match the value reported by the application.",
  每个: "Each ",
  每次调用固定: "Fixed request",
  "没有备用规则时，只统计调用方上报的实际金额。":
    "With no fallback rules, only amounts reported by callers are counted.",
  "没有条件时，这是一条默认备用规则。": "With no conditions, this is the default fallback rule.",
  添加备用规则: "Add fallback rule",
  "缓存写入 Token": "Cache write token",
  "缓存读取 Token": "Cache read token",
  自定义用量: "Custom usage",
  自定义用量标识: "Custom usage key",
  自定义用量金额: "Custom usage amount",
  输入视频秒数: "Input video second",
  输入语音秒数: "Input audio second",
  输出视频秒数: "Output video second",
  输出语音秒数: "Output audio second",
  金额: " amount",
} as const;
