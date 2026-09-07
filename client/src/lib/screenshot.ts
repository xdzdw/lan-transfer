export type ScreenshotCaptureErrorCode = "unsupported" | "cancelled" | "failed" | "black";
export type ScreenshotClipboardErrorCode = "unsupported" | "permission" | "failed";

export class ScreenshotClipboardError extends Error {
  readonly code: ScreenshotClipboardErrorCode;

  constructor(code: ScreenshotClipboardErrorCode, message: string) {
    super(message);
    this.name = "ScreenshotClipboardError";
    this.code = code;
  }
}

export class ScreenshotCaptureError extends Error {
  readonly code: ScreenshotCaptureErrorCode;

  constructor(code: ScreenshotCaptureErrorCode, message: string) {
    super(message);
    this.name = "ScreenshotCaptureError";
    this.code = code;
  }
}

export function isImageClipboardSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.clipboard &&
    typeof navigator.clipboard.write === "function" &&
    typeof ClipboardItem !== "undefined"
  );
}

export async function copyImageToClipboard(blob: Blob): Promise<void> {
  if (!isImageClipboardSupported()) {
    throw new ScreenshotClipboardError(
      "unsupported",
      "Image clipboard is not supported in this browser."
    );
  }

  try {
    const mimeType = blob.type || "image/png";
    await navigator.clipboard.write([
      new ClipboardItem({ [mimeType]: blob }),
    ]);
  } catch (error) {
    const name = error && typeof error === "object" && "name" in error
      ? String(error.name)
      : "";
    if (name === "NotAllowedError" || name === "SecurityError") {
      throw new ScreenshotClipboardError(
        "permission",
        "The browser denied image clipboard access."
      );
    }
    throw new ScreenshotClipboardError(
      "failed",
      "The image could not be copied to the clipboard."
    );
  }
}

export function isScreenshotCaptureSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getDisplayMedia === "function" &&
    typeof document !== "undefined"
  );
}

function isCaptureCancelled(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String(error.name) : "";
  return name === "AbortError" || name === "NotAllowedError";
}

function waitForVideoMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.videoWidth > 0 && video.videoHeight > 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      if (video.videoWidth > 0 && video.videoHeight > 0) resolve();
      else reject(new ScreenshotCaptureError("failed", "Screen dimensions are unavailable."));
    }, 3000);

    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener("loadedmetadata", handleMetadata);
      video.removeEventListener("error", handleError);
    };
    const handleMetadata = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new ScreenshotCaptureError("failed", "The selected screen could not be read."));
    };

    video.addEventListener("loadedmetadata", handleMetadata, { once: true });
    video.addEventListener("error", handleError, { once: true });
  });
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new ScreenshotCaptureError("failed", "The screenshot could not be encoded."));
      },
      "image/png",
      1
    );
  });
}

export function isLikelyBlackFrame(canvas: HTMLCanvasElement): boolean {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context || canvas.width === 0 || canvas.height === 0) return true;

  const sampleSize = 16;
  const sample = document.createElement("canvas");
  sample.width = sampleSize;
  sample.height = sampleSize;
  const sampleContext = sample.getContext("2d", { willReadFrequently: true });
  if (!sampleContext) return false;
  sampleContext.drawImage(canvas, 0, 0, sampleSize, sampleSize);
  const pixels = sampleContext.getImageData(0, 0, sampleSize, sampleSize).data;
  let litPixels = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    const luminance = pixels[index] * 0.2126 + pixels[index + 1] * 0.7152 + pixels[index + 2] * 0.0722;
    if (luminance > 8 && pixels[index + 3] > 0) litPixels += 1;
  }
  return litPixels < pixels.length / 16;
}

export function scaleCropSelection(
  selection: { x: number; y: number; width: number; height: number },
  displayed: { width: number; height: number },
  natural: { width: number; height: number },
) {
  const scaleX = natural.width / Math.max(1, displayed.width);
  const scaleY = natural.height / Math.max(1, displayed.height);
  return {
    x: selection.x * scaleX,
    y: selection.y * scaleY,
    width: selection.width * scaleX,
    height: selection.height * scaleY,
  };
}

export function cropScreenshot(source: File, crop: { x: number; y: number; width: number; height: number }): Promise<File> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(source);
    const image = new Image();
    image.onload = () => {
      try {
        const x = Math.max(0, Math.min(image.naturalWidth - 1, Math.round(crop.x)));
        const y = Math.max(0, Math.min(image.naturalHeight - 1, Math.round(crop.y)));
        const width = Math.max(1, Math.min(image.naturalWidth - x, Math.round(crop.width)));
        const height = Math.max(1, Math.min(image.naturalHeight - y, Math.round(crop.height)));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas unavailable");
        context.drawImage(image, x, y, width, height, 0, 0, width, height);
        void canvasToBlob(canvas).then((blob) => {
          resolve(new File([blob], source.name, { type: "image/png", lastModified: Date.now() }));
        }).catch(reject);
      } catch (error) {
        reject(error);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Screenshot image could not be decoded"));
    };
    image.src = url;
  });
}

/** Capture one still frame from the browser's screen-share picker as a PNG File. */
export async function captureScreenshot(): Promise<File> {
  if (!isScreenshotCaptureSupported()) {
    throw new ScreenshotCaptureError(
      "unsupported",
      "This browser does not support screen capture."
    );
  }

  let stream: MediaStream | null = null;
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;

  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: 1, max: 5 },
        cursor: "always",
        // Chromium uses these hints to avoid offering the current app tab when possible.
        selfBrowserSurface: "exclude",
        surfaceSwitching: "include",
        preferCurrentTab: false,
      } as MediaTrackConstraints & Record<string, unknown>,
      audio: false,
    });
    video.srcObject = stream;

    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new ScreenshotCaptureError("failed", "The selected screen could not be read."));
      void video.play().catch(reject);
    });
    await waitForVideoMetadata(video);

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new ScreenshotCaptureError("failed", "The screenshot canvas is unavailable.");
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    if (isLikelyBlackFrame(canvas)) {
      throw new ScreenshotCaptureError(
        "black",
        "The selected window returned a black frame."
      );
    }

    const blob = await canvasToBlob(canvas);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    return new File([blob], `screenshot-${timestamp}.png`, {
      type: "image/png",
      lastModified: Date.now(),
    });
  } catch (error) {
    if (error instanceof ScreenshotCaptureError) throw error;
    if (isCaptureCancelled(error)) {
      throw new ScreenshotCaptureError("cancelled", "Screen capture was cancelled.");
    }
    throw new ScreenshotCaptureError("failed", "The screenshot could not be captured.");
  } finally {
    stream?.getTracks().forEach((track) => track.stop());
    video.pause();
    video.srcObject = null;
  }
}
