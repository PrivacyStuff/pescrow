import { heliusRpcUrl } from "@/lib/helius-rpc";
import {
  RPC_PROXY_MAX_BODY_BYTES,
  allowsRpcCaller,
  declaredBodyTooLarge,
  encodeJsonRpcCalls,
  isJsonRpcContentType,
  parseJsonRpcBody,
  scrubRpcText,
  type JsonRpcId,
} from "@/lib/rpc-proxy";

const NO_STORE = { "cache-control": "no-store" } as const;
const JSON_HEADERS = { ...NO_STORE, "content-type": "application/json" } as const;
const INVALID_REQUEST = "Invalid JSON-RPC request";
const UNREACHABLE = "devnet RPC could not be reached";
const NOT_CONFIGURED = "devnet RPC is not configured";

function jsonRpcError(code: number, message: string, status: number, id: JsonRpcId | null = null): Response {
  return Response.json(
    { jsonrpc: "2.0", error: { code, message: scrubRpcText(message) }, id },
    { status, headers: NO_STORE },
  );
}

export async function POST(request: Request) {
  if (!isJsonRpcContentType(request.headers.get("content-type"))) {
    return jsonRpcError(-32700, INVALID_REQUEST, 415);
  }
  if (
    !allowsRpcCaller({
      origin: request.headers.get("origin"),
      host: request.headers.get("host"),
      secFetchSite: request.headers.get("sec-fetch-site"),
    })
  ) {
    return jsonRpcError(-32600, INVALID_REQUEST, 403);
  }
  if (declaredBodyTooLarge(request.headers.get("content-length"))) {
    return jsonRpcError(-32700, INVALID_REQUEST, 413);
  }

  let text: string;
  try {
    text = await request.text();
  } catch {
    return jsonRpcError(-32700, INVALID_REQUEST, 400);
  }
  if (Buffer.byteLength(text) > RPC_PROXY_MAX_BODY_BYTES) {
    return jsonRpcError(-32700, INVALID_REQUEST, 413);
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(text) as unknown;
  } catch {
    return jsonRpcError(-32700, INVALID_REQUEST, 400);
  }
  const parsed = parseJsonRpcBody(parsedBody);
  if (parsed === null) return jsonRpcError(-32600, INVALID_REQUEST, 400);

  let endpoint: string;
  try {
    endpoint = heliusRpcUrl();
  } catch {
    return jsonRpcError(-32603, NOT_CONFIGURED, 500);
  }

  let upstream: Response;
  try {
    upstream = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: encodeJsonRpcCalls(parsed),
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    return jsonRpcError(-32603, UNREACHABLE, 502);
  }

  let upstreamText: string;
  try {
    upstreamText = await upstream.text();
  } catch {
    return jsonRpcError(-32603, UNREACHABLE, 502);
  }
  return new Response(scrubRpcText(upstreamText), {
    status: upstream.status,
    headers: JSON_HEADERS,
  });
}
