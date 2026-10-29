-- 第 6 节补名：用已下载论文的元数据标题替换占位名（只补 placeholder）。
update dossier d set title = p.title, name_source = 'paper', version = d.version + 1
  from (select distinct on (a.dossier_id) a.dossier_id, a.view_metadata->>'title' title
          from paper_asset a
         where coalesce(a.view_metadata->>'title','') <> ''
         order by a.dossier_id, a.created_at desc) p
 where d.id = p.dossier_id
   and d.name_source = 'placeholder'
   and length(p.title) between 1 and 200;

-- 最近活动按真实事件/运行回填，不再用迁移时间。
update dossier d set last_activity_at = coalesce(t.at, d.created_at)
  from (select x.dossier_id,
               greatest(max(x.ev_at), max(x.run_at)) at
          from (select dossier_id, max(at) ev_at, null::timestamptz run_at from event
                 where dossier_id is not null group by dossier_id
                union all
                select dossier_id, null, max(coalesce(ended_at, created_at)) from run
                 where dossier_id is not null group by dossier_id) x
         group by x.dossier_id) t
 where d.id = t.dossier_id and t.at is not null;
