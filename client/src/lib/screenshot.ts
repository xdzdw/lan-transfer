export type ScreenshotCaptureErrorCode = "unsupported" | "cancelled" | "failed";

export class ScreenshotCaptureError extends Error {
  readonly code: ScreenshotCaptureErrorCode;

  constructor(code: ScreenshotCaptureErrorCode, message: string) {
    super(message);
    this.name = "ScreenshotCaptureError";
    this.code = code;
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
      video: { frameRate: 1 },
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
