create extension if not exists pg_cron;
create extension if not exists pg_net;

create table if not exists public.lifeos_reminder_deliveries (
  user_id uuid not null references auth.users(id) on delete cascade,
  reminder_id text not null,
  reminder_date date not null,
  reminder_time text not null,
  timezone text not null,
  state text not null default 'sending' check (state in ('sending', 'sent', 'failed')),
  attempts integer not null default 1,
  attempted_at timestamptz not null default now(),
  sent_at timestamptz,
  last_error text,
  primary key (user_id, reminder_id, reminder_date, reminder_time, timezone)
);
alter table public.lifeos_reminder_deliveries enable row level security;
revoke all on public.lifeos_reminder_deliveries from anon, authenticated;
grant all on public.lifeos_reminder_deliveries to service_role;

create or replace function public.validate_lifeos_reminder_cron(p_token text)
returns boolean language sql security definer set search_path = ''
as $$
  select exists (select 1 from vault.decrypted_secrets
    where name = 'lifeos_reminder_cron_token' and decrypted_secret = p_token);
$$;
revoke all on function public.validate_lifeos_reminder_cron(text) from public, anon, authenticated;
grant execute on function public.validate_lifeos_reminder_cron(text) to service_role;

create or replace function public.claim_lifeos_reminder_delivery(
  p_user_id uuid, p_reminder_id text, p_reminder_date date, p_reminder_time text, p_timezone text
)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare v_claimed boolean := false;
begin
  insert into public.lifeos_reminder_deliveries as delivery
    (user_id, reminder_id, reminder_date, reminder_time, timezone)
  values (p_user_id, p_reminder_id, p_reminder_date, p_reminder_time, p_timezone)
  on conflict (user_id, reminder_id, reminder_date, reminder_time, timezone)
  do update set state = 'sending', attempts = delivery.attempts + 1,
    attempted_at = now(), sent_at = null, last_error = null
  where (delivery.state = 'failed' and delivery.attempts < 5)
     or (delivery.state = 'sending' and delivery.attempted_at < now() - interval '10 minutes' and delivery.attempts < 5)
  returning true into v_claimed;
  return coalesce(v_claimed, false);
end;
$$;
revoke all on function public.claim_lifeos_reminder_delivery(uuid, text, date, text, text) from public, anon, authenticated;
grant execute on function public.claim_lifeos_reminder_delivery(uuid, text, date, text, text) to service_role;

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'lifeos_reminder_project_url') then
    perform vault.create_secret('https://yjvrxgvvixqgazuvvhxy.supabase.co', 'lifeos_reminder_project_url', 'Supabase project URL for LIFEOS reminder scheduling');
  end if;
  if not exists (select 1 from vault.secrets where name = 'lifeos_reminder_publishable_key') then
    perform vault.create_secret('sb_publishable_4u6Y7rNj52SooFuMKQDvaQ_gg6FYKSm', 'lifeos_reminder_publishable_key', 'Publishable API key for LIFEOS reminder scheduling');
  end if;
  if not exists (select 1 from vault.secrets where name = 'lifeos_reminder_cron_token') then
    perform vault.create_secret(gen_random_uuid()::text || gen_random_uuid()::text, 'lifeos_reminder_cron_token', 'Private token for LIFEOS reminder scheduler');
  end if;
end
$$;

select cron.unschedule(jobid) from cron.job where jobname = 'lifeos-telegram-reminders';
select cron.schedule('lifeos-telegram-reminders', '* * * * *', $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'lifeos_reminder_project_url') || '/functions/v1/telegram-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'lifeos_reminder_publishable_key'),
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'lifeos_reminder_publishable_key'),
      'x-lifeos-cron-token', (select decrypted_secret from vault.decrypted_secrets where name = 'lifeos_reminder_cron_token')
    ),
    body := '{}'::jsonb
  );
$job$);
