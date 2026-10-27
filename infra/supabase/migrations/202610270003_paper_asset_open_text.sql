-- 公开可得但未写许可的全文也应保存：许可为空照实存 null，不因此降级为只有摘要。
alter table paper_asset drop constraint paper_asset_check;
alter table paper_asset add constraint paper_asset_check
  check (status <> 'full_text' or (is_open_access and sha256 is not null));
