/**
 * File media-type detection for the git file viewer.
 *
 * Returns a discriminated union so callers can switch on the type and get
 * the correct MIME string for data URIs without any extra logic.
 */

export type FileMediaType =
  | { kind: "image"; mime: string }
  | { kind: "video"; mime: string }
  | { kind: "audio"; mime: string }
  | { kind: "svg" }
  | { kind: "markdown" }
  | { kind: "text" }
  | { kind: "binary" };

const IMAGE_EXTS: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
  ico: "image/x-icon",
  tiff: "image/tiff",
  tif: "image/tiff",
  avif: "image/avif",
};

const VIDEO_EXTS: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  ogg: "video/ogg",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
  m4v: "video/mp4",
  "3gp": "video/3gpp",
};

const AUDIO_EXTS: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  aac: "audio/aac",
  m4a: "audio/mp4",
  opus: "audio/opus",
  aiff: "audio/aiff",
  au: "audio/basic",
};

/**
 * Detect the media type of a file from its filename/extension and, when the
 * bytes are available, distinguish unknown binary files from text.
 *
 * Known media types take precedence over content sniffing so images, audio,
 * and video remain previewable. Unknown files use the same null-byte heuristic
 * as Git: a null byte in the first 8 KiB means the file is binary.
 */
export function getFileMediaType(
  filename: string,
  bytes?: Uint8Array,
): FileMediaType | null {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (!ext) return null;

  if (ext === "svg") return { kind: "svg" };
  if (ext === "md" || ext === "markdown") return { kind: "markdown" };

  const imageMime = IMAGE_EXTS[ext];
  if (imageMime) return { kind: "image", mime: imageMime };

  const videoMime = VIDEO_EXTS[ext];
  if (videoMime) return { kind: "video", mime: videoMime };

  const audioMime = AUDIO_EXTS[ext];
  if (audioMime) return { kind: "audio", mime: audioMime };

  if (bytes && isBinaryContent(bytes)) return { kind: "binary" };

  return null;
}

/** Return whether Git would treat these bytes as binary content. */
export function isBinaryContent(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 8192);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

/**
 * Returns true if the file extension indicates a binary media type
 * (image, video, audio, svg) — i.e. the raw bytes should be treated as
 * binary rather than decoded as UTF-8 text.
 */
export function isBinaryMediaType(filename: string): boolean {
  const mt = getFileMediaType(filename);
  if (!mt) return false;
  return (
    mt.kind === "image" ||
    mt.kind === "video" ||
    mt.kind === "audio" ||
    mt.kind === "svg"
  );
}

/**
 * Encode raw bytes as a base64 data URI for the given MIME type.
 */
export function toDataUri(bytes: Uint8Array, mime: string): string {
  let binary = "";
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return `data:${mime};base64,${btoa(binary)}`;
}
