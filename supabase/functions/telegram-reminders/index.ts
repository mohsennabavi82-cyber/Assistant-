const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const DEFAULT_TIME_ZONE = "Asia/Tehran";

type Reminder = {
  id?: string | number;
  title?: string;
  date?: string;
  time?: string;
  timezone?: string;
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function dbHeaders(extra: Record<string, string> = {}) {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function db(path: string, init: RequestInit = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: dbHeaders(init.headers as Record<string, string> | undefined),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Database request failed (${response.status}): ${body.slice(0, 300)}`);
  return body ? JSON.parse(body) : null;
}

async function validateCronToken(token: string) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/validate_lifeos_reminder_cron`, {
    method: "POST",
    headers: dbHeaders(),
    body: JSON.stringify({ p_token: token }),
  });
  if (!response.ok) return false;
  return (await response.json()) === true;
}

function getLocalParts(timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date()).map((part) => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minute: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function isDue(reminder: Reminder) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(reminder.date ?? ""))) return false;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(reminder.time ?? ""))) return false;
  let timezone = String(reminder.timezone || DEFAULT_TIME_ZONE);
  let local;
  try {
    local = getLocalParts(timezone);
  } catch {
    timezone = DEFAULT_TIME_ZONE;
    local = getLocalParts(timezone);
  }
  if (reminder.date !== local.date) return false;
  const [hour, minute] = String(reminder.time).split(":").map(Number);
  const minutesLate = local.minute - (hour * 60 + minute);
  // A short grace window tolerates a slightly delayed cron invocation.
  return minutesLate >= 0 && minutesLate <= 3;
}

async function claim(userId: string, reminder: Reminder, timezone: string) {
  return await db("rpc/claim_lifeos_reminder_delivery", {
    method: "POST",
    body: JSON.stringify({
      p_user_id: userId,
      p_reminder_id: String(reminder.id),
      p_reminder_date: reminder.date,
      p_reminder_time: reminder.time,
      p_timezone: timezone,
    }),
  }) === true;
}

async function mark(userId: string, reminder: Reminder, timezone: string, state: "sent" | "failed", error = "") {
  const params = new URLSearchParams({
    user_id: `eq.${userId}`,
    reminder_id: `eq.${String(reminder.id)}`,
    reminder_date: `eq.${reminder.date}`,
    reminder_time: `eq.${reminder.time}`,
    timezone: `eq.${timezone}`,
  });
  await db(`lifeos_reminder_deliveries?${params.toString()}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      state,
      sent_at: state === "sent" ? new Date().toISOString() : null,
      last_error: state === "failed" ? error.slice(0, 500) : null,
    }),
  });
}

async function sendTelegram(chatId: number | string, reminder: Reminder) {
  if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  const text = `⏰ یادآوری LIFEOS\n\n<b>${escapeHtml(String(reminder.title || "یادآوری"))}</b>\n\nوقت انجامشه 🌱`;
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
  const result = await response.json();
  if (!response.ok || !result?.ok) throw new Error(`Telegram send failed (${response.status})`);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "POST required" }, 405);
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: "Supabase configuration is incomplete" }, 500);

  const token = req.headers.get("x-lifeos-cron-token") ?? "";
  if (!token || !(await validateCronToken(token))) return json({ error: "Unauthorized" }, 401);

  try {
    const [rows, links] = await Promise.all([
      db("lifeos_dashboard_data?select=user_id,data"),
      db("lifeos_telegram_links?select=user_id,chat_id&chat_id=not.is.null"),
    ]);
    const chatByUser = new Map<string, number>(
      (links ?? []).filter((link: { user_id: string; chat_id: number | null }) => link.chat_id != null)
        .map((link: { user_id: string; chat_id: number }) => [link.user_id, link.chat_id]),
    );

    let sent = 0;
    let failed = 0;
    for (const row of rows ?? []) {
      const chatId = chatByUser.get(row.user_id);
      if (!chatId) continue;
      const reminders: Reminder[] = Array.isArray(row.data?.reminders) ? row.data.reminders : [];
      for (const reminder of reminders) {
        if (reminder.id == null || !isDue(reminder)) continue;
        let timezone = String(reminder.timezone || DEFAULT_TIME_ZONE);
        try { new Intl.DateTimeFormat("en", { timeZone: timezone }); }
        catch { timezone = DEFAULT_TIME_ZONE; }
        if (!(await claim(row.user_id, reminder, timezone))) continue;
        try {
          await sendTelegram(chatId, reminder);
          await mark(row.user_id, reminder, timezone, "sent");
          sent++;
        } catch (error) {
          failed++;
          try { await mark(row.user_id, reminder, timezone, "failed", error instanceof Error ? error.message : String(error)); }
          catch (markError) { console.error("Could not update reminder delivery status", String(markError)); }
        }
      }
    }
    return json({ ok: true, sent, failed });
  } catch (error) {
    console.error("Reminder job failed", String(error));
    return json({ error: "Reminder processing failed" }, 500);
  }
});
