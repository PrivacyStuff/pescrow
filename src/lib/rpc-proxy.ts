export const RPC_PROXY_MAX_BODY_BYTES = 262_144;
export const RPC_PROXY_MAX_BATCH = 16;
export const RPC_PROXY_MAX_METHOD_LENGTH = 64;
export const RPC_PROXY_MAX_ID_LENGTH = 128;

const JSON_MIME = "application/json";
const JSON_RPC_VERSION = "2.0";
const METHOD_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
const API_KEY_PATTERN = /api-key(?:=|%3[Dd])[^&\s"#]+/g;

export type JsonRpcId = string | number;

export type JsonRpcRequest = {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: readonly unknown[] | Readonly<Record<string, unknown>>;
};

export type ParsedJsonRpc = {
  readonly calls: readonly JsonRpcRequest[];
  readonly batched: boolean;
};

export function isJsonRpcContentType(header: string | null): boolean {
  if (header === null) return false;
  const media = header.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return media === JSON_MIME;
}

export function declaredBodyTooLarge(header: string | null): boolean {
  if (header === null) return false;
  const size = Number(header);
  return !Number.isSafeInteger(size) || size < 0 || size > RPC_PROXY_MAX_BODY_BYTES;
}

export function allowsRpcCaller(input: {
  origin: string | null;
  host: string | null;
  secFetchSite: string | null;
}): boolean {
  if (input.secFetchSite === "cross-site") return false;
  if (input.origin === null || input.origin.length === 0) return true;
  if (input.host === null || input.host.length === 0) return false;
  try {
    return new URL(input.origin).host === input.host;
  } catch {
    return false;
  }
}

export function scrubRpcText(text: string): string {
  return text.replace(API_KEY_PATTERN, (match) => (match.includes("%") ? "api-key%3DREDACTED" : "api-key=REDACTED"));
}

export function parseJsonRpcBody(body: unknown): ParsedJsonRpc | null {
  if (Array.isArray(body)) {
    if (body.length === 0 || body.length > RPC_PROXY_MAX_BATCH) return null;
    const calls: JsonRpcRequest[] = [];
    for (const entry of body) {
      const call = parseCall(entry);
      if (call === null) return null;
      calls.push(call);
    }
    return { calls, batched: true };
  }
  const call = parseCall(body);
  if (call === null) return null;
  return { calls: [call], batched: false };
}

export function encodeJsonRpcCalls(parsed: ParsedJsonRpc): string {
  const payload = parsed.batched ? parsed.calls : parsed.calls[0];
  return JSON.stringify(payload);
}

function parseCall(value: unknown): JsonRpcRequest | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.jsonrpc !== JSON_RPC_VERSION) return null;
  if (!isMethod(record.method)) return null;
  if (!isId(record.id)) return null;
  const call: JsonRpcRequest = { jsonrpc: "2.0", id: record.id, method: record.method };
  if (!("params" in record) || record.params === undefined) return call;
  if (!isParams(record.params)) return null;
  return { ...call, params: record.params };
}

function isMethod(value: unknown): value is string {
  return typeof value === "string" && value.length <= RPC_PROXY_MAX_METHOD_LENGTH && METHOD_PATTERN.test(value);
}

function isId(value: unknown): value is JsonRpcId {
  if (typeof value === "number") return Number.isSafeInteger(value);
  return typeof value === "string" && value.length > 0 && value.length <= RPC_PROXY_MAX_ID_LENGTH;
}

function isParams(value: unknown): value is readonly unknown[] | Readonly<Record<string, unknown>> {
  if (Array.isArray(value)) return true;
  return value !== null && typeof value === "object";
}
