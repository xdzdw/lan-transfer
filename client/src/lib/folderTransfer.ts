export interface FolderTransferFile {
  file: File;
  /** Path relative to the selected or dropped folder. */
  relativePath: string;
}

export interface FolderSaveItem {
  blob: Blob;
  name: string;
  relativePath?: string;
}

export class FolderSaveError extends Error {
  constructor(
    public readonly code: "unsupported" | "cancelled" | "failed",
    message: string
  ) {
    super(message);
    this.name = "FolderSaveError";
  }
}

/**
 * Make a browser-provided relative path safe to use as a local folder path.
 * Paths never escape the chosen destination directory.
 */
export function normalizeRelativePath(
  path: string,
  fallbackName = "file"
): string {
  const parts = path
    .replaceAll("\\", "/")
    .split("/")
    .map(part => part.trim())
    .filter(part => part && part !== "." && part !== "..");

  return parts.join("/") || fallbackName;
}

export function getFileRelativePath(file: File): string {
  const fileWithPath = file as File & { webkitRelativePath?: string };
  return normalizeRelativePath(
    fileWithPath.webkitRelativePath || file.name,
    file.name
  );
}

export function getFolderName(files: FolderTransferFile[]): string {
  const firstPath = normalizeRelativePath(
    files[0]?.relativePath || "Folder",
    "Folder"
  );
  return firstPath.split("/")[0] || "Folder";
}

interface FileSystemFileEntryLike {
  isFile: true;
  isDirectory: false;
  name: string;
  file: (
    success: (file: File) => void,
    error?: (error: DOMException) => void
  ) => void;
}

interface FileSystemDirectoryReaderLike {
  readEntries: (
    success: (entries: FileSystemEntryLike[]) => void,
    error?: (error: DOMException) => void
  ) => void;
}

interface FileSystemDirectoryEntryLike {
  isFile: false;
  isDirectory: true;
  name: string;
  createReader: () => FileSystemDirectoryReaderLike;
}

type FileSystemEntryLike =
  | FileSystemFileEntryLike
  | FileSystemDirectoryEntryLike;
type DataTransferItemWithEntry = DataTransferItem & {
  webkitGetAsEntry?: () => FileSystemEntryLike | null;
};

function readFileEntry(
  entry: FileSystemFileEntryLike,
  relativePath: string
): Promise<FolderTransferFile> {
  return new Promise((resolve, reject) => {
    entry.file(
      file =>
        resolve({
          file,
          relativePath: normalizeRelativePath(relativePath, file.name),
        }),
      error => reject(error)
    );
  });
}

function readDirectoryEntries(
  reader: FileSystemDirectoryReaderLike
): Promise<FileSystemEntryLike[]> {
  return new Promise((resolve, reject) => {
    const entries: FileSystemEntryLike[] = [];
    const readBatch = () => {
      reader.readEntries(
        batch => {
          if (batch.length === 0) {
            resolve(entries);
            return;
          }
          entries.push(...batch);
          readBatch();
        },
        error => reject(error)
      );
    };
    readBatch();
  });
}

async function readEntry(
  entry: FileSystemEntryLike,
  parentPath = ""
): Promise<FolderTransferFile[]> {
  if (entry.isFile) {
    return [await readFileEntry(entry, `${parentPath}${entry.name}`)];
  }

  const directoryPath = `${parentPath}${entry.name}/`;
  const entries = await readDirectoryEntries(entry.createReader());
  const nested = await Promise.all(
    entries.map(child => readEntry(child, directoryPath))
  );
  return nested.flat();
}

/**
 * Reads files from a drop or clipboard operation. Chromium exposes folders as
 * webkit entries; other browsers fall back to their regular File objects.
 */
