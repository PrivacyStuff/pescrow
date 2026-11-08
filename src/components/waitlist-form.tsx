"use client";

import { useState, useTransition, type FormEvent } from "react";

type FormNotice =
  | { kind: "idle" }
  | { kind: "done"; message: string }
  | { kind: "error"; message: string };

export function WaitlistForm() {
  const [notice, setNotice] = useState<FormNotice>({ kind: "idle" });
  const [pending, startTransition] = useTransition();

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const email = data.get("email");
    const hpField = data.get("hp_field");

    startTransition(async () => {
      try {
        const response = await fetch("/api/waitlist", {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({ email, hp_field: hpField }),
        });
        const body: unknown = await response.json();
        const message = readMessage(body);
        if (response.ok) {
          setNotice({ kind: "done", message });
          form.reset();
          return;
        }
        setNotice({ kind: "error", message });
      } catch {
        setNotice({
          kind: "error",
          message: "Could not reach the server. Try again.",
        });
      }
    });
  }

  return (
    <form className="mt-10 max-w-xl" action="/api/waitlist" method="post" onSubmit={onSubmit}>
      <div className="hp-field" aria-hidden="true">
        <label htmlFor="hp_field">Company site</label>
        <input
          id="hp_field"
          name="hp_field"
          type="text"
          tabIndex={-1}
          autoComplete="off"
        />
      </div>
      <label className="block text-sm" htmlFor="email">
        Email
      </label>
      <div className="mt-3 flex flex-col gap-3 sm:flex-row">
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={254}
          placeholder="you@example.com"
          className="h-12 min-w-0 flex-1 border border-foreground bg-transparent px-3 text-base outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
        />
        <button
          type="submit"
          disabled={pending}
          aria-busy={pending}
          className="h-12 border border-foreground bg-foreground px-5 text-background disabled:opacity-60"
        >
          {pending ? "Joining" : "Join the waitlist"}
        </button>
      </div>
      <p className="mt-3 min-h-6 text-sm" aria-live="polite">
        {notice.kind === "idle" ? (
          <span className="text-muted">One email. No account.</span>
        ) : (
          <span className={notice.kind === "error" ? "text-stamp" : undefined}>
            {notice.message}
          </span>
        )}
      </p>
    </form>
  );
}

function readMessage(body: unknown): string {
  if (!body || typeof body !== "object" || !("message" in body)) {
    return "Could not join the waitlist.";
  }
  const message = body.message;
  return typeof message === "string" && message.length > 0
    ? message
    : "Could not join the waitlist.";
}
