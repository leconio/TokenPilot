import { describe, expect, it } from "vitest";

import { friendlyApiMessage } from "../lib/api";

describe("friendly API errors", () => {
  it("keeps an intentional Chinese explanation", () => {
    expect(friendlyApiMessage(409, "配置已被其他人更新")).toBe("配置已被其他人更新");
  });

  it("replaces technical server details with a short Chinese action", () => {
    expect(friendlyApiMessage(400, "Invalid deployment request")).toBe(
      "填写内容有误，请检查后重试。",
    );
    expect(friendlyApiMessage(503, "connection refused")).toBe("服务暂时不可用，请稍后重试。");
  });
});
