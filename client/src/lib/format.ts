/**
 * Format file size to human-readable string
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const size = bytes / Math.pow(k, i);
  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[i]}`;
}

/**
 * Format timestamp to time string
 */
export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Get file icon based on MIME type or extension
 */
export function getFileCategory(name: string): "image" | "video" | "audio" | "document" | "archive" | "code" | "other" {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  
  const imageExts = ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico", "tiff"];
  const videoExts = ["mp4", "webm", "avi", "mov", "mkv", "flv", "wmv"];
  const audioExts = ["mp3", "wav", "ogg", "flac", "aac", "m4a", "wma"];
  const docExts = ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "rtf", "csv"];
  const archiveExts = ["zip", "rar", "7z", "tar", "gz", "bz2"];
  const codeExts = ["js", "ts", "jsx", "tsx", "html", "css", "json", "py", "java", "cpp", "c", "go", "rs", "rb"];

  if (imageExts.includes(ext)) return "image";
  if (videoExts.includes(ext)) return "video";
  if (audioExts.includes(ext)) return "audio";
  if (docExts.includes(ext)) return "document";
  if (archiveExts.includes(ext)) return "archive";
  if (codeExts.includes(ext)) return "code";
  return "other";
}
