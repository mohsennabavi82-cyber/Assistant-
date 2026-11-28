const encoder = new TextEncoder();
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const BOT_USERNAME = "MassistantNbot";
const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/telegram-bot`;
const DASHBOARD_URL = "https://mohsennabavi82-cyber.github.io/Assistant-/LIFEOS-dark2.html";
let webhookReady = false;

const allowedOrigins = new Set([
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "https://mohsennabavi82-cyber.github.io",
]);

function corsHeaders(origin: string | null) {
  const headers = new Headers({
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  });
  if (origin && allowedOrigins.has(origin)) headers.set("Access-Control-Allow-Origin", origin);
  return headers;
}

function json(data: unknown, status = 200, origin: string | null = null) {
  const headers = corsHeaders(origin);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { status, headers });
}

async function hash(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function webhookSecret() {
  return await hash(`lifeos-telegram-webhook:${BOT_TOKEN}`);
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
  if (!response.ok) throw new Error(`Database request failed (${response.status})`);
  return body ? JSON.parse(body) : null;
}

async function telegram(method: string, body: Record<string, unknown>) {
  if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`Telegram ${method} failed`);
  return result.result;
}

async function authenticate(req: Request) {
  const authorization = req.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? (() => {
    try { return JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}").default; }
    catch { return ""; }
  })();
  if (!anonKey) return null;
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: authorization },
  });
  if (!response.ok) return null;
  const user = await response.json();
  return typeof user.id === "string" ? user.id as string : null;
}

async function registerWebhook() {
  const result = await telegram("setWebhook", {
    url: FUNCTION_URL,
    secret_token: await webhookSecret(),
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false,
  });
  webhookReady = true;
  return result;
}

async function ensureWebhookRegistered() {
  if (!webhookReady) await registerWebhook();
}

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function createLink(userId: string) {
  if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not configured in Supabase Secrets");
  await registerWebhook();
  const code = newCode();
  const codeHash = await hash(code);
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await db("lifeos_telegram_links?on_conflict=user_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      user_id: userId,
      link_code_hash: codeHash,
      link_code_expires_at: expires,
      updated_at: new Date().toISOString(),
    }),
  });
  return `https://t.me/${BOT_USERNAME}?start=${code}`;
}

const MAIN_KEYBOARD = {
  keyboard: [
    [{ text: "📋 کارهای باز" }, { text: "➕ کار جدید" }, { text: "✅ تکمیل کار" }],
    [{ text: "⏰ یادآور" }, { text: "📝 یادداشت" }, { text: "🧠 یادداشت‌ها" }],
    [{ text: "🗓 تقویم" }, { text: "📌 رویداد" }, { text: "🔎 تحقیق" }],
    [{ text: "📊 گزارش" }, { text: "🏠 داشبورد من" }, { text: "ℹ️ راهنما" }],
  ],
  resize_keyboard: true,
  is_persistent: true,
  input_field_placeholder: "پیام یا سؤال بنویس…",
};
const PRIVATE_CHAT_IDS = new Set<number>();
const PRIVATE_KEYBOARD = {
  ...MAIN_KEYBOARD,
  keyboard: [
    ...MAIN_KEYBOARD.keyboard,
    [{ text: "📲 ورود مستقیم به LIFEOS", web_app: { url: DASHBOARD_URL } }],
  ],
};

const ADD_TASK_PROMPT = "✍️ عنوان کار جدید را بفرست:";
const ADD_REMINDER_PROMPT = "⏰ یادآور را این‌طور بفرست: عنوان | تاریخ (YYYY-MM-DD) | ساعت (HH:MM)\nفقط عنوان هم بفرستی، برای امروز ثبت می‌شود.";
const ADD_EVENT_PROMPT = "📌 رویداد را این‌طور بفرست: عنوان | تاریخ (YYYY-MM-DD) | ساعت (HH:MM)";
const ADD_NOTE_PROMPT = "📝 یادداشت را این‌طور بفرست: عنوان | متن یادداشت";
const RESEARCH_PROMPT = "🔎 پرسشت را برای تحقیق بفرست:";

