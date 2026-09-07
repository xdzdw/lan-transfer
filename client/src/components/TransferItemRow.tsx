/**
 * TransferItemRow — Displays a single transfer item (text or file)
 * 
 * Design: Swiss Utility — compact horizontal row, monospace metadata,
 * no cards, just content separated by thin borders.
 */

import React from "react";
import { Progress } from "@/components/ui/progress";
import { formatFileSize, formatTime, getFileCategory } from "@/lib/format";
import { copyImageToClipboard, ScreenshotClipboardError } from "@/lib/screenshot";
import type { TransferItem } from "@/hooks/usePeerHost";
import { useI18n } from "@/contexts/I18nContext";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  Download,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileText,
  FileVideo,
  Loader2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

function FileIcon({ name, className }: { name: string; className?: string }) {
  const category = getFileCategory(name);
  const props = { className: className || "size-4" };
  
  switch (category) {
    case "image": return <FileImage {...props} />;
    case "video": return <FileVideo {...props} />;
    case "audio": return <FileAudio {...props} />;
    case "document": return <FileText {...props} />;
    case "archive": return <FileArchive {...props} />;
    case "code": return <FileCode {...props} />;
    default: return <File {...props} />;
  }
}

interface TransferItemRowProps {
  item: TransferItem;
}

