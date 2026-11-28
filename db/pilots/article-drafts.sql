-- SB03 article pilot. NOT part of db/migrations. Only the disposable CI database may run this file.
-- No actual content, publish endpoint, public reading route, or existing business-table changes.
begin;

do $guard$
begin
  if current_database() !~ '^azsou_test_cmsarticle_[0-9]+$' then
    raise exception using errcode = '22023', message = 'article draft pilot needs its disposable test database';
  end if;
end;
$guard$;

create table private.cms_article_items (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (length(slug) between 1 and 80 and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  draft_revision integer check (draft_revision > 0),
  published_revision integer check (published_revision > 0)
);

create table private.cms_article_revisions (
  item_id uuid not null references private.cms_article_items(id),
  revision integer not null check (revision > 0),
  fields jsonb not null check (jsonb_typeof(fields) = 'object'),
  body_source text not null,
  saved_by uuid not null,
  saved_at timestamptz not null default now(),
  primary key (item_id, revision)
);

-- Both pointers must reference a revision of this same item. A draft save never changes published_revision.
alter table private.cms_article_items
  add foreign key (id, draft_revision) references private.cms_article_revisions(item_id, revision),
  add foreign key (id, published_revision) references private.cms_article_revisions(item_id, revision);

alter table private.cms_article_items enable row level security;
alter table private.cms_article_revisions enable row level security;
revoke all on table private.cms_article_items, private.cms_article_revisions
  from public, anon, authenticated, service_role;

-- p_fields round-trips the article metadata, including optional fields. A private draft may be incomplete.
-- body_source is untrusted editing input. This pilot deliberately provides NO public HTML renderer.
create function public.az_cms_save_article_draft(
  p_slug text, p_expected_revision integer, p_fields jsonb, p_body_source text
) returns table (item_id uuid, revision integer)
language plpgsql security definer set search_path = '' as $fn$
declare
  v_actor uuid := auth.uid();
  v_item uuid;
  v_head integer;
  v_next integer;
begin
  if v_actor is null or public.is_admin() is not true then
    raise exception using errcode = '42501', message = 'admin required';
  end if;
  if p_slug is null or length(p_slug) not between 1 and 80 or p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
     or p_expected_revision is null or p_expected_revision < 0
     or jsonb_typeof(p_fields) is distinct from 'object'
     or jsonb_typeof(p_fields -> 'title') is distinct from 'string'
     or btrim(p_fields ->> 'title') = '' or p_body_source is null then
    raise exception using errcode = '22023', message = 'invalid article draft';
  end if;

  insert into private.cms_article_items (slug) values (p_slug) on conflict (slug) do nothing;
  select a.id, coalesce(a.draft_revision, 0) into strict v_item, v_head
    from private.cms_article_items as a where a.slug = p_slug for update;
  if v_head <> p_expected_revision then
    raise exception using errcode = 'PT409', message = 'article draft version conflict; reload before saving';
  end if;

  v_next := v_head + 1;
  insert into private.cms_article_revisions (item_id, revision, fields, body_source, saved_by)
    values (v_item, v_next, p_fields, p_body_source, v_actor);
  update private.cms_article_items as a set draft_revision = v_next where a.id = v_item;
  return query select v_item, v_next;
end;
$fn$;

create function public.az_cms_read_article_draft(p_slug text)
returns table (item_id uuid, revision integer, fields jsonb, body_source text)
language plpgsql stable security definer set search_path = '' as $fn$
begin
  if auth.uid() is null or public.is_admin() is not true then
    raise exception using errcode = '42501', message = 'admin required';
  end if;
  return query
    select a.id, r.revision, r.fields, r.body_source
      from private.cms_article_items as a
      join private.cms_article_revisions as r on r.item_id = a.id and r.revision = a.draft_revision
     where a.slug = p_slug;
end;
$fn$;

revoke all on function public.az_cms_save_article_draft(text, integer, jsonb, text),
                       public.az_cms_read_article_draft(text) from public, anon, authenticated, service_role;
grant execute on function public.az_cms_save_article_draft(text, integer, jsonb, text),
                          public.az_cms_read_article_draft(text) to authenticated;

commit;