async function sendMessage(chatId: number, text: string, extra: Record<string, unknown> = {}) {
  await telegram("sendMessage", {
    chat_id: chatId,
    text,
    ...extra,
    reply_markup: extra.reply_markup ?? (PRIVATE_CHAT_IDS.has(chatId) ? PRIVATE_KEYBOARD : MAIN_KEYBOARD),
  });
}

async function sendWelcomeMessage(chatId: number, linked: boolean) {
  const text = linked
    ? "<b>سلام، خوش برگشتی به LIFEOS 👋</b>\n<blockquote>دستیار شخصی تو برای مرتب‌کردن کارها و برنامه‌های روزانه 🌱</blockquote>\n✅ حسابت به داشبورد متصل است.\n\n<b>از منوی پایین استفاده کن:</b>\n📋 کارهای باز و کار جدید\n⏰ یادآورها و 📝 یادداشت‌ها\n🗓 تقویم، رویداد و گزارش\n\nهر سؤال یا درخواستی داشتی، همین‌جا برام بنویس."
    : "<b>سلام! به LIFEOS خوش اومدی 👋</b>\n<blockquote>یک همراه ساده برای برنامه‌ریزی، یادآوری و ثبت ایده‌ها 🌱</blockquote>\n\nبرای شروع، از داشبورد LIFEOS گزینهٔ <b>اتصال حساب به تلگرام</b> را بزن و بعد لینک را باز کن و Start را انتخاب کن.\n\nبعد از اتصال، دکمه‌های مدیریت کارها و یادداشت‌ها همین‌جا در دسترست هستند.\n\n🏠 با دکمهٔ «داشبورد من» هم هر وقت خواستی به برنامه برگرد.";
  await sendMessage(chatId, text, { parse_mode: "HTML" });
}

async function sendDashboardButton(chatId: number) {
  const directButton = PRIVATE_CHAT_IDS.has(chatId)
    ? { text: "📲 ورود مستقیم به LIFEOS", web_app: { url: DASHBOARD_URL } }
    : { text: "🏠 بازکردن داشبورد LIFEOS", url: DASHBOARD_URL };
  await telegram("sendMessage", {
    chat_id: chatId,
    text: "برای ورود به LIFEOS روی دکمه بزن. می‌توانی با حساب ایمیل خودت وارد شوی.",
    reply_markup: {
      inline_keyboard: [[directButton], [{ text: "🌐 نسخهٔ وب داشبورد", url: DASHBOARD_URL }]],
    },
  });
}

async function answerWithOpenRouter(prompt: string) {
  const apiKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!apiKey) return "پاسخ هوشمند هنوز تنظیم نشده است. کلید OpenRouter را در Supabase Secrets اضافه کن.";
  const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://mohsennabavi82-cyber.github.io/Assistant-/",
      "X-Title": "LIFEOS Telegram",
    },
    body: JSON.stringify({
      model: "openrouter/free",
      max_tokens: 500,
      temperature: 0.4,
      messages: [
        { role: "system", content: "تو دستیار LIFEOS هستی. پاسخ را به فارسی روان، مفید و متناسب با سن نوجوان بده. از محتوای بزرگسالانه و راهنمایی خطرناک پرهیز کن. اطلاعات داشبورد یا اطلاعات شخصی کاربر را درخواست نکن." },
        { role: "user", content: prompt.slice(0, 1200) },
      ],
    }),
  });
  if (!upstream.ok) {
    console.error("OpenRouter Telegram request failed", upstream.status);
    return upstream.status === 429 ? "سهمیهٔ رایگان فعلاً پر شده؛ کمی بعد دوباره امتحان کن." : "فعلاً نتونستم پاسخ بگیرم؛ دوباره امتحان کن.";
  }
  const result = await upstream.json();
  const answer = result?.choices?.[0]?.message?.content;
  return typeof answer === "string" && answer.trim() ? answer.trim().slice(0, 3900) : "مدل فعلاً پاسخ متنی نداد؛ دوباره امتحان کن.";
}

function cleanCommand(text: string) {
  return text.trim().replace(/@[A-Za-z0-9_]+(?=\s|$)/, "");
}

