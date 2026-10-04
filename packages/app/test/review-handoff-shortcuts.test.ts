import { describe, expect, it } from "vitest";
import {
  getReviewHandoffShortcutLabel,
  isCommentSubmitShortcut,
  isReviewHandoffShortcut,
} from "../src/DocumentWorkspace";

const noModifiers = {
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
};

describe("review handoff shortcuts", () => {
  it("uses Cmd+D on macOS and Ctrl+D elsewhere for I'm done", () => {
    expect(
      isReviewHandoffShortcut(
        { ...noModifiers, key: "d", metaKey: true },
        "MacIntel",
      ),
    ).toBe(true);
    expect(
      isReviewHandoffShortcut(
        { ...noModifiers, key: "D", ctrlKey: true },
        "Linux x86_64",
      ),
    ).toBe(true);
    expect(getReviewHandoffShortcutLabel("MacIntel")).toBe("⌘D");
    expect(getReviewHandoffShortcutLabel("Win32")).toBe("Ctrl+D");
  });

  it("ignores other combinations so editor shortcuts keep working", () => {
    for (const event of [
      { ...noModifiers, key: "d" },
      { ...noModifiers, key: "d", ctrlKey: true },
      { ...noModifiers, key: "d", metaKey: true, shiftKey: true },
      { ...noModifiers, key: "d", metaKey: true, altKey: true },
      { ...noModifiers, key: "s", metaKey: true },
    ]) {
      expect(isReviewHandoffShortcut(event, "MacIntel")).toBe(false);
    }
  });

  it("submits a comment box with Cmd+Enter or Ctrl+Enter", () => {
    expect(
      isCommentSubmitShortcut({ key: "Enter", metaKey: true, ctrlKey: false }),
    ).toBe(true);
    expect(
      isCommentSubmitShortcut({ key: "Enter", metaKey: false, ctrlKey: true }),
    ).toBe(true);
    expect(
      isCommentSubmitShortcut({ key: "Enter", metaKey: false, ctrlKey: false }),
    ).toBe(false);
  });
});
