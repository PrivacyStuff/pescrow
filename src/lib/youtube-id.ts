const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

const YOUTUBE_HOSTS = new Set([
  "youtu.be",
  "www.youtu.be",
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

/** An 11-character YouTube id, or null when the value is not one. */
export function youtubeId(value: string | undefined | null): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (YOUTUBE_ID.test(trimmed)) return trimmed;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) return null;
  if (host === "youtu.be" || host === "www.youtu.be") {
    return idAt(url.pathname.split("/").filter(Boolean)[0]);
  }
  const fromQuery = url.searchParams.get("v");
  if (fromQuery !== null && YOUTUBE_ID.test(fromQuery)) return fromQuery;
  const parts = url.pathname.split("/").filter(Boolean);
  const marker = parts[0];
  if (marker === "embed" || marker === "shorts" || marker === "live") return idAt(parts[1]);
  return null;
}

/**
 * Query `v` wins when it is a real id or a YouTube URL. Otherwise the env id.
 * An empty or junk value leaves the frame blank.
 */
export function demoVideoId(query: string | string[] | undefined, env: string | undefined): string | null {
  const raw = Array.isArray(query) ? query[0] : query;
  return youtubeId(raw) ?? youtubeId(env);
}

function idAt(value: string | undefined): string | null {
  if (value === undefined || !YOUTUBE_ID.test(value)) return null;
  return value;
}
