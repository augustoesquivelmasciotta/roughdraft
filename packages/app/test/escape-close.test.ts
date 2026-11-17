import { describe, expect, it } from "vitest";
import { shouldEscapeCloseReviewPanel } from "../src/escape-close";

function escapeEvent(target: HTMLElement, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

describe("shouldEscapeCloseReviewPanel", () => {
  it("closes the panel on a plain Escape", () => {
    const event = escapeEvent(document.body);
    expect(shouldEscapeCloseReviewPanel(event)).toBe(true);
  });

  it("ignores other keys", () => {
    const event = escapeEvent(document.body, { key: "Enter" });
    expect(shouldEscapeCloseReviewPanel(event)).toBe(false);
  });

  it("leaves Escape that another layer already handled", () => {
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      cancelable: true,
    });
    event.preventDefault();
    expect(shouldEscapeCloseReviewPanel(event)).toBe(false);
  });

  it("never fires from a text field, where the draft has its own Escape", () => {
    const textarea = document.createElement("textarea");
    document.body.append(textarea);
    const event = escapeEvent(textarea);
    expect(shouldEscapeCloseReviewPanel(event)).toBe(false);
    textarea.remove();
  });
});
