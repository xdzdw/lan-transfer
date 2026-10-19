import type { TranslationKey } from "@/contexts/I18nContext";
import { formatFileSize } from "@/lib/format";
import { RELAY_MAX_FILE_BYTES } from "@shared/relayLimits";

export function formatRelayLimitHint(
  t: (key: TranslationKey) => string
): string {
  return t("relayFileSizeHint").replace(
    "{limit}",
    formatFileSize(RELAY_MAX_FILE_BYTES)
  );
}

export function getTransferErrorMessage(
  error: unknown,
  t: (key: TranslationKey) => string
): string {
  const details = error as { code?: string; maxBytes?: number } | null;
  if (details?.code === "RELAY_FILE_TOO_LARGE") {
    return t("relayFileTooLarge").replace(
      "{limit}",
      formatFileSize(details.maxBytes || RELAY_MAX_FILE_BYTES)
    );
  }
  return t("fileSendFailed");
}
