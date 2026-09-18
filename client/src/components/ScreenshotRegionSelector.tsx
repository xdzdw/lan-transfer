import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cropScreenshot, scaleCropSelection } from "@/lib/screenshot";
import { useI18n } from "@/contexts/I18nContext";
import { Check, Loader2, Maximize2, X } from "lucide-react";

interface Point {
  x: number;
  y: number;
}

export function isValidScreenshotSelection(
  selection: { width: number; height: number } | null
) {
  return Boolean(selection && selection.width >= 8 && selection.height >= 8);
}

export interface ScreenshotSelectionState {
  start: Point | null;
  current: Point | null;
  isDragging: boolean;
}

export type ScreenshotPointerEvent =
  | { type: "down"; point: Point }
  | { type: "move"; point: Point }
  | { type: "up"; point: Point }
  | { type: "cancel" };

export const emptyScreenshotSelection: ScreenshotSelectionState = {
  start: null,
  current: null,
  isDragging: false,
};

export function reduceScreenshotSelection(
  state: ScreenshotSelectionState,
  event: ScreenshotPointerEvent
): ScreenshotSelectionState {
  if (event.type === "down") {
    return { start: event.point, current: event.point, isDragging: true };
  }
  if (event.type === "move") {
    return state.isDragging ? { ...state, current: event.point } : state;
  }
  if (event.type === "up") {
    return state.isDragging
      ? { ...state, current: event.point, isDragging: false }
      : state;
  }
  return { ...state, isDragging: false };
}

export function normalizeSelection(start: Point | null, current: Point | null) {
  if (!start || !current) return null;
  return {
    left: Math.min(start.x, current.x),
    top: Math.min(start.y, current.y),
    width: Math.abs(current.x - start.x),
    height: Math.abs(current.y - start.y),
  };
}

interface ScreenshotRegionSelectorProps {
  file: File;
  onConfirm: (file: File) => void;
  onCancel: () => void;
}

export function ScreenshotRegionSelector({
  file,
  onConfirm,
  onCancel,
}: ScreenshotRegionSelectorProps) {
  const { t } = useI18n();
  const imageRef = useRef<HTMLImageElement>(null);
  const [selectionState, setSelectionState] =
    useState<ScreenshotSelectionState>(emptyScreenshotSelection);
  const [isCropping, setIsCropping] = useState(false);
  const [isSendingFull, setIsSendingFull] = useState(false);
  const imageUrl = useMemo(() => URL.createObjectURL(file), [file]);

  useEffect(() => () => URL.revokeObjectURL(imageUrl), [imageUrl]);

  const selection = normalizeSelection(
    selectionState.start,
    selectionState.current
  );

  const getPoint = (event: React.PointerEvent<HTMLDivElement>): Point => {
    const rect = imageRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
      y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)),
    };
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = getPoint(event);
    setSelectionState(state =>
      reduceScreenshotSelection(state, { type: "down", point })
    );
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    setSelectionState(state =>
      reduceScreenshotSelection(state, { type: "move", point: getPoint(event) })
    );
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    setSelectionState(state =>
      reduceScreenshotSelection(state, { type: "up", point: getPoint(event) })
    );
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleConfirm = async () => {
    if (!isValidScreenshotSelection(selection) || !imageRef.current) return;
    const validSelection = selection!;
    const image = imageRef.current;
    setIsCropping(true);
    try {
      const cropped = await cropScreenshot(
        file,
        scaleCropSelection(
          {
            x: validSelection.left,
            y: validSelection.top,
            width: validSelection.width,
            height: validSelection.height,
          },
          { width: image.clientWidth, height: image.clientHeight },
          { width: image.naturalWidth, height: image.naturalHeight }
        )
      );
      onConfirm(cropped);
    } finally {
      setIsCropping(false);
    }
  };

  const handleSendFull = async () => {
    setIsSendingFull(true);
    try {
      await onConfirm(file);
    } finally {
      setIsSendingFull(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/75 p-4">
      <div className="flex max-h-[92vh] w-full max-w-4xl flex-col rounded-xl border border-border bg-background shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
          <div>
            <p className="text-sm font-medium">{t("selectScreenshotRegion")}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {t("selectScreenshotRegionHint")}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
            aria-label={t("cancelScreenshot")}
          >
            <X className="size-4" />
          </button>
        </div>

        <div
          className="relative flex min-h-0 flex-1 select-none items-center justify-center overflow-auto bg-black/20 p-3 touch-none"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={() =>
            setSelectionState(state =>
              reduceScreenshotSelection(state, { type: "cancel" })
            )
          }
          onLostPointerCapture={() =>
            setSelectionState(state =>
              reduceScreenshotSelection(state, { type: "cancel" })
            )
          }
        >
          <img
            ref={imageRef}
            src={imageUrl}
            alt={t("screenshotAlt")}
            className="block max-h-[68vh] max-w-full object-contain"
            draggable={false}
          />
          {selection && (
            <div
              className="pointer-events-none absolute border-2 border-primary bg-primary/10"
              style={{
                left: `calc(50% - ${(imageRef.current?.clientWidth || 0) / 2}px + ${selection.left}px)`,
                top: `calc(50% - ${(imageRef.current?.clientHeight || 0) / 2}px + ${selection.top}px)`,
                width: selection.width,
                height: selection.height,
              }}
            />
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/60 px-4 py-3">
          <Button
            type="button"
            variant="secondary"
            className="mr-auto"
            onClick={() => void handleSendFull()}
            disabled={isCropping || isSendingFull}
          >
            {isSendingFull ? (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            ) : (
              <Maximize2 className="mr-1.5 size-3.5" />
            )}
            {t("sendFullScreenshot")}
          </Button>
          <Button type="button" variant="outline" onClick={onCancel}>
            {t("cancelScreenshot")}
          </Button>
          <Button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={!isValidScreenshotSelection(selection) || isCropping}
          >
            {isCropping ? (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            ) : (
              <Check className="mr-1.5 size-3.5" />
            )}
            {t("useSelectedRegion")}
          </Button>
        </div>
      </div>
    </div>
  );
}
