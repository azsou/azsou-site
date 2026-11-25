-- CI-only article read models, never install this file on a hosted database.
-- One station-only state view; one public test fixture, never a catalog or a public draft reader.
begin;
do $fixture$
begin
  if current_database() !~ '^azsou_test_cmsarticle_[0-9]+$'
     or pg_catalog.pg_is_in_recovery() or pg_catalog.getdatabaseencoding() <> 'UTF8'
     or pg_catalog.to_regclass('private.cms_article_items') is null
     or pg_catalog.to_regclass('private.cms_article_revisions') is null
     or pg_catalog.to_regclass('private.cms_article_release_events') is null
     or pg_catalog.to_regprocedure('public.az_cms_transition_article_release(text,text,integer,integer,uuid)') is null then
    raise exception using errcode='22023', message='requires the disposable SB09 release database';
  end if;
end;
$fixture$;

create function public.az_cms_read_article_release_state(p_slug text)
returns table (item_id uuid, draft_revision integer, release_version integer, phase text,
               reviewed_revision integer, published_revision integer)
language plpgsql stable security definer set search_path = '' as $state$
declare
  v_id uuid;
  v_draft integer;
  v_live integer;
  v_version integer;
  v_phase text;
  v_review_candidate integer;
  v_history_live integer;
begin
  if auth.uid() is null or public.is_admin() is not true or public.can_write() is not true then
    raise exception using errcode='42501', message='unrestricted station administrator required';
  end if;
  if p_slug is null or length(p_slug) not between 1 and 80 or p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
    raise exception using errcode='22023', message='invalid article identifier';
  end if;
  -- Stable function: item pointers and latest receipt come from the same statement snapshot.
  select a.id,a.draft_revision,a.published_revision,e.release_version,e.phase,e.expected_draft,e.published_revision
    into v_id,v_draft,v_live,v_version,v_phase,v_review_candidate,v_history_live
    from private.cms_article_items as a
    left join lateral (
      select x.release_version,x.phase,x.expected_draft,x.published_revision
        from private.cms_article_release_events as x where x.item_id=a.id
        order by x.release_version desc limit 1
    ) as e on true
    where a.slug=p_slug;
  if not found then return; end if;
  if v_draft is null or v_live is distinct from v_history_live then
    raise exception using errcode='PT409', message='release history and article pointers disagree';
  end if;
  return query select v_id,v_draft,coalesce(v_version,0),coalesce(v_phase,'draft'::text),
    case when v_phase='review' then v_review_candidate else null::integer end,v_live;
end;
$state$;
revoke all on function public.az_cms_read_article_release_state(text) from public, anon, authenticated, service_role;
grant execute on function public.az_cms_read_article_release_state(text) to authenticated;

-- The output is JSON data over PostgREST; body_text is UNTRUSTED plain text, not safe HTML.
-- A future Preview-only UI must escape it and must not cache it or fall back to a draft.
-- Sign-in never widens this projection. Non-canary / never-published / withdrawn: all return zero rows.
create function public.az_cms_read_published_article_canary(p_slug text)
returns table (slug text, revision integer, title text, body_text text)
language sql stable security definer set search_path = '' as $visitor$
  select a.slug,r.revision,r.fields->>'title',r.body_source
    from private.cms_article_items as a
    join lateral (
      select x.published_revision,x.phase from private.cms_article_release_events as x
        where x.item_id=a.id order by x.release_version desc limit 1
    ) as latest on latest.published_revision=a.published_revision and latest.phase in ('published','review')
    join private.cms_article_revisions as r on r.item_id=a.id and r.revision=a.published_revision
    where p_slug='sb09-release-check-8ce16f5f' and a.slug=p_slug and a.published_revision is not null
      and exists (select 1 from private.cms_article_release_events as prior
        where prior.item_id=a.id and prior.action='publish' and prior.published_revision=r.revision);
$visitor$;
revoke all on function public.az_cms_read_published_article_canary(text) from public, anon, authenticated, service_role;
grant execute on function public.az_cms_read_published_article_canary(text) to anon, authenticated;
commit;