async function linkChat(chatId: number, code: string) {
  const codeHash = await hash(code);
  const rows = await db(
    `lifeos_telegram_links?select=user_id&link_code_hash=eq.${encodeURIComponent(codeHash)}&link_code_expires_at=gt.${encodeURIComponent(new Date().toISOString())}`,
  );
  if (!rows?.length) {
    await sendMessage(chatId, "این لینک معتبر نیست یا زمانش تمام شده. از داخل LIFEOS دوباره اتصال تلگرام را بزن.");
    return;
  }
  const userId = rows[0].user_id as string;
  await db(`lifeos_telegram_links?link_code_hash=eq.${encodeURIComponent(codeHash)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      chat_id: chatId,
      link_code_hash: null,
      link_code_expires_at: null,
      linked_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
  });
  await sendWelcomeMessage(chatId, true);
}

async function userForChat(chatId: number) {
  const rows = await db(`lifeos_telegram_links?select=user_id&chat_id=eq.${chatId}`);
  return rows?.[0]?.user_id as string | undefined;
}

async function readDashboard(userId: string) {
  const rows = await db(`lifeos_dashboard_data?select=data&user_id=eq.${encodeURIComponent(userId)}`);
  return rows?.[0]?.data ?? { tasks: [], notes: [], events: [], reminders: [], activity: [] };
}

async function saveDashboard(userId: string, data: Record<string, unknown>) {
  await db("lifeos_dashboard_data?on_conflict=user_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ user_id: userId, data, updated_at: new Date().toISOString() }),
  });
}

async function addTask(userId: string, data: Record<string, unknown>, tasks: Array<Record<string, unknown>>, title: string, chatId: number) {
  const cleanTitle = title.trim().slice(0, 180);
  const id = Date.now();
  tasks.unshift({ id, title: cleanTitle, date: new Date().toISOString().slice(0, 10), priority: "mid", done: false });
  data.tasks = tasks;
  const activity = Array.isArray(data.activity) ? data.activity as unknown[] : [];
  data.activity = [{ id, type: "task", text: `کار جدید: ${cleanTitle}`, ts: Date.now() }, ...activity].slice(0, 30);
  await saveDashboard(userId, data);
  await sendMessage(chatId, `کار به LIFEOS اضافه شد ✅\n${cleanTitle}`);
}

function todayISO() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function parseScheduleInput(raw: string) {
  const parts = raw.split("|").map((part) => part.trim());
  const title = parts[0]?.slice(0, 100) ?? "";
  const date = parts[1] || todayISO();
  const time = parts[2] || "";
  if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date) || (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))) return null;
  return { title, date, time };
}

async function addScheduleItem(userId: string, data: Record<string, unknown>, kind: "events" | "reminders", raw: string, chatId: number) {
  const parsed = parseScheduleInput(raw);
  if (!parsed) return await sendMessage(chatId, "قالب پیام درست نیست. این‌طور بفرست:\nعنوان | 2026-11-25 | 18:30\nساعت اختیاری است.");
  const id = Date.now();
  const items = Array.isArray(data[kind]) ? data[kind] as Array<Record<string, unknown>> : [];
  items.push({ id, ...parsed, ...(kind === "reminders" ? { timezone: "Asia/Tehran" } : {}) });
  data[kind] = items;
  const activity = Array.isArray(data.activity) ? data.activity as unknown[] : [];
  const label = kind === "events" ? "رویداد" : "یادآور";
  data.activity = [{ id, type: kind === "events" ? "event" : "reminder", text: `${label} جدید: ${parsed.title}`, ts: Date.now() }, ...activity].slice(0, 30);
  await saveDashboard(userId, data);
  await sendMessage(chatId, `${label} در LIFEOS ثبت شد ✅\n${parsed.title}\n${parsed.date}${parsed.time ? ` · ${parsed.time}` : ""}`);
}

async function addNote(userId: string, data: Record<string, unknown>, raw: string, chatId: number) {
  const separator = raw.indexOf("|");
  const title = (separator >= 0 ? raw.slice(0, separator) : raw).trim().slice(0, 80);
  const body = (separator >= 0 ? raw.slice(separator + 1) : raw).trim().slice(0, 2000);
  if (!title || !body) return await sendMessage(chatId, "یادداشت را این‌طور بفرست: عنوان | متن یادداشت");
  const id = Date.now();
  const notes = Array.isArray(data.notes) ? data.notes as Array<Record<string, unknown>> : [];
  notes.unshift({ id, title, body, date: todayISO() });
  data.notes = notes;
  const activity = Array.isArray(data.activity) ? data.activity as unknown[] : [];
  data.activity = [{ id, type: "note", text: `یادداشت جدید: ${title}`, ts: Date.now() }, ...activity].slice(0, 30);
  await saveDashboard(userId, data);
  await sendMessage(chatId, `یادداشت «${title}» ذخیره شد ✅`);
}

async function sendOpenTasks(tasks: Array<Record<string, unknown>>, chatId: number) {
  const open = tasks.filter((task) => !task.done).slice(0, 15);
  const body = open.length
    ? open.map((task) => `#${task.id} ${String(task.title ?? "بدون عنوان")}`).join("\n")
    : "کار بازی ثبت نشده است.";
  await sendMessage(chatId, `کارهای باز LIFEOS:\n${body}`);
}

async function sendCalendar(data: Record<string, unknown>, chatId: number) {
  const start = todayISO();
  const endDate = new Date();
  endDate.setDate(endDate.getDate() + 7);
  const end = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, "0")}-${String(endDate.getDate()).padStart(2, "0")}`;
  const events = Array.isArray(data.events) ? data.events as Array<Record<string, unknown>> : [];
  const reminders = Array.isArray(data.reminders) ? data.reminders as Array<Record<string, unknown>> : [];
  const tasks = Array.isArray(data.tasks) ? data.tasks as Array<Record<string, unknown>> : [];
  const lines = [
    ...events.filter((item) => String(item.date ?? "") >= start && String(item.date ?? "") <= end).map((item) => `📌 ${item.date}${item.time ? ` ${item.time}` : ""} — ${item.title}`),
    ...reminders.filter((item) => String(item.date ?? "") >= start && String(item.date ?? "") <= end).map((item) => `⏰ ${item.date}${item.time ? ` ${item.time}` : ""} — ${item.title}`),
    ...tasks.filter((item) => !item.done && String(item.date ?? "") >= start && String(item.date ?? "") <= end).map((item) => `📋 ${item.date} — ${item.title}`),
  ].sort((a, b) => a.slice(2, 12).localeCompare(b.slice(2, 12))).slice(0, 20);
  await sendMessage(chatId, `برنامهٔ ۷ روز آیندهٔ LIFEOS 🗓\n${lines.join("\n") || "موردی در برنامه ثبت نشده است."}`);
}

async function sendRecall(data: Record<string, unknown>, chatId: number) {
  const notes = Array.isArray(data.notes) ? data.notes as Array<Record<string, unknown>> : [];
  const body = notes.slice(0, 10).map((note, index) => `${index + 1}. ${String(note.title ?? "یادداشت")}\n${String(note.body ?? "").slice(0, 220)}`).join("\n\n");
  await sendMessage(chatId, `یادداشت‌های ذخیره‌شده 🧠\n${body || "هنوز یادداشتی ذخیره نکردی."}`);
}

async function handleCallbackQuery(callback: Record<string, unknown>) {
  const callbackId = typeof callback.id === "string" ? callback.id : "";
  const payload = typeof callback.data === "string" ? callback.data : "";
  const message = callback.message as { chat?: { id?: number } } | undefined;
  const chatId = message?.chat?.id;
  if (!callbackId || !chatId || !payload.startsWith("done:")) return;

  await telegram("answerCallbackQuery", { callback_query_id: callbackId });
  const taskId = payload.slice(5);
  if (!/^\d{1,16}$/.test(taskId)) return;

  const userId = await userForChat(chatId);
  if (!userId) return await sendMessage(chatId, "این چت به LIFEOS وصل نیست. از داخل داشبورد دوباره اتصال تلگرام را انجام بده.");
  const data = await readDashboard(userId) as Record<string, unknown>;
  const tasks = Array.isArray(data.tasks) ? data.tasks as Array<Record<string, unknown>> : [];
  const task = tasks.find((item) => String(item.id) === taskId);
  if (!task) return await sendMessage(chatId, "این کار دیگر در فهرست نیست.");
  if (task.done) return await sendMessage(chatId, "این کار قبلاً تکمیل شده است ✅");
  task.done = true;
  data.tasks = tasks;
  await saveDashboard(userId, data);
  await sendMessage(chatId, `کار تکمیل شد ✅\n${String(task.title ?? "")}`);
}

async function handleMessage(message: Record<string, unknown>) {
  const chat = message.chat as { id?: number; type?: string } | undefined;
  const chatId = chat?.id;
  const rawText = typeof message.text === "string" ? message.text.trim() : "";
  const text = cleanCommand(rawText);
  if (!chatId || !text) return;
  if (chat.type === "private") PRIVATE_CHAT_IDS.add(chatId);
  else PRIVATE_CHAT_IDS.delete(chatId);

  const start = text.match(/^\/start(?:\s+([A-Za-z0-9_-]{20,80}))?/);
  if (start?.[1]) {
    await linkChat(chatId, start[1]);
    await sendDashboardButton(chatId);
    return;
  }
  if (/^\/start(?:\s|$)/.test(text)) {
    const linkedUser = await userForChat(chatId);
    await sendWelcomeMessage(chatId, Boolean(linkedUser));
    await sendDashboardButton(chatId);
    return;
  }
  if (text === "🏠 داشبورد من") return await sendDashboardButton(chatId);
  if (/^(ℹ️ راهنما|\/help)(?:\s|$)/.test(text)) {
    return await sendMessage(chatId, "از دکمه‌های پایین برای کارها، یادآورها، یادداشت‌ها، تقویم، رویدادها، تحقیق و گزارش استفاده کن. برای دستیار هم پیام معمولی بفرست.\nمیان‌برهای متنی: /task، /done، /remind، /note، /recall، /cal، /event، /research، /report");
  }

  const userId = await userForChat(chatId);
  if (!userId) return await sendMessage(chatId, "حسابی به این چت وصل نیست. در LIFEOS اتصال تلگرام را شروع کن.");
  const data = await readDashboard(userId) as Record<string, unknown>;
  const tasks = Array.isArray(data.tasks) ? data.tasks as Array<Record<string, unknown>> : [];

  const replyTo = message.reply_to_message as { text?: string } | undefined;
  if (replyTo?.text === ADD_TASK_PROMPT && !text.startsWith("/") && text.length <= 180) {
    return await addTask(userId, data, tasks, text, chatId);
  }
  if (replyTo?.text === ADD_REMINDER_PROMPT) return await addScheduleItem(userId, data, "reminders", text, chatId);
  if (replyTo?.text === ADD_EVENT_PROMPT) return await addScheduleItem(userId, data, "events", text, chatId);
  if (replyTo?.text === ADD_NOTE_PROMPT) return await addNote(userId, data, text, chatId);
  if (replyTo?.text === RESEARCH_PROMPT) return await sendMessage(chatId, await answerWithOpenRouter(text));

  const taskArgument = text.match(/^\/task\s+(.{1,180})$/s);
  if (text === "➕ کار جدید" || text === "/task") {
    return await sendMessage(chatId, ADD_TASK_PROMPT, { reply_markup: { force_reply: true, selective: true, input_field_placeholder: "عنوان کار را بنویس" } });
  }
  if (taskArgument) return await addTask(userId, data, tasks, taskArgument[1], chatId);

  if (/^(📋 کارهای باز|\/tasks)(?:\s|$)/.test(text)) {
    return await sendOpenTasks(tasks, chatId);
  }
  if (text === "✅ تکمیل کار" || text === "/done") {
    const open = tasks.filter((task) => !task.done).slice(0, 12);
    if (!open.length) return await sendMessage(chatId, "کاری برای تکمیل نداری ✅");
    const inline_keyboard = open.map((task) => [{
      text: `✅ #${String(task.id)} ${String(task.title ?? "بدون عنوان").slice(0, 35)}`,
      callback_data: `done:${String(task.id).slice(0, 16)}`,
    }]);
    return await sendMessage(chatId, "برای تکمیل، روی کار موردنظر بزن:", { reply_markup: { inline_keyboard } });
  }
  const add = text.match(/^\/add(?:\s+)(.{1,180})$/s);
  if (add) {
    return await addTask(userId, data, tasks, add[1], chatId);
  }
  const done = text.match(/^\/done(?:\s+)(\d+)$/);
  if (done) {
    const task = tasks.find((item) => String(item.id) === done[1]);
    if (!task) return await sendMessage(chatId, "کاری با این شناسه پیدا نشد. با /tasks فهرست را ببین.");
    task.done = true;
    data.tasks = tasks;
    await saveDashboard(userId, data);
    return await sendMessage(chatId, "کار تکمیل شد.");
  }
  if (/^(📊 گزارش|\/report)(?:\s|$)/.test(text)) {
    const doneCount = tasks.filter((task) => task.done).length;
    return await sendMessage(chatId, `گزارش LIFEOS: ${doneCount} کار انجام‌شده، ${tasks.length - doneCount} کار باز.`);
  }
  const reminderArgument = text.match(/^\/remind\s+(.{1,220})$/s);
  if (text === "⏰ یادآور" || text === "/remind") {
    return await sendMessage(chatId, ADD_REMINDER_PROMPT, { reply_markup: { force_reply: true, selective: true, input_field_placeholder: "عنوان | تاریخ | ساعت" } });
  }
  if (reminderArgument) return await addScheduleItem(userId, data, "reminders", reminderArgument[1], chatId);

  const noteArgument = text.match(/^\/note\s+(.{1,2100})$/s);
  if (text === "📝 یادداشت" || text === "/note") {
    return await sendMessage(chatId, ADD_NOTE_PROMPT, { reply_markup: { force_reply: true, selective: true, input_field_placeholder: "عنوان | متن یادداشت" } });
  }
  if (noteArgument) return await addNote(userId, data, noteArgument[1], chatId);

  if (text === "🧠 یادداشت‌ها" || text === "/recall") return await sendRecall(data, chatId);
  if (text === "🗓 تقویم" || text === "/cal") return await sendCalendar(data, chatId);

  const eventArgument = text.match(/^\/event\s+(.{1,220})$/s);
  if (text === "📌 رویداد" || text === "/event") {
    return await sendMessage(chatId, ADD_EVENT_PROMPT, { reply_markup: { force_reply: true, selective: true, input_field_placeholder: "عنوان | تاریخ | ساعت" } });
  }
  if (eventArgument) return await addScheduleItem(userId, data, "events", eventArgument[1], chatId);

  const researchArgument = text.match(/^\/research\s+(.{1,1200})$/s);
  if (text === "🔎 تحقیق" || text === "/research") {
    return await sendMessage(chatId, RESEARCH_PROMPT, { reply_markup: { force_reply: true, selective: true, input_field_placeholder: "پرسشت را بنویس" } });
  }
  if (researchArgument) return await sendMessage(chatId, await answerWithOpenRouter(researchArgument[1]));
  if (text.startsWith("/")) return await sendMessage(chatId, "این فرمان رو نمی‌شناسم. /help را بفرست.");
  await sendMessage(chatId, await answerWithOpenRouter(text));
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(origin) });
  if (req.method !== "POST") return json({ error: "POST required" }, 405, origin);
  if (!SERVICE_KEY || !SUPABASE_URL) return json({ error: "Supabase function configuration is incomplete" }, 500, origin);

  if (req.headers.has("X-Telegram-Bot-Api-Secret-Token")) {
    if (!BOT_TOKEN || req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== await webhookSecret()) {
      return json({ error: "Unauthorized webhook" }, 401, origin);
    }
    try {
      const update = await req.json();
      if (update.message) {
        await ensureWebhookRegistered();
        await handleMessage(update.message);
      }
      if (update.callback_query) await handleCallbackQuery(update.callback_query);
      return json({ ok: true }, 200, origin);
    } catch (error) {
      console.error("Telegram update processing failed", String(error));
      return json({ error: "Update processing failed" }, 500, origin);
    }
  }

  const userId = await authenticate(req);
  if (!userId) return json({ error: "Sign in to LIFEOS first" }, 401, origin);
  try {
    const input = await req.json().catch(() => ({}));
    if (input.action === "link") {
      const link = await createLink(userId);
      return json({ link, bot: `https://t.me/${BOT_USERNAME}` }, 200, origin);
    }
    return json({ error: "Unknown action" }, 400, origin);
  } catch (error) {
    console.error("Telegram linking failed", String(error));
    return json({ error: error instanceof Error ? error.message : "Telegram setup failed" }, 500, origin);
  }
});

