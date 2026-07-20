import { analyticsTranslations } from "./dictionaries/analytics";
import { commonTranslations } from "./dictionaries/common";
import { configurationTranslations } from "./dictionaries/configuration";
import { expandedTranslationsA } from "./dictionaries/expanded-a";
import { expandedTranslationsB } from "./dictionaries/expanded-b";
import { productTranslations } from "./dictionaries/product";
import { systemTranslations } from "./dictionaries/system";
import { userQuotaTranslations } from "./dictionaries/user-quota";

export type AppLocale = "en" | "zh-CN";

const exactTranslations: Readonly<Record<string, string>> = {
  ...commonTranslations,
  ...analyticsTranslations,
  ...configurationTranslations,
  ...systemTranslations,
  ...expandedTranslationsA,
  ...expandedTranslationsB,
  ...userQuotaTranslations,
  ...productTranslations,
};

const fragments = Object.entries({
  "· 已确认 ": "· acknowledged ",
  "· 最新配置 ": "· latest configuration ",
  "· 查看详情": "· view details",
  "个 AIU 定价项。": "AIU pricing items.",
  "个 AIU 定价项": "AIU pricing items",
  "个模型花费设置。": "model cost settings.",
  "个问题，已停止发布。": "issues, so publication was stopped.",
  位用户当前额度合计: "users' current quota total",
  "创建管理员。": "create an administrator.",
  "已发布，等待模型服务确认。": "published, awaiting model service acknowledgement.",
  "条调用条件。": "call conditions.",
  "条配置变更，可按分类筛选并查看详情。":
    "configuration changes. Filter by category and open details.",
  次调用: "calls",
  "-AIU变动": "-AIU activity",
  "”，点击查询后更新结果。": "”, then click Query to refresh the results.",
  "为 ": "For ",
  "包含 ": "Includes ",
  "在网页中停用访问密钥：": "Disable an access key in the Web console:",
  "在网页中创建访问密钥：": "Create an access key in the Web console:",
  "复制 ": "Copy ",
  "将调用 ": "Will call ",
  "最近 ": "Recent ",
  查看: "View ",
  "已载入“": "Loaded “",
  "本次包含 ": "This change includes ",
  条件值: "Condition value",
  "自动检查发现 ": "Automatic checks found ",
  "退出 ": "Sign out ",
  "配置 ": "Configuration ",
  "默认候选已调整，包含 ": "The default candidate changed, with ",
  "，共 ": ", total ",
  "，包含 ": ", including ",
  " 个": " items",
  " 人": " people",
  " 位已停止调用": " users have stopped calls",
  " 天": " days",
  " 次": " calls",
  " 条": " items",
  " 项": " items",
  "正在恢复上一份已发布策略…": "Restoring the previous published policy…",
  发布中心恢复上一份调用策略: "Restore the previous routing policy from Releases",
  发布中心自动检查通过后发布: "Publish after automatic checks pass",
  从发布中心停用服务商成本: "Disable provider cost from Releases",
  "从发布中心停用 AIU 定价": "Disable AIU pricing from Releases",
  从模型页面配置模型花费: "Configure model cost from Models",
  从模型页面添加模型: "Add a model from Models",
  "从 AIU 定价页面保存模型价格": "Save model rates from AIU pricing",
  通过网页新建额度规则: "Create quota policy in the Web console",
  通过网页发布额度规则: "Publish quota policy in the Web console",
  首次配置创建用量接入密钥: "Create the initial ingest key",
  首次配置创建调用策略读取密钥: "Create the initial policy read key",
  首次配置创建模型: "Create the initial model",
  首次配置虚拟模型候选: "Configure the initial virtual model candidate",
  首次配置虚拟模型: "Create the initial virtual model",
  停用虚拟模型: "Disable virtual model",
  停用调用策略: "Disable routing policy",
  停用额度规则: "Disable quota policy",
  停用访问密钥: "Disable access key",
  停用模型识别规则: "Disable model mapping rule",
  停用用户属性定义: "Disable user attribute definition",
  启用临时调用规则: "Enable temporary routing rule",
  停用临时调用规则: "Disable temporary routing rule",
  "模型目录尚未完整载入，已停止保存以防遗漏。":
    "The model catalog is not fully loaded, so saving was stopped to prevent data loss.",
  当前模型花费设置: "Current provider cost settings",
  服务商成本: "Provider cost",
  模型花费: "Model cost",
  虚拟模型: "Virtual model",
  候选模型: "Candidate model",
  默认候选已设置: "Default candidate is set",
  尚未设置默认候选: "Default candidate is not set",
  默认候选: "Default candidate",
  调用策略: "Routing policy",
  调用顺序: "Routing order",
  临时调用规则: "temporary routing rule",
  模型识别规则: "model mapping rule",
  用户属性定义: "user attribute definition",
  服务商成本配置: "provider cost configuration",
  "AIU 定价": "AIU pricing",
  "AIU 单价": "AIU price",
  额度规则: "quota policy",
  访问密钥: "access key",
  服务连接: "connection",
  操作记录: "activity",
  暂时不可用: "temporarily unavailable",
  请稍后重试: "try again later",
  请刷新后重试: "refresh and try again",
  更多设置: "more settings",
  "每百万 Token": "per million tokens",
  "百万 Token": "million tokens",
}).sort(([left], [right]) => right.length - left.length);

const compoundTranslations = new Map<string, string>([
  ...Object.entries(exactTranslations),
  ...fragments,
]);
const compoundPattern = new RegExp(
  [...compoundTranslations.keys()]
    .sort((left, right) => right.length - left.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("|"),
  "gu",
);

const han = /[\p{Script=Han}]/u;

export function translateText(value: string, locale: AppLocale): string {
  if (locale === "zh-CN" || !han.test(value)) return value;
  const leading = value.match(/^\s*/u)?.[0] ?? "";
  const trailing = value.match(/\s*$/u)?.[0] ?? "";
  const body = value.slice(leading.length, value.length - trailing.length);
  const exact = exactTranslations[body];
  if (exact !== undefined) return `${leading}${exact}${trailing}`;
  const translated = body.replace(
    compoundPattern,
    (source) => compoundTranslations.get(source) ?? source,
  );
  return `${leading}${translated}${trailing}`;
}

export function hasUntranslatedChinese(value: string): boolean {
  return han.test(value);
}
