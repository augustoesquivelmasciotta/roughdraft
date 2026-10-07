import { describe, expect, it } from "vitest";
import { markdownHasTable } from "../src/wide-layout";

describe("markdownHasTable", () => {
  it("detects a GFM table", () => {
    expect(markdownHasTable("| a | b |\n|---|---|\n| 1 | 2 |")).toBe(true);
  });

  it("detects a table without outer pipes and with alignment colons", () => {
    expect(markdownHasTable("a | b\n:---: | ---:\n1 | 2")).toBe(true);
  });

  it("ignores prose, lists and horizontal rules", () => {
    expect(
      markdownHasTable("# Title\n\n- item\n\ntext | with a pipe\n\n---\n"),
    ).toBe(false);
  });

  it("ignores a table that only appears inside a code fence", () => {
    expect(
      markdownHasTable("```\n| a | b |\n|---|---|\n```\n\nplain text"),
    ).toBe(false);
  });
});
