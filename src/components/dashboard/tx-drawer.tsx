"use client";

import { createContext, useCallback, useContext, useEffect, useId, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import {
  errorText,
  isPending,
  markTxLogged,
  pendingCount,
  reduceTxLog,
  signatureOf,
  toastEntry,
  TOAST_LINGER_MS,
  type TxCopy,
  type TxEntry,
  type TxOrigin,
  type TxStatus,
} from "@/lib/tx-log";
import { TxLink } from "./chain-link";
import { short } from "./format";

export type TxLogApi = {
  run: <T>(copy: TxCopy, origin: TxOrigin, send: (signed: () => void) => Promise<T>, pick?: (value: T) => unknown) => Promise<T>;
  record: (copy: TxCopy, signature: string) => void;
  fail: (copy: TxCopy, message: string) => void;
  setActivity: (key: string, label: string | null) => void;
};

const NO_TX_LOG: TxLogApi = {
  run: (_copy, _origin, send) => send(() => {}),
  record: () => {},
  fail: () => {},
  setActivity: () => {},
};

const TxLogContext = createContext<TxLogApi>(NO_TX_LOG);

const STATUS_LABEL: Record<TxStatus, string> = {
  signing: "Waiting for wallet",
  confirming: "Confirming",
  confirmed: "Confirmed",
  failed: "Failed",
};

const STATUS_DETAIL: Record<TxStatus, string> = {
  signing: "Approve it in your wallet.",
  confirming: "Sent. Waiting for the network to confirm it.",
  confirmed: "Confirmed on chain.",
  failed: "It did not go through.",
};

export function useTxLog(): TxLogApi {
  return useContext(TxLogContext);
}

export function useTxActivity(label: string | null): void {
  const { setActivity } = useTxLog();
  const key = useId();
  useEffect(() => {
    setActivity(key, label);
  }, [setActivity, key, label]);
  useEffect(() => () => setActivity(key, null), [setActivity, key]);
}

export function TxLogProvider({ children }: { children: ReactNode }) {
  const [entries, dispatch] = useReducer(reduceTxLog, []);
  const [activities, setActivities] = useState<Readonly<Record<string, string>>>({});
  const [open, setOpen] = useState(false);
  const nextId = useRef(0);

  const run = useCallback(async <T,>(copy: TxCopy, origin: TxOrigin, send: (signed: () => void) => Promise<T>, pick?: (value: T) => unknown) => {
    const id = nextId.current;
    nextId.current += 1;
    dispatch({ kind: "start", id, copy, origin, at: Date.now() });
    try {
      const value = await send(() => dispatch({ kind: "signed", id }));
      dispatch({ kind: "confirmed", id, signature: signatureOf(pick === undefined ? value : pick(value)), at: Date.now() });
      return value;
    } catch (error) {
      markTxLogged(error);
      dispatch({ kind: "failed", id, error: errorText(error, "The transaction failed."), at: Date.now() });
      throw error;
    }
  }, []);
  const record = useCallback((copy: TxCopy, signature: string) => {
    const id = nextId.current;
    nextId.current += 1;
    const at = Date.now();
    dispatch({ kind: "start", id, copy, origin: "desk", at });
    dispatch({ kind: "confirmed", id, signature: signatureOf(signature), at });
  }, []);
  const fail = useCallback((copy: TxCopy, message: string) => {
    const shown = errorText(new Error(message), "The transaction failed.");
    if (shown.length === 0) return;
    const id = nextId.current;
    nextId.current += 1;
    const at = Date.now();
    dispatch({ kind: "start", id, copy, origin: "desk", at });
    dispatch({ kind: "failed", id, error: shown, at });
  }, []);
  const setActivity = useCallback((key: string, label: string | null) => {
    setActivities((current) => {
      if (label === null) {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      }
      return current[key] === label ? current : { ...current, [key]: label };
    });
  }, []);
  const api = useMemo(() => ({ run, record, fail, setActivity }), [run, record, fail, setActivity]);
  const activity = Object.values(activities).at(-1) ?? null;

  return (
    <TxLogContext.Provider value={api}>
      {children}
      {open ? null : <TxToast entries={entries} activity={activity} onShowAll={() => setOpen(true)} />}
      <TxDrawer entries={entries} open={open} onOpen={() => setOpen(true)} onClose={() => setOpen(false)} onClear={() => dispatch({ kind: "clear-settled" })} />
    </TxLogContext.Provider>
  );
}

function TxToast({ entries, activity, onShowAll }: { entries: readonly TxEntry[]; activity: string | null; onShowAll: () => void }) {
  const [clock, setClock] = useState(0);
  const [dismissedId, setDismissedId] = useState<number | null>(null);
  const entry = toastEntry(entries, clock, dismissedId);
  const lingering = entry?.status === "confirmed" ? entry : null;

  useEffect(() => {
    if (lingering === null || lingering.settledAt === null) return;
    const left = Math.max(0, lingering.settledAt + TOAST_LINGER_MS - Date.now());
    const timer = setTimeout(() => setClock(Date.now()), left);
    return () => clearTimeout(timer);
  }, [lingering]);

  if (entry === null && activity === null) return null;
  const settled = entry !== null && !isPending(entry.status);

  return (
    <div role="status" aria-live="polite" className="fixed right-4 bottom-4 z-40 w-[min(24rem,calc(100vw-2rem))] border border-line bg-background p-4 text-sm shadow-[0_8px_30px_rgba(26,24,20,0.12)]">
      <div className="flex items-start justify-between gap-3">
        <p className="flex items-center gap-2">
          {activity !== null || (entry !== null && isPending(entry.status)) ? (
            <span aria-hidden="true" className="size-2 shrink-0 animate-pulse rounded-full bg-stamp motion-reduce:animate-none" />
          ) : null}
          <span>{activity ?? entry?.step}</span>
        </p>
        {settled ? (
          <button type="button" className="shrink-0 text-muted underline-offset-4 hover:underline" onClick={() => setDismissedId(entry.id)}>
            Dismiss
          </button>
        ) : null}
      </div>
      {entry !== null ? (
        <div className="mt-2">
          <p className={entry.status === "failed" ? "text-stamp" : ""}>
            {activity !== null ? `${entry.step} · ` : ""}
            {STATUS_DETAIL[entry.status]}
          </p>
          <p className="mt-1 leading-6 text-muted">{entry.explanation}</p>
          {entry.error !== null ? <p className="mt-1 line-clamp-3 leading-6 break-all text-stamp">{entry.error}</p> : null}
        </div>
      ) : null}
      <div className="mt-3 flex items-center justify-between gap-3">
        {entry?.signature ? <TxLink signature={entry.signature}>{short(entry.signature)}</TxLink> : <span />}
        <button type="button" className="text-muted underline-offset-4 hover:underline" onClick={onShowAll}>
          All transactions
        </button>
      </div>
    </div>
  );
}

function TxDrawer({
  entries,
  open,
  onOpen,
  onClose,
  onClear,
}: {
  entries: readonly TxEntry[];
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onClear: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const titleId = useId();
  const pending = pendingCount(entries);
  const settled = entries.length - pending;

  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  function close(): void {
    onClose();
    handleRef.current?.focus();
  }

  return (
    <>
      <button
        ref={handleRef}
        type="button"
        className="fixed top-1/2 right-0 z-40 flex -translate-y-1/2 items-center gap-2 border border-r-0 border-line bg-background px-2 py-4 text-sm [writing-mode:vertical-rl]"
        aria-expanded={open}
        aria-controls={panelId}
        hidden={open}
        onClick={onOpen}
      >
        {pending > 0 ? <span aria-hidden="true" className="size-2 animate-pulse rounded-full bg-stamp motion-reduce:animate-none" /> : null}
        <span>Transactions{entries.length > 0 ? ` · ${entries.length}` : ""}</span>
        {pending > 0 ? <span className="sr-only">{`, ${pending} pending`}</span> : null}
      </button>
      <aside
        id={panelId}
        aria-labelledby={titleId}
        inert={!open}
        className={`fixed inset-y-0 right-0 z-50 flex w-full max-w-lg flex-col border-l border-line bg-background transition-transform duration-200 motion-reduce:transition-none ${open ? "translate-x-0" : "translate-x-full"}`}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          close();
        }}
      >
        <div className="flex items-center justify-between gap-4 border-b border-line px-6 py-4">
          <h2 id={titleId} className="font-serif text-2xl tracking-[-0.03em]">
            Transactions
          </h2>
          <div className="flex items-center gap-3 text-sm">
            <button type="button" className="text-muted underline-offset-4 hover:underline disabled:opacity-40" disabled={settled === 0} onClick={onClear}>
              Clear finished
            </button>
            <button ref={closeRef} type="button" className="border border-line px-3 py-1" aria-controls={panelId} aria-expanded={open} onClick={close}>
              Reduce
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-6 pb-6">
          {entries.length === 0 ? (
            <p className="mt-6 text-sm leading-6 text-muted">Transactions sent from this tab show here, newest first. The list is not kept after a reload.</p>
          ) : (
            <TxTable entries={entries} />
          )}
        </div>
      </aside>
    </>
  );
}

