import { expect, type Page } from "@playwright/test";

export async function expectUsableLayout(page: Page): Promise<void> {
  await expect(page.locator("body")).not.toContainText(
    /\b(?:Organization|Workspace|App Selector)\b/iu,
  );
  const dimensions = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    bodyWidth: document.body.scrollWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));
  expect
    .soft(dimensions.bodyWidth, "body must not create horizontal page scrolling")
    .toBeLessThanOrEqual(dimensions.viewportWidth + 1);
  expect
    .soft(dimensions.documentWidth, "document must not create horizontal page scrolling")
    .toBeLessThanOrEqual(dimensions.viewportWidth + 1);

  const overflowing = await page.evaluate(() =>
    [...document.body.querySelectorAll<HTMLElement>("*")]
      .map((element) => {
        const box = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          label:
            element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 40) ?? "",
          className: element.className.toString().slice(0, 120),
          left: Math.round(box.left),
          right: Math.round(box.right),
          width: Math.round(box.width),
        };
      })
      .filter((item) => item.width > 0 && (item.left < -1 || item.right > window.innerWidth + 1))
      .sort((left, right) => right.width - left.width)
      .slice(0, 8),
  );
  expect.soft(overflowing, "rendered elements must stay within the viewport").toEqual([]);

  const consoleChrome = await page.evaluate(() => {
    if (!document.querySelector(".console")) {
      return { languageControls: 0, collisions: [] as string[] };
    }

    const languageControls = [
      ...document.querySelectorAll<HTMLElement>("[data-locale-control]"),
    ].filter((element) => {
      const box = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return (
        style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0
      );
    }).length;
    const controls = [
      ...document.querySelectorAll<HTMLElement>(
        '.topbar > .mobile-application-switcher, .topbar .top-actions [data-slot="select-trigger"], .topbar .top-actions .top-logout',
      ),
    ].filter((element) => {
      const box = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return (
        style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0
      );
    });
    const collisions: string[] = [];
    for (let leftIndex = 0; leftIndex < controls.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < controls.length; rightIndex += 1) {
        const left = controls[leftIndex];
        const right = controls[rightIndex];
        if (!left || !right || left.contains(right) || right.contains(left)) continue;
        const leftBox = left.getBoundingClientRect();
        const rightBox = right.getBoundingClientRect();
        const overlapWidth =
          Math.min(leftBox.right, rightBox.right) - Math.max(leftBox.left, rightBox.left);
        const overlapHeight =
          Math.min(leftBox.bottom, rightBox.bottom) - Math.max(leftBox.top, rightBox.top);
        if (overlapWidth > 1 && overlapHeight > 1) {
          collisions.push(`${left.className.toString()} overlaps ${right.className.toString()}`);
        }
      }
    }
    return { languageControls, collisions };
  });
  if (await page.locator(".console").count()) {
    expect.soft(consoleChrome.languageControls, "console must show one language control").toBe(1);
    expect.soft(consoleChrome.collisions, "top bar controls must not overlap").toEqual([]);
  }

  const visibleControls = page.locator(
    "button:visible, a:visible, input:visible, select:visible, textarea:visible",
  );
  const count = await visibleControls.count();
  expect(count, "the page should retain an operable control at this viewport").toBeGreaterThan(0);
  for (let index = 0; index < Math.min(count, 12); index += 1) {
    const control = visibleControls.nth(index);
    const [box, description] = await Promise.all([
      control.boundingBox(),
      control.evaluate(
        (element) =>
          `${element.tagName.toLowerCase()}[aria-label="${element.getAttribute("aria-label") ?? ""}"] class="${element.className.toString().slice(0, 80)}"`,
      ),
    ]);
    if (box === null) continue;
    expect
      .soft(box.x + box.width, `visible control ${index} ${description} must fit horizontally`)
      .toBeLessThanOrEqual(dimensions.viewportWidth + 1);
    expect
      .soft(box.x, `visible control ${index} ${description} must not be clipped to the left`)
      .toBeGreaterThanOrEqual(-1);
  }
}
