-- =============================================================================
-- 0016_subscribers.sql — 邮件订阅（T7.8），双重确认（double opt-in）
--
--  * subscribers：邮箱 + 语言（zh / en）+ 状态（pending 待确认 → confirmed 已订阅 → unsubscribed 已退订）。
--    任何人（含 anon / authenticated / 版主 / 管理员）都不能直接读写这张表：只有本迁移的 RPC 能动它。
--    管理员只能经 admin_subscriber_counts() 看按状态 / 语言的数量，**没有任何接口能列出或导出邮箱**。
--  * 不存明文令牌：
--      - 确认令牌：Vercel Function 生成 32 字节随机数（64 hex），只写进确认邮件；表里存 sha256(令牌)，48 小时有效，用过即清空；
--      - 退订令牌：HMAC-SHA256(COMMUNITY_TICKET_SECRET, 'unsubscribe|' || 邮箱)，由 Function（以后发通讯时同样）算出，
--        表里只存 sha256(令牌)。所以以后群发时不需要、也不保存任何明文令牌。
--  * 提交入口与留言板相同：浏览器 → /api/subscribe（服务端校验 Turnstile）→ 签发 HMAC 票据 → subscribe_request()。
--    票据核对 / 一次性 / 限流复用 0015 的 az_community_ticket / az_community_limit（kind = 'subscribe'：
--    每个访客 3 次 / 小时、10 次 / 天）；同一邮箱 10 分钟内不重复发确认信；待确认队列上限 2000。
--  * 不泄露邮箱是否已订阅：已确认的邮箱再次提交返回 send = false，Function 对访客的回答与新订阅完全相同。
--  * 确认 / 退订：静态页面 /subscribe/confirm/、/subscribe/unsubscribe/ 带令牌调用 subscribe_confirm() / subscribe_unsubscribe()
--    （anon 可调用；令牌 256 位随机 / HMAC，无法枚举）。
--
-- 依赖 0015（private.app_settings 里的 community_ticket_secret 与票据函数）。纯增量、可重复执行；不改任何已有表。
-- 生产启用步骤见 docs/MIGRATION.md §5E（邮件服务商环境变量未配置时 /api/subscribe 返回 503，什么都不发、什么都不存）。
-- =============================================================================

begin;

