import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.0";
import { supabaseUrl, supabasePublishableKey } from "./supabase-config.js";

const supabase = createClient(supabaseUrl, supabasePublishableKey);
const gate = document.getElementById("authGate");
const form = document.getElementById("authForm");
const errorBox = document.getElementById("authError");
const nameField = document.getElementById("authNameField");
const nameInput = document.getElementById("authName");
let saveTimer;
const emptyDashboard = () => ({ tasks: [], notes: [], events: [], reminders: [], activity: [] });

window.lifeosSignOut = async () => {
  const { error } = await supabase.auth.signOut();
  if (error) {
    errorBox.textContent = error.message;
    throw error;
  }
};

window.lifeosUpdateName = async (value) => {
  const fullName = String(value ?? "").trim().slice(0, 60);
  if (!fullName) throw new Error("نام نمایشی را وارد کن.");
  if (!window.lifeosUser) throw new Error("برای ذخیرهٔ نام، ابتدا وارد حساب شو.");
  const { data, error } = await supabase.auth.updateUser({ data: { full_name: fullName, name: fullName } });
  if (error) throw error;
  window.lifeosUser = data.user;
  window.lifeosDisplayName = fullName;
  window.lifeosSetDisplayName?.(fullName);
  return fullName;
};

window.createLifeosTelegramLink = async () => {
  const { data, error } = await supabase.functions.invoke("telegram-bot", { body: { action: "link" } });
  if (error || !data?.link) throw new Error(data?.error || error?.message || "ساخت لینک اتصال تلگرام ناموفق بود.");
  return data.link;
};

window.connectLifeosTelegram = async () => {
  const out = document.getElementById("telegramStatus");
  if (!out) return;
  out.hidden = false;
  out.textContent = "در حال آماده‌کردن اتصال امن…";
  try {
    const link = await window.createLifeosTelegramLink();
    out.replaceChildren();
    const p = document.createElement("p");
    p.textContent = "لینک زیر را باز کن و در ربات Start را بزن تا حساب LIFEOS وصل شود. لینک تا ۱۰ دقیقه معتبر است.";
    const a = document.createElement("a");
    a.href = link;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.className = "btn btn-primary";
    a.textContent = "بازکردن @MassistantNbot";
    out.append(p, a);
  } catch (err) {
    out.textContent = err.message;
  }
};

window.askOpenRouter = async (prompt) => {
  const { data, error } = await supabase.functions.invoke("lifeos-ai", { body: { prompt } });
  if (error || data?.error) throw new Error(data?.error || error?.message || "ارتباط با OpenRouter برقرار نشد.");
  return data.answer;
};

window.persistLifeosCloud = (dashboardData) => {
  const user = window.lifeosUser;
  if (!user) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const { error } = await supabase.from("lifeos_dashboard_data").upsert({
      user_id: user.id,
      data: dashboardData,
      updated_at: new Date().toISOString(),
    });
    if (error) {
      errorBox.textContent = "ذخیره در فضای ابری ناموفق بود: " + error.message;
      console.error(error);
    }
  }, 400);
};

async function loadUser(user) {
  const app = document.querySelector(".app");
  window.lifeosUser = user;
  if (!user) {
    window.lifeosDisplayName = "";
    gate.hidden = false;
    if (app) app.style.visibility = "hidden";
    window.applyLifeosCloudData?.(emptyDashboard());
    return;
  }

  // Keep the previous account's dashboard hidden until the new user's data is loaded.
  gate.hidden = false;
  if (app) app.style.visibility = "hidden";
  errorBox.textContent = "";
  try {
    const { data: row, error } = await supabase
      .from("lifeos_dashboard_data")
      .select("data")
      .eq("user_id", user.id)
      .maybeSingle();
    if (error) throw error;

    const displayName = String(user.user_metadata?.full_name || user.user_metadata?.name || user.email?.split("@")[0] || "دوست").trim();
    window.lifeosDisplayName = displayName;
    window.lifeosSetDisplayName?.(displayName);
    // A first-time account starts with blank, ready-to-use lists; no demo/local data is copied.
    window.applyLifeosCloudData?.(row?.data || emptyDashboard());
    gate.hidden = true;
    if (app) app.style.visibility = "visible";
  } catch (err) {
    errorBox.textContent = "خطای اتصال به دیتابیس: " + err.message;
    gate.hidden = false;
    if (app) app.style.visibility = "hidden";
  }
}

const nameHelp = document.getElementById("authHelp");
form.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-mode]");
  if (!button) return;
  const signingUp = button.dataset.mode === "signup";
  nameField.hidden = !signingUp;
  nameInput.required = signingUp;
  if (nameHelp) nameHelp.textContent = signingUp
    ? "برای ساخت حساب، نامت را هم وارد کن تا در داشبورد با همان نام به تو سلام کنم."
    : "برای ادامه، وارد حساب خود شوید یا حساب جدید بسازید.";
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const mode = event.submitter?.dataset.mode || "login";
  const email = document.getElementById("authEmail").value.trim();
  const password = document.getElementById("authPassword").value;
  const fullName = nameInput.value.trim();
  errorBox.textContent = "";
  if (mode === "signup" && !fullName) {
    nameField.hidden = false;
    nameInput.required = true;
    nameInput.focus();
    errorBox.textContent = "نامت را وارد کن تا حسابت ساخته شود.";
    return;
  }

  const buttons = [...form.querySelectorAll("button[data-mode]")];
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const redirectTo = new URL(window.location.pathname, window.location.origin).href;
    const result = mode === "signup"
      ? await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: redirectTo, data: { full_name: fullName, name: fullName } },
        })
      : await supabase.auth.signInWithPassword({ email, password });
    if (result.error) throw result.error;
    if (mode === "signup" && !result.data.session) {
      errorBox.textContent = "حساب ساخته شد؛ برای ورود، پیام تأیید ارسال‌شده به ایمیلت را بررسی کن.";
    }
  } catch (err) {
    errorBox.textContent = /email rate limit exceeded/i.test(err.message)
      ? "محدودیت موقت ارسال ایمیل Supabase فعال است؛ کمی بعد دوباره تلاش کن."
      : err.message;
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
});

supabase.auth.onAuthStateChange((_event, session) => { void loadUser(session?.user || null); });
