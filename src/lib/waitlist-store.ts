import { getSql } from "@/lib/db";
import { isRateLimited } from "@/lib/waitlist-policy";

export type WaitlistWrite = "saved" | "limited";

function readCount(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const count = Number(value);
  if (!Number.isFinite(count)) return null;
  return count;
}

export async function saveWaitlistEmail(
  email: string,
  ipHash: string,
): Promise<WaitlistWrite> {
  const sql = getSql();
  await sql`
    DELETE FROM waitlist_attempts
    WHERE created_at < now() - interval '1 hour'
  `;
  const rows = await sql`
    SELECT COUNT(*)::int AS count
    FROM waitlist_attempts
    WHERE ip_hash = ${ipHash}
      AND created_at > now() - interval '1 hour'
  `;
  const count = readCount(rows[0]?.count);
  if (count === null || isRateLimited(count)) return "limited";

  await sql`INSERT INTO waitlist_attempts (ip_hash) VALUES (${ipHash})`;
  await sql`
    INSERT INTO waitlist_signups (email)
    VALUES (${email})
    ON CONFLICT (email) DO NOTHING
  `;
  return "saved";
}
