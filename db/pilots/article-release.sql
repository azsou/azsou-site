-- SB09 CI-only, not a migration. There is no public reader or renderer here.
-- No hosted installation, permanent deletion, scheduling, content export or search/cache side effects.
begin;
do $guard$
begin
  if current_database() !~ '^azsou_test_cmsarticle_[0-9]+$' or pg_catalog.pg_is_in_recovery()
     or pg_catalog.getdatabaseencoding() <> 'UTF8'
     or to_regclass('private.cms_article_items') is null or to_regclass('private.cms_article_revisions') is null
     or to_regprocedure('public.az_cms_save_article_draft(text,integer,jsonb,text)') is null then
    raise exception using errcode = '22023', message = 'requires the disposable SB03 article fixture';
  end if;
end;
$guard$;

-- This log is private. The latest event supplies the independently versioned publication state.
create table private.cms_article_release_events (
  item_id uuid not null references private.cms_article_items(id),
  operation_id uuid not null,
  actor_id uuid not null,
  action text not null check (action in ('submit_review','publish','withdraw','restore_review')),
  expected_draft integer not null check (expected_draft > 0),
  expected_release integer not null check (expected_release >= 0),
  release_version integer not null check (release_version = expected_release + 1),
  phase text not null check (phase in ('review','published','withdrawn')),
  published_revision integer check (published_revision > 0),
  recorded_at timestamptz not null default pg_catalog.statement_timestamp(),
  primary key (item_id, operation_id),
  unique (item_id, release_version),
  foreign key (item_id, expected_draft) references private.cms_article_revisions(item_id, revision),
  foreign key (item_id, published_revision) references private.cms_article_revisions(item_id, revision),
  check (phase = case when action='publish' then 'published' when action='withdraw' then 'withdrawn' else 'review' end),
  check (action <> 'publish' or (published_revision is not null and published_revision=expected_draft)),
  check (action not in ('withdraw','restore_review') or published_revision is null)
);
alter table private.cms_article_release_events enable row level security;
revoke all on table private.cms_article_release_events from public, anon, authenticated, service_role;

create function public.az_cms_transition_article_release(
  p_slug text, p_action text, p_expected_draft integer, p_expected_release integer, p_operation_id uuid
) returns table (item_id uuid, release_version integer, phase text, published_revision integer)
language plpgsql security definer set search_path = '' as $fn$
declare
  v_actor uuid := auth.uid();
  v_item uuid;
  v_head integer;
  v_live integer;
  v_generation integer := 0;
  v_previous_phase text := 'draft';
  v_last_draft integer;
  v_history private.cms_article_release_events%rowtype;
  v_replay private.cms_article_release_events%rowtype;
  v_phase text;
  v_new_live integer;
  v_fields jsonb;
  v_body text;
  v_known text[] := array['art','author','badge','category','date','forumThread','lastChecked','ogImage','order','pinyin','readingMinutes','tags','title','toc'];
  -- Raw text blankness: the ECMAScript trim character set, explicitly independent of database locale.
  -- This check does not sanitize or interpret HTML or rewrite stored drafts.
  v_blank constant text := U&'\0009\000a\000b\000c\000d\0020\00a0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200a\2028\2029\202f\205f\3000\feff';
  v_minutes numeric;
  v_order numeric;