function TxTable({ entries }: { entries: readonly TxEntry[] }) {
  return (
    <table className="mt-4 w-full text-left text-sm">
      <thead className="text-muted">
        <tr>
          <th scope="col" className="py-2 pr-3 font-normal">
            Status
          </th>
          <th scope="col" className="py-2 pr-3 font-normal">
            Step
          </th>
          <th scope="col" className="py-2 font-normal">
            Transaction
          </th>
        </tr>
      </thead>
      <tbody aria-live="polite">
        {entries.map((entry) => (
          <tr key={entry.id} className="border-t border-line align-top">
            <td className="py-3 pr-3 whitespace-nowrap">
              <StatusMark status={entry.status} />
              <time className="mt-1 block text-xs text-muted" dateTime={new Date(entry.startedAt).toISOString()}>
                {new Date(entry.startedAt).toLocaleTimeString()}
              </time>
            </td>
            <td className="py-3 pr-3">
              <p>{entry.step}</p>
              <p className="mt-1 leading-6 text-muted">{entry.explanation}</p>
              {entry.error !== null ? <p className="mt-1 leading-6 break-all text-stamp">{entry.error}</p> : null}
            </td>
            <td className="py-3 whitespace-nowrap">
              {entry.signature !== null ? (
                <TxLink signature={entry.signature}>{short(entry.signature)}</TxLink>
              ) : (
                <span className="text-muted">{isPending(entry.status) ? "…" : "None"}</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StatusMark({ status }: { status: TxStatus }) {
  const tone = status === "failed" ? "text-stamp" : status === "confirmed" ? "" : "text-muted";
  return (
    <span className={`inline-flex items-center gap-2 ${tone}`}>
      {isPending(status) ? <span aria-hidden="true" className="size-2 animate-pulse rounded-full bg-stamp motion-reduce:animate-none" /> : null}
      {STATUS_LABEL[status]}
    </span>
  );
}
