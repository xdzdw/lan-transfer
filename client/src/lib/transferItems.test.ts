import { describe, expect, it } from "vitest";
import { appendTransferItem } from "./transferItems";

describe("appendTransferItem", () => {
  it("keeps existing items first and appends the newest item at the bottom", () => {
    const existing = ["first", "second"];
    expect(appendTransferItem(existing, "latest")).toEqual([
      "first",
      "second",
      "latest",
    ]);
    expect(existing).toEqual(["first", "second"]);
  });
});
