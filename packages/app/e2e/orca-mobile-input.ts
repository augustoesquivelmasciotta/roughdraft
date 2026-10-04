import type { Locator, Page } from "@playwright/test";

/**
 * Drives a page the way Orca mobile does, so tests can check that a review is
 * doable from a phone.
 *
 * Orca mobile shows a browser tab as a live screencast of the page running on
 * the computer and turns each gesture into input on that page:
 *
 * - A tap first looks for a control within a finger-sized radius (links,
 *   buttons, form fields, `[tabindex]`, anything with `cursor: pointer`). If it
 *   finds one and no modifier is held, it calls `focus()` and `click()` on the
 *   control instead of sending a mouse click. Otherwise it sends a real mouse
 *   click at the point, moved inside the control when one was found.
 * - The Shift/Cmd/Alt/Ctrl toggles apply to the taps that follow.
 * - Text typed on the phone arrives through `Input.insertText`.
 *
 * In Orca's "mobile" view the computer's tab is emulated at the phone's size,
 * which is what the specs set with `test.use`.
 *
 * Ported from stablyai/orca (MIT License, Copyright (c) 2026 Lovecast Inc.),
 * `src/main/browser/agent-browser-bridge-mouse.ts` and
 * `agent-browser-bridge-mouse-commands.ts` at commit 5df67ef.
 */

type Modifier = "alt" | "ctrl" | "meta" | "shift";

const MODIFIER_MASKS: Record<Modifier, number> = {
  alt: 1,
  ctrl: 2,
  meta: 4,
  shift: 8,
};

// Orca converts a 14 dip touch radius to page pixels; the mobile view has
// about one page pixel per dip.
const TOUCH_RADIUS_CSS_PX = 14;

interface TapPoint {
  x: number;
  y: number;
  handled: boolean;
}

function resolveTap({
  inputX,
  inputY,
  radius,
  allowDomActivation,
}: {
  inputX: number;
  inputY: number;
  radius: number;
  allowDomActivation: boolean;
}): TapPoint {
  const selector = [
    "a[href]",
    "button",
    "input",
    "textarea",
    "select",
    "summary",
    "label",
    '[role="button"]',
    '[role="link"]',
    '[role="menuitem"]',
    '[role="tab"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    "[onclick]",
    '[tabindex]:not([tabindex="-1"])',
  ].join(",");
  const clamp = (value: number, min: number, max: number) =>
    Math.min(max, Math.max(min, value));
  const isUsable = (element: Element) => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.pointerEvents !== "none"
    );
  };
  const clickableFor = (element: Element) => {
    for (
      let node: Element | null = element;
      node && node.nodeType === 1;
      node = node.parentElement
    ) {
      if (node.matches(selector)) return node;
      if (window.getComputedStyle(node).cursor === "pointer") return node;
    }
    return null;
  };

  const offsets: Array<[number, number]> = [[0, 0]];
  for (const distance of [radius * 0.45, radius, radius * 1.35]) {
    for (let step = 0; step < 8; step += 1) {
      const angle = (Math.PI / 4) * step;
      offsets.push([Math.cos(angle) * distance, Math.sin(angle) * distance]);
    }
  }

  let best: { score: number; x: number; y: number; target: Element } | null =
    null;
  for (const [dx, dy] of offsets) {
    const px = inputX + dx;
    const py = inputY + dy;
    if (px < 0 || py < 0 || px > window.innerWidth || py > window.innerHeight) {
      continue;
    }
    for (const element of document.elementsFromPoint(px, py)) {
      const target = clickableFor(element);
      if (!target || !isUsable(target)) continue;
      const rect = target.getBoundingClientRect();
      const clickX = clamp(inputX, rect.left + 1, rect.right - 1);
      const clickY = clamp(inputY, rect.top + 1, rect.bottom - 1);
      const score =
        Math.hypot(clickX - inputX, clickY - inputY) +
        Math.hypot(dx, dy) * 0.25;
      if (!best || score < best.score)
        best = { score, x: clickX, y: clickY, target };
      break;
    }
  }

  if (best && allowDomActivation) {
    const target = best.target as HTMLElement;
    target.focus({ preventScroll: true });
    target.click();
    return { x: best.x, y: best.y, handled: true };
  }
  return best
    ? { x: best.x, y: best.y, handled: false }
    : { x: inputX, y: inputY, handled: false };
}

export async function orcaMobile(page: Page) {
  const cdp = await page.context().newCDPSession(page);

  async function tap(
    x: number,
    y: number,
    { modifiers = [] }: { modifiers?: Modifier[] } = {},
  ) {
    const point = await page.evaluate(resolveTap, {
      inputX: x,
      inputY: y,
      radius: TOUCH_RADIUS_CSS_PX,
      allowDomActivation: modifiers.length === 0,
    });
    if (point.handled) return;

    const mask = modifiers.reduce(
      (total, modifier) => total | MODIFIER_MASKS[modifier],
      0,
    );
    for (const type of ["mousePressed", "mouseReleased"] as const) {
      await cdp.send("Input.dispatchMouseEvent", {
        type,
        x: point.x,
        y: point.y,
        button: "left",
        buttons: type === "mousePressed" ? 1 : 0,
        modifiers: mask,
        clickCount: 1,
      });
    }
  }

  return {
    tap,
    /** Taps the middle of the first line box of `locator`. */
    async tapElement(
      locator: Locator,
      options: { modifiers?: Modifier[] } = {},
    ) {
      const rect = await locator.evaluate((element) => {
        const box = element.getClientRects()[0];
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      });
      await tap(rect.x + rect.width / 2, rect.y + rect.height / 2, options);
    },
    async type(text: string) {
      await cdp.send("Input.insertText", { text });
    },
  };
}