begin
  if v_actor is null or public.is_admin() is not true or public.can_write() is not true then
    raise exception using errcode='42501', message='unrestricted station administrator required';
  end if;
  if p_slug is null or length(p_slug) not between 1 and 80 or p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    or p_action is null or p_action not in ('submit_review','publish','withdraw','restore_review')
    or p_expected_draft is null or p_expected_draft <= 0 or p_expected_release is null or p_expected_release < 0
    or p_operation_id is null then
    raise exception using errcode='22023', message='invalid release request';
  end if;

  -- The draft-save RPC locks this same item. Never insert a missing item as part of a release.
  select a.id, a.draft_revision, a.published_revision into v_item, v_head, v_live
    from private.cms_article_items a where a.slug=p_slug for update;
  if not found then raise exception using errcode='PT404', message='article not found'; end if;

  -- Authorization precedes replay. A valid replay returns the original result, without reapplying it.
  select e.* into v_replay from private.cms_article_release_events e
    where e.item_id=v_item and e.operation_id=p_operation_id;
  if found then
    if v_replay.actor_id is distinct from v_actor or v_replay.action is distinct from p_action
      or v_replay.expected_draft is distinct from p_expected_draft or v_replay.expected_release is distinct from p_expected_release then
      raise exception using errcode='PT409', message='release operation key already used for a different request';
    end if;
    return query select v_item, v_replay.release_version, v_replay.phase, v_replay.published_revision;
    return;
  end if;

  select e.* into v_history from private.cms_article_release_events e where e.item_id=v_item
    order by e.release_version desc limit 1;
  if found then
    if v_history.published_revision is distinct from v_live then
      raise exception using errcode='PT409', message='publication pointer and audit disagree';
    end if;
    v_generation := v_history.release_version;
    v_previous_phase := v_history.phase;
    v_last_draft := v_history.expected_draft;
  elsif v_live is not null then
    raise exception using errcode='PT409', message='existing publication lacks release history';
  end if;
  if p_expected_draft is distinct from v_head or p_expected_release is distinct from v_generation then
    raise exception using errcode='PT409', message='article draft or release generation changed';
  end if;
  v_new_live := v_live;

  case p_action
    when 'submit_review' then
      if v_previous_phase='withdrawn' or (v_previous_phase='review' and v_last_draft=v_head)
        or (v_previous_phase='published' and v_live=v_head) then
        raise exception using errcode='PT409', message='no new draft to submit, or restore is required';
      end if;
      v_phase := 'review';
    when 'withdraw' then
      if v_live is null then raise exception using errcode='PT409', message='no revision is published'; end if;
      v_phase := 'withdrawn'; v_new_live := null;
    when 'restore_review' then
      if v_previous_phase <> 'withdrawn' or v_live is not null then
        raise exception using errcode='PT409', message='only a withdrawn article can be restored to review';
      end if;
      v_phase := 'review'; v_new_live := null;
    when 'publish' then
      if v_previous_phase <> 'review' or v_last_draft is distinct from v_head then
        raise exception using errcode='PT409', message='this revision must be reviewed explicitly';
      end if;
      select r.fields, r.body_source into strict v_fields, v_body from private.cms_article_revisions r
        where r.item_id=v_item and r.revision=v_head;
      -- This narrow fixture accepts exactly the known 14-field pilot. Reject optional/new fields rather
      -- than silently dropping or exposing them. Public HTML safety and delivery are separate SB10 work.
      if (v_fields ?& v_known) is not true or (v_fields - v_known) <> '{}'::jsonb or pg_catalog.btrim(v_body, v_blank)=''
        or exists (select 1 from unnest(array['title','category','badge','author','date','lastChecked','ogImage','pinyin']) k(n)
          where jsonb_typeof(v_fields->k.n) is distinct from 'string')
        or pg_catalog.btrim(v_fields->>'title', v_blank)='' or pg_catalog.btrim(v_fields->>'author', v_blank)='' or pg_catalog.btrim(v_fields->>'category', v_blank)=''
        or (v_fields->>'date') !~ '^[0-9]{4}-[0-9]{2}(-[0-9]{2})?$'
        or (v_fields->>'lastChecked') !~ '^[0-9]{4}-[0-9]{2}(-[0-9]{2})?$'
        or (v_fields->>'ogImage') !~ '^/[^/]'
        or jsonb_typeof(v_fields->'art') not in ('string','null') or jsonb_typeof(v_fields->'forumThread') not in ('string','null')
        or jsonb_typeof(v_fields->'tags') is distinct from 'array' or jsonb_typeof(v_fields->'toc') is distinct from 'array'
        or jsonb_typeof(v_fields->'order') is distinct from 'number' or jsonb_typeof(v_fields->'readingMinutes') is distinct from 'number' then
        raise exception using errcode='22023', message='article not ready for the limited release pilot';
      end if;
      -- Match src/lib/zh-length.ts and the article collection's 36-unit title cap.
      -- In UTF8, ascii(ch) is the code point. Every character costs at least one half-unit,
      -- so even a long input can be decided from its first 73 characters.
      if (
        select coalesce(sum(case when pg_catalog.ascii(c.ch) < 256 then 1 else 2 end), 0)
          from pg_catalog.unnest(pg_catalog.string_to_array(pg_catalog.left(v_fields->>'title', 73), null::text)) as c(ch)
      ) > 72 then
        raise exception using errcode='22023', message='article title exceeds the 36-unit article layout budget';
      end if;
      v_minutes := (v_fields->>'readingMinutes')::numeric; v_order := (v_fields->>'order')::numeric;
      if v_minutes <> trunc(v_minutes) or v_minutes not between 1 and 9007199254740991
        or v_order <> trunc(v_order) or abs(v_order) > 9007199254740991
        or exists (select 1 from jsonb_array_elements(v_fields->'toc') x(v) where jsonb_typeof(x.v)<>'string')
        or exists (select 1 from jsonb_array_elements(v_fields->'tags') x(v)
          where jsonb_typeof(x.v)<>'string' or (x.v #>> '{}') !~ '^[a-z0-9-]+$') then
        raise exception using errcode='22023', message='invalid release metadata in the limited pilot';
      end if;
      v_phase := 'published'; v_new_live := v_head;
  end case;

  if v_new_live is distinct from v_live then
    update private.cms_article_items a set published_revision=v_new_live where a.id=v_item;
  end if;
  insert into private.cms_article_release_events(item_id,operation_id,actor_id,action,expected_draft,expected_release,release_version,phase,published_revision)
    values(v_item,p_operation_id,v_actor,p_action,v_head,v_generation,v_generation+1,v_phase,v_new_live);
  return query select v_item, v_generation+1, v_phase, v_new_live;
end;
$fn$;
revoke all on function public.az_cms_transition_article_release(text,text,integer,integer,uuid) from public, anon, authenticated, service_role;
grant execute on function public.az_cms_transition_article_release(text,text,integer,integer,uuid) to authenticated;
commit;
