import { z } from "zod";

export const setupSchema = z.object({
  name: z.string().min(1, "请输入管理员姓名"),
  email: z.string().email("请输入有效邮箱"),
  password: z.string().min(12, "密码至少 12 个字符"),
  application_name: z.string().min(1, "请输入应用名称").max(120),
});

export type SetupForm = z.infer<typeof setupSchema>;
export interface SetupStatus {
  readonly setup_required: boolean;
  readonly defaults: {
    readonly timezone: string;
    readonly base_currency: string;
  };
}
export interface IssuedKey {
  readonly id: string;
  readonly key_prefix: string;
  readonly api_key: string;
}