export async function readTransferItems(
  items: ReadonlyArray<DataTransferItem>
): Promise<FolderTransferFile[]> {
  const result: FolderTransferFile[] = [];

  for (const rawItem of items) {
    if (rawItem.kind !== "file") continue;

    const item = rawItem as DataTransferItemWithEntry;
    let entry: FileSystemEntryLike | null = null;
    try {
      // Native DataTransferItem methods require their original `this` binding.
      // Calling an extracted webkitGetAsEntry reference throws "Illegal invocation"
      // in Chromium and previously aborted both drag/drop and clipboard paste.
      entry = item.webkitGetAsEntry?.call(item) ?? null;
    } catch {
      entry = null;
    }
    if (entry) {
      try {
        result.push(...(await readEntry(entry)));
        continue;
      } catch {
        // Fall through to getAsFile when an entry cannot be read.
      }
    }

    const file = rawItem.getAsFile();
    if (file) result.push({ file, relativePath: getFileRelativePath(file) });
  }

  return result;
}

/**
 * Some browsers expose pasted images/files only through the asynchronous
 * Clipboard API. This is called from a user-triggered paste event, so the
 * browser may allow the read without a separate interaction.
 */
export async function readClipboardFiles(): Promise<FolderTransferFile[]> {
  if (
    typeof navigator === "undefined" ||
    !navigator.clipboard ||
    typeof navigator.clipboard.read !== "function"
  ) {
    return [];
  }

  try {
    const clipboardItems = await navigator.clipboard.read();
    const result: FolderTransferFile[] = [];
    for (const item of clipboardItems) {
      const type = item.types.find(
        candidate =>
          candidate.startsWith("image/") ||
          candidate === "application/pdf" ||
          candidate === "application/zip" ||
          candidate === "application/octet-stream"
      );
      if (!type) continue;
      const blob = await item.getType(type);
      const extension = type.split("/")[1]?.replace("jpeg", "jpg") || "bin";
      const file = new File([blob], `pasted-file.${extension}`, { type });
      result.push({ file, relativePath: file.name });
    }
    return result;
  } catch {
    // Clipboard permission or format errors should not break text pasting.
    return [];
  }
}

interface WritableFileLike {
  write: (data: Blob) => Promise<void>;
  close: () => Promise<void>;
}

interface DirectoryHandleLike {
  getDirectoryHandle: (
    name: string,
    options?: { create?: boolean }
  ) => Promise<DirectoryHandleLike>;
  getFileHandle: (
    name: string,
    options?: { create?: boolean }
  ) => Promise<{ createWritable: () => Promise<WritableFileLike> }>;
}

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options?: {
    mode?: "readwrite";
  }) => Promise<DirectoryHandleLike>;
};

function getSafePathInsideFolder(
  item: FolderSaveItem,
  folderName: string
): string {
  const rawPath = normalizeRelativePath(
    item.relativePath || item.name,
    item.name
  );
  const parts = rawPath.split("/");
  if (parts[0] === folderName) parts.shift();
  return parts.join("/") || item.name;
}

/**
 * Saves all received files into a user-selected directory. The browser asks
 * for this permission only after the user presses the Save folder button.
 */
export async function saveFolderToDirectory(
  items: FolderSaveItem[],
  folderName: string
): Promise<void> {
  const pickerWindow = globalThis as unknown as DirectoryPickerWindow;
  const picker = pickerWindow.showDirectoryPicker;
  if (!picker) {
    throw new FolderSaveError(
      "unsupported",
      "Directory saving is not supported in this browser"
    );
  }

  let destination: DirectoryHandleLike;
  try {
    destination = await picker.call(pickerWindow, { mode: "readwrite" });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new FolderSaveError("cancelled", "Folder saving was cancelled");
    }
    throw new FolderSaveError(
      "failed",
      "Could not choose a destination folder"
    );
  }

  try {
    const safeFolderName = normalizeRelativePath(
      folderName,
      "Transferred folder"
    ).split("/")[0];
    const folder = await destination.getDirectoryHandle(safeFolderName, {
      create: true,
    });

    for (const item of items) {
      const path = getSafePathInsideFolder(item, safeFolderName);
      const parts = path.split("/");
      const fileName = parts.pop() || item.name;
      let directory = folder;
      for (const part of parts) {
        directory = await directory.getDirectoryHandle(part, { create: true });
      }
      const fileHandle = await directory.getFileHandle(fileName, {
        create: true,
      });
      const writable = await fileHandle.createWritable();
      await writable.write(item.blob);
      await writable.close();
    }
  } catch (error) {
    if (error instanceof FolderSaveError) throw error;
    throw new FolderSaveError("failed", "Could not save the folder");
  }
}