create table if not exists public.subscribers (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  lang text not null default 'zh',
  status text not null default 'pending',
  confirm_hash text,
  confirm_expires_at timestamptz,
  unsubscribe_hash text not null,
  created_at timestamptz not null default now(),
  last_sent_at timestamptz,
  confirmed_at timestamptz,
  unsubscribed_at timestamptz,
  constraint subscribers_email_check check (char_length(email) between 6 and 254 and email = lower(btrim(email))
                                            and email ~ '^[a-z0-9._%+-]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
  constraint subscribers_lang_check check (lang in ('zh', 'en')),
  constraint subscribers_status_check check (status in ('pending', 'confirmed', 'unsubscribed')),
  constraint subscribers_confirm_hash_check check (confirm_hash is null or confirm_hash ~ '^[0-9a-f]{64}$'),
  constraint subscribers_unsubscribe_hash_check check (unsubscribe_hash ~ '^[0-9a-f]{64}$')
);
create unique index if not exists subscribers_email_idx on public.subscribers (email);
create unique index if not exists subscribers_confirm_hash_idx on public.subscribers (confirm_hash)
  where confirm_hash is not null;
create index if not exists subscribers_unsubscribe_hash_idx on public.subscribers (unsubscribe_hash);
create index if not exists subscribers_status_idx on public.subscribers (status, lang);

-- ------------------------------------------------------- privileges + RLS ---
revoke all on public.subscribers from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.subscribers from anon, authenticated';
  end if;
end $$;
-- RLS 开启且没有任何策略：即使以后误授了表权限，anon / authenticated 也读不到任何一行
-- （不用 FORCE：RPC 以表所有者身份运行，需要绕过 RLS）
alter table public.subscribers enable row level security;

-- ---------------------------------------------------------------- RPCs ------
-- 令牌 → sha256 hex（与 Function 里 createHash('sha256') 一致）
create or replace function public.az_token_hash(p_token text)
 returns text
 language sql
 immutable
 set search_path to 'public', 'extensions', 'pg_temp'
as $$
  select encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
$$;

create or replace function public.subscribe_request(p_email text, p_lang text, p_confirm_hash text,
                                                   p_unsubscribe_hash text, p_ticket text)
 returns jsonb
 language plpgsql
 volatile security definer
 set search_path to 'public', 'pg_temp'
as $$
declare
  e text := lower(btrim(coalesce(p_email, '')));
  l text := coalesce(p_lang, 'zh');
  client text;
  cur public.subscribers%rowtype;
begin
  if char_length(e) not between 6 and 254
     or e !~ '^[a-z0-9._%+-]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' then
    raise exception '邮箱地址格式不正确' using errcode = '22023';
  end if;
  if l not in ('zh', 'en') then
    raise exception '语言不正确' using errcode = '22023';
  end if;
  if coalesce(p_confirm_hash, '') !~ '^[0-9a-f]{64}$' or coalesce(p_unsubscribe_hash, '') !~ '^[0-9a-f]{64}$' then
    raise exception '令牌格式不正确' using errcode = '22023';
  end if;
  client := public.az_community_ticket('subscribe', e || E'\n' || l, p_ticket);
  perform pg_advisory_xact_lock(hashtextextended('subscribe:' || e, 0));
  perform public.az_community_limit('subscribe', client, 3, interval '1 hour');
  perform public.az_community_limit('subscribe', client, 10, interval '1 day');

  select * into cur from public.subscribers where email = e for update;
  if not found then
    if (select count(*) from public.subscribers where status = 'pending') >= 2000 then
      raise exception 'queue_full' using errcode = 'PT429', hint = '订阅请求太多了，请过一阵再来。';
    end if;
    insert into public.subscribers (email, lang, confirm_hash, confirm_expires_at, unsubscribe_hash, last_sent_at)
    values (e, l, p_confirm_hash, now() + interval '48 hours', p_unsubscribe_hash, now());
    return jsonb_build_object('send', true);
  end if;
  if cur.status = 'confirmed' then
    -- 已订阅：不再发信，也不告诉访客（Function 返回与新订阅相同的提示）
    return jsonb_build_object('send', false);
  end if;
  if cur.status = 'pending' and cur.last_sent_at > now() - interval '10 minutes' then
    return jsonb_build_object('send', false);
  end if;
  update public.subscribers
     set status = 'pending', lang = l, confirm_hash = p_confirm_hash,
         confirm_expires_at = now() + interval '48 hours', unsubscribe_hash = p_unsubscribe_hash,
         last_sent_at = now(), unsubscribed_at = null
   where id = cur.id;
  return jsonb_build_object('send', true);
end
$$;

create or replace function public.subscribe_confirm(p_token text)
 returns jsonb
 language plpgsql
 volatile security definer
 set search_path to 'public', 'pg_temp'
as $$
declare
  h text;
  l text;
begin
  if coalesce(p_token, '') !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('status', 'invalid');
  end if;
  h := public.az_token_hash(p_token);
  update public.subscribers
     set status = 'confirmed', confirmed_at = now(), confirm_hash = null, confirm_expires_at = null
   where confirm_hash = h and status = 'pending' and confirm_expires_at > now()
  returning lang into l;
  if l is not null then
    return jsonb_build_object('status', 'confirmed', 'lang', l);
  end if;
  if exists (select 1 from public.subscribers where confirm_hash = h) then
    return jsonb_build_object('status', 'expired');
  end if;
  return jsonb_build_object('status', 'invalid');
end
$$;

create or replace function public.subscribe_unsubscribe(p_token text)
 returns jsonb
 language plpgsql
 volatile security definer
 set search_path to 'public', 'pg_temp'
as $$
declare
  h text;
  l text;
begin
  if coalesce(p_token, '') !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('status', 'invalid');
  end if;
  h := public.az_token_hash(p_token);
  update public.subscribers
     set status = 'unsubscribed', unsubscribed_at = now(), confirm_hash = null, confirm_expires_at = null
   where unsubscribe_hash = h and status <> 'unsubscribed'
  returning lang into l;
  if l is not null or exists (select 1 from public.subscribers where unsubscribe_hash = h) then
    -- 重复点击退订链接也是成功（幂等）
    return jsonb_build_object('status', 'unsubscribed');
  end if;
  return jsonb_build_object('status', 'invalid');
end
$$;

-- 后台：只有数量（按状态 × 语言），没有邮箱
create or replace function public.admin_subscriber_counts()
 returns table (status text, lang text, n bigint)
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $$
begin
  perform public.az_require_admin();
  return query
    select s.status, s.lang, count(*)::bigint from public.subscribers s group by s.status, s.lang
    order by s.status, s.lang;
end
$$;

-- ------------------------------------------------------------ execute -------
revoke execute on function public.az_token_hash(text), public.subscribe_request(text, text, text, text, text),
  public.subscribe_confirm(text), public.subscribe_unsubscribe(text), public.admin_subscriber_counts() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function public.az_token_hash(text) from anon, authenticated';
    execute 'grant execute on function public.subscribe_request(text, text, text, text, text), public.subscribe_confirm(text), public.subscribe_unsubscribe(text) to anon, authenticated';
    execute 'revoke execute on function public.admin_subscriber_counts() from anon';
    execute 'grant execute on function public.admin_subscriber_counts() to authenticated';
  end if;
end $$;

commit;
