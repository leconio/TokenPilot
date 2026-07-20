import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import ts from "typescript";

import { hasUntranslatedChinese, translateText } from "../i18n/translator";

describe("TokenPilot interface translations", () => {
  it("translates navigation and common analytics copy into English", () => {
    for (const [source, expected] of [
      ["首页", "Dashboard"],
      ["模型花费", "Model cost"],
      ["AIU 定价", "AIU pricing"],
      ["调用策略", "Routing policies"],
      ["服务连接", "Connections"],
      ["正在保存…", "Saving…"],
    ] as const) {
      const translated = translateText(source, "en");
      expect(translated).toBe(expected);
      expect(hasUntranslatedChinese(translated)).toBe(false);
    }
  });

  it("keeps the original Chinese copy in Chinese mode", () => {
    expect(translateText("模型花费", "zh-CN")).toBe("模型花费");
  });

  it("translates known phrases inside dynamic audit messages", () => {
    expect(translateText("停用虚拟模型 · fast-text", "en")).toBe(
      "Disable virtual model · fast-text",
    );
    expect(translateText("查看用户剩余 AIU", "en")).toBe("View User AIU remaining");
    expect(translateText("0 位已停止调用", "en")).toBe("0 users have stopped calls");
  });

  it("covers every static Chinese interface string in English mode", () => {
    const webRoot = fileURLToPath(new URL("../", import.meta.url));
    const uncovered = new Set<string>();
    const visitDirectory = (directory: string) => {
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        if (statSync(path).isDirectory()) {
          visitDirectory(path);
          continue;
        }
        if (!/\.(?:ts|tsx)$/u.test(name)) continue;
        const source = ts.createSourceFile(
          path,
          readFileSync(path, "utf8"),
          ts.ScriptTarget.Latest,
          true,
          name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
        );
        const visit = (node: ts.Node) => {
          const text =
            ts.isStringLiteral(node) ||
            ts.isNoSubstitutionTemplateLiteral(node) ||
            ts.isTemplateHead(node) ||
            ts.isTemplateMiddle(node) ||
            ts.isTemplateTail(node)
              ? node.text
              : ts.isJsxText(node)
                ? node.text.trim()
                : "";
          if (
            text !== "" &&
            hasUntranslatedChinese(text) &&
            hasUntranslatedChinese(translateText(text, "en"))
          ) {
            uncovered.add(text);
          }
          ts.forEachChild(node, visit);
        };
        visit(source);
      }
    };
    for (const directory of ["app", "components", "features"]) {
      visitDirectory(join(webRoot, directory));
    }
    expect([...uncovered].sort()).toEqual([]);
  });
});