export function TransferItemRow({ item }: TransferItemRowProps) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [screenshotCopied, setScreenshotCopied] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string>();

  useEffect(() => {
    if (!item.isScreenshot || !item.blob) {
      setPreviewUrl(undefined);
      return;
    }

    const url = URL.createObjectURL(item.blob);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [item.blob, item.isScreenshot]);

  const handleCopyText = async () => {
    if (item.content) {
      await navigator.clipboard.writeText(item.content);
      setCopied(true);
      toast.success(t("copiedToClipboard"));
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleCopyScreenshot = async () => {
    if (!item.blob) return;

    try {
      await copyImageToClipboard(item.blob);
      setScreenshotCopied(true);
      toast.success(t("screenshotCopied"));
      setTimeout(() => setScreenshotCopied(false), 2000);
    } catch (error) {
      if (error instanceof ScreenshotClipboardError && error.code === "unsupported") {
        toast.error(t("screenshotCopyUnsupported"));
      } else {
        toast.error(t("screenshotCopyFailed"));
      }
    }
  };

  const handleDownload = () => {
    if (item.blob) {
      const url = URL.createObjectURL(item.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = item.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success(t("downloadStarted"));
    }
  };

  const isReceived = item.direction === "received";

  if (item.type === "text") {
    return (
      <div className="group flex items-start gap-3 py-3.5 border-b border-border/40 last:border-0">
        <div className="shrink-0 mt-0.5">
          {isReceived 
            ? <ArrowDown className="size-3 text-primary" /> 
            : <ArrowUp className="size-3 text-muted-foreground/50" />
          }
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] leading-relaxed break-words whitespace-pre-wrap text-foreground/90">
            {item.content}
          </p>
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <span className="text-[10px] font-mono text-muted-foreground/50">
              {formatTime(item.timestamp)}
            </span>
            <button
              onClick={handleCopyText}
              className="shrink-0 -mr-1 p-1.5 rounded-md hover:bg-muted active:bg-muted transition-all"
              title={t("copyToClipboard")}
            >
              {copied
                ? <Check className="size-3.5 text-primary" />
                : <Copy className="size-3.5 text-muted-foreground/60" />
              }
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (item.isScreenshot) {
    const screenshotPreviewUrl = item.previewUrl ?? previewUrl;

    return (
      <div className="group flex items-start gap-3 py-3.5 border-b border-border/40 last:border-0">
        <div className="shrink-0 mt-1">
          {isReceived
            ? <ArrowDown className="size-3 text-primary" />
            : <ArrowUp className="size-3 text-muted-foreground/50" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <span className="text-[11px] font-medium text-foreground/80">{t("screenshot")}</span>
            <span className="text-[10px] font-mono text-muted-foreground/50">{formatTime(item.timestamp)}</span>
          </div>
          {screenshotPreviewUrl ? (
            <img
              src={screenshotPreviewUrl}
              alt={t("screenshotAlt")}
              draggable={false}
              className="block max-h-64 max-w-full rounded-md border border-border/60 bg-muted/20 object-contain"
            />
          ) : (
            <div className="flex h-16 items-center gap-2 rounded-md border border-dashed border-border/70 bg-muted/20 px-3 text-[11px] text-muted-foreground/60">
              <FileImage className="size-4" />
              <span>{item.status === "transferring" ? `${item.progress || 0}%` : t("screenshot")}</span>
            </div>
          )}
          {item.status === "transferring" && (
            <div className="mt-2 flex items-center gap-2">
              <Progress value={item.progress || 0} className="h-[3px] flex-1" />
              <span className="text-[10px] font-mono text-muted-foreground/60 tabular-nums">{item.progress || 0}%</span>
            </div>
          )}
          <div className="mt-1.5 flex items-center justify-end gap-1">
            {item.status === "done" && isReceived && item.blob && (
              <>
                <button
                  onClick={handleCopyScreenshot}
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] text-primary hover:bg-muted transition-all"
                  title={t("copyScreenshot")}
                >
                  {screenshotCopied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                  <span>{screenshotCopied ? t("screenshotCopied") : t("copyScreenshot")}</span>
                </button>
                <button
                  onClick={handleDownload}
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] text-primary hover:bg-muted transition-all"
                  title={t("saveScreenshot")}
                >
                  <Download className="size-3.5" />
                  <span>{t("saveScreenshot")}</span>
                </button>
              </>
            )}
            {item.status === "done" && !isReceived && <Check className="size-3.5 text-primary/60" />}
            {item.status === "error" && <AlertTriangle className="size-3.5 text-destructive" />}
          </div>
        </div>
      </div>
    );
  }

  // File item
  return (
    <div className="group flex items-center gap-3 py-3.5 border-b border-border/40 last:border-0">
      <div className="shrink-0">
        {isReceived 
          ? <ArrowDown className="size-3 text-primary" /> 
          : <ArrowUp className="size-3 text-muted-foreground/50" />
        }
      </div>
      <div className="shrink-0 text-muted-foreground/60">
        <FileIcon name={item.name} className="size-4" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-medium truncate text-foreground/90">{item.name}</span>
          <span className="text-[10px] font-mono text-muted-foreground/50 shrink-0">
            {item.size ? formatFileSize(item.size) : ""}
          </span>
        </div>
        {item.status === "transferring" && (
          <div className="mt-2">
            <Progress value={item.progress || 0} className="h-[3px]" />
          </div>
        )}
        {item.status === "done" && (
          <span className="text-[10px] font-mono text-muted-foreground/50 mt-1 block">
            {formatTime(item.timestamp)}
          </span>
        )}
      </div>
      <div className="shrink-0">
        {item.status === "transferring" && (
          <div className="flex items-center gap-1.5">
            <Loader2 className="size-3 animate-spin text-primary" />
            <span className="text-[10px] font-mono text-muted-foreground/60 tabular-nums">{item.progress}%</span>
          </div>
        )}
        {item.status === "done" && isReceived && item.blob && (
          <div className="flex items-center gap-1">
            {item.sizeMismatch && (
              <span title="File may be incomplete">
                <AlertTriangle className="size-3 text-amber-500" />
              </span>
            )}
            <button
              onClick={handleDownload}
              className="p-1.5 rounded-md hover:bg-muted transition-all"
              title={item.sizeMismatch ? "File may be incomplete - download anyway" : t("saveFile")}
            >
              <Download className={`size-3.5 ${item.sizeMismatch ? "text-amber-500" : "text-primary"}`} />
            </button>
          </div>
        )}
        {item.status === "done" && !isReceived && (
          <Check className="size-3.5 text-primary/60" />
        )}
        {item.status === "error" && (
          <span title="Transfer failed">
            <AlertTriangle className="size-3.5 text-destructive" />
          </span>
        )}
      </div>
    </div>
  );
}
