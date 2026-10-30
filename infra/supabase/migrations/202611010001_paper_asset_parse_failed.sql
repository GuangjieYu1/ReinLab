-- 工作区登记的扫描版 PDF 抽不出文本层：它仍是这个档案里的一份真实论文，
-- 照实记 parse_failed，不入档成「只有摘要」（那会假装拿到了摘要）。
-- papers.pages 对非 full_text 的资产本来就只回 abstract_only、不读页，引用校验不变。
alter table paper_asset drop constraint paper_asset_status_check;
alter table paper_asset add constraint paper_asset_status_check
  check (status in ('full_text','abstract_only','parse_failed'));
