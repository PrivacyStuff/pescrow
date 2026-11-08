import { NextResponse } from "next/server";
import { saveWaitlistEmail } from "@/lib/waitlist-store";
import {
  MIN_IP_SALT_LENGTH,
  clientAddressFromHeaders,
  hashClientAddress,
  isHoneypotTripped,
  isSameOriginSubmission,
  normalizeEmail,
} from "@/lib/waitlist-policy";

const MAX_BODY_BYTES = 4_096;
const JSON_MIME = "application/json";
const SUCCESS_MESSAGE = "You are on the list. We will write when it opens.";
const INVALID_EMAIL_MESSAGE = "Enter a valid email address.";
const RATE_LIMIT_MESSAGE = "Too many attempts from this network. Try again in an hour.";
const ORIGIN_MESSAGE = "Submit the form from this site.";
const BAD_REQUEST_MESSAGE = "That request could not be read.";
const FAILURE_MESSAGE = "Something went wrong. Try again.";

type Payload = {
  email: unknown;
  hp: unknown;
};

export async function POST(request: Request) {
  const kind = contentKind(request.headers.get("content-type"));
  if (kind === "unsupported") {
    return respond(request, 415, false, BAD_REQUEST_MESSAGE);
  }
  if (!isSameOriginSubmission({
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  })) {
    return respond(request, 403, false, ORIGIN_MESSAGE);
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const size = Number(declaredLength);
    if (!Number.isFinite(size) || size > MAX_BODY_BYTES) {
      return respond(request, 413, false, BAD_REQUEST_MESSAGE);
    }
  }

  const payload = await readPayload(request, kind);
  if (payload === "too-large" || payload === "bad") {
    return respond(request, payload === "too-large" ? 413 : 400, false, BAD_REQUEST_MESSAGE);
  }
  if (isHoneypotTripped(payload.hp)) {
    return respond(request, 200, true, SUCCESS_MESSAGE);
  }

  const email = normalizeEmail(payload.email);
  if (!email) {
    return respond(request, 400, false, INVALID_EMAIL_MESSAGE);
  }

  const salt = process.env.WAITLIST_IP_SALT;
  if (!salt || salt.length < MIN_IP_SALT_LENGTH) {
    console.error("waitlist_config_missing");
    return respond(request, 500, false, FAILURE_MESSAGE);
  }

  const ipHash = hashClientAddress(
    clientAddressFromHeaders(
      request.headers.get("x-forwarded-for"),
      request.headers.get("x-real-ip"),
    ),
    salt,
  );

  try {
    const result = await saveWaitlistEmail(email, ipHash);
    if (result === "limited") {
      return respond(request, 429, false, RATE_LIMIT_MESSAGE);
    }
    return respond(request, 200, true, SUCCESS_MESSAGE);
  } catch (error) {
    console.error(
      "waitlist_write_failed",
      error instanceof Error ? error.name : "unknown",
    );
    return respond(request, 500, false, FAILURE_MESSAGE);
  }
}

function contentKind(contentType: string | null): "json" | "form" | "unsupported" {
  const mime = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mime === JSON_MIME) return "json";
  if (mime === "application/x-www-form-urlencoded" || mime === "multipart/form-data") {
    return "form";
  }
  return "unsupported";
}

async function readPayload(
  request: Request,
  kind: "json" | "form",
): Promise<Payload | "too-large" | "bad"> {
  if (kind === "json") {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return "too-large";
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object") return "bad";
      const record = parsed as Record<string, unknown>;
      return { email: record.email, hp: record.hp_field };
    } catch {
      return "bad";
    }
  }

  const form = await request.formData();
  return { email: form.get("email"), hp: form.get("hp_field") };
}

function respond(request: Request, status: number, ok: boolean, message: string) {
  const headers = { "cache-control": "no-store" };
  if (contentKind(request.headers.get("content-type")) === "json") {
    return Response.json({ ok, message }, { status, headers });
  }
  if (ok) {
    return NextResponse.redirect(new URL("/joined", request.url), 303);
  }
  return new Response(htmlPage(message), {
    status,
    headers: { ...headers, "content-type": "text/html; charset=utf-8" },
  });
}

function htmlPage(message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Waitlist</title>
</head>
<body>
  <main>
    <h1>Waitlist</h1>
    <p>${message}</p>
    <p><a href="/">Back</a></p>
  </main>
</body>
</html>`;
}
