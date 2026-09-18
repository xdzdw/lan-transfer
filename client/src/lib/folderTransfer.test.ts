import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getFolderName,
  normalizeRelativePath,
  readTransferItems,
  saveFolderToDirectory,
} from "./folderTransfer";

function makeFileItem(file: File): DataTransferItem {
  return {
    kind: "file",
    type: file.type,
    getAsFile: () => file,
    getAsString: () => undefined,
    webkitGetAsEntry: () => null,
  } as unknown as DataTransferItem;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("folder transfer helpers", () => {
  it("normalizes relative paths without allowing traversal", () => {
    expect(normalizeRelativePath("Project/../src\\main.ts")).toBe(
      "Project/src/main.ts"
    );
    expect(normalizeRelativePath("../../notes.txt", "fallback.txt")).toBe(
      "notes.txt"
    );
  });

  it("uses the first path segment as the folder name", () => {
    const files = [
      { file: new File(["a"], "a.txt"), relativePath: "Photos/a.txt" },
      { file: new File(["b"], "b.txt"), relativePath: "Photos/nested/b.txt" },
    ];
    expect(getFolderName(files)).toBe("Photos");
  });

  it("reads ordinary clipboard files when no directory entry is available", async () => {
    const file = new File(["hello"], "hello.txt", { type: "text/plain" });
    const result = await readTransferItems([makeFileItem(file)]);
    expect(result).toEqual([{ file, relativePath: "hello.txt" }]);
  });

  it("recursively reads a dropped directory and preserves relative paths", async () => {
    const topFile = new File(["top"], "top.txt");
    const nestedFile = new File(["nested"], "nested.txt");
    const fileEntry = (name: string, file: File) => ({
      isFile: true,
      isDirectory: false,
      name,
      file: (success: (file: File) => void) => success(file),
    });
    const nestedDirectory = {
      isFile: false,
      isDirectory: true,
      name: "nested",
      createReader: () => {
        let read = false;
        return {
          readEntries: (success: (entries: unknown[]) => void) => {
            const batch = read ? [] : [fileEntry("nested.txt", nestedFile)];
            read = true;
            success(batch);
          },
        };
      },
    };
    const rootDirectory = {
      isFile: false,
      isDirectory: true,
      name: "Photos",
      createReader: () => {
        let read = false;
        return {
          readEntries: (success: (entries: unknown[]) => void) => {
            const batch = read
              ? []
              : [fileEntry("top.txt", topFile), nestedDirectory];
            read = true;
            success(batch);
          },
        };
      },
    };
    const item = {
      kind: "file",
      getAsFile: () => null,
      webkitGetAsEntry: () => rootDirectory,
    } as unknown as DataTransferItem;

    const result = await readTransferItems([item]);

    expect(result.map(entry => entry.relativePath)).toEqual([
      "Photos/top.txt",
      "Photos/nested/nested.txt",
    ]);
  });

  it("writes a received folder into nested local directories", async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const makeDirectory = (prefix: string) => ({
      getDirectoryHandle: vi.fn(async (name: string) =>
        makeDirectory(`${prefix}/${name}`)
      ),
      getFileHandle: vi.fn(async (name: string) => ({
        createWritable: vi.fn(async () => ({
          write: vi.fn(async (blob: Blob) =>
            writes.push({
              path: `${prefix}/${name}`,
              content: await blob.text(),
            })
          ),
          close: vi.fn(async () => undefined),
        })),
      })),
    });

    const picker = vi.fn(async () => makeDirectory("destination"));
    Object.defineProperty(globalThis, "showDirectoryPicker", {
      configurable: true,
      value: picker,
    });

    await saveFolderToDirectory(
      [
        {
          blob: new Blob(["one"]),
          name: "one.txt",
          relativePath: "Photos/one.txt",
        },
        {
          blob: new Blob(["two"]),
          name: "two.txt",
          relativePath: "Photos/nested/two.txt",
        },
      ],
      "Photos"
    );

    expect(picker).toHaveBeenCalledWith({ mode: "readwrite" });
    expect(writes).toEqual([
      { path: "destination/Photos/one.txt", content: "one" },
      { path: "destination/Photos/nested/two.txt", content: "two" },
    ]);
  });
});
