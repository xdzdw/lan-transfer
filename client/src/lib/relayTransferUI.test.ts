import { describe, expect, it } from "vitest";
import {
  formatRelayLimitHint,
  getTransferErrorMessage,
} from "./relayTransferUI";
import { RelayLimitError } from "@shared/relayLimits";

const translate = (key: string) =>
  ({
    relayFileSizeHint: "中继每次最多 {limit}，图片不限",
    relayFileTooLarge: "中继超限：{limit}",
    fileSendFailed: "文件发送失败",
  })[key] || key;

describe("relay limit messages", () => {
  it("shows the configured size limit in the relay hint", () => {
    expect(formatRelayLimitHint(translate)).toMatch(
      /中继每次最多 10(?:\.0)?\s?MB/
    );
    expect(formatRelayLimitHint(translate)).not.toContain("{limit}");
  });
  it("formats policy errors without exposing technical transport exceptions", () => {
    expect(getTransferErrorMessage(new RelayLimitError(), translate)).toMatch(
      /中继超限：10(?:\.0)?\s?MB/
    );
    expect(
      getTransferErrorMessage(
        { code: "RELAY_FILE_TOO_LARGE", maxBytes: 20 * 1024 * 1024 },
        translate
      )
    ).toMatch(/20(?:\.0)?\s?MB/);
    expect(getTransferErrorMessage(new Error("socket failed"), translate)).toBe(
      "文件发送失败"
    );
  });
});
