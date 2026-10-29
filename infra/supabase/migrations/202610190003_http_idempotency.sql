CREATE TABLE http_request (
  account_id uuid NOT NULL REFERENCES account(id),
  key_hash text NOT NULL CHECK(key_hash ~ '^[a-f0-9]{64}$'),
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  status integer NOT NULL CHECK(status BETWEEN 200 AND 299),
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(account_id,key_hash)
);
ALTER TABLE http_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE http_request FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON http_request TO reinlab_app
  USING(account_id = nullif(current_setting('app.account_id',true),'')::uuid)
  WITH CHECK(account_id = nullif(current_setting('app.account_id',true),'')::uuid);
GRANT SELECT,INSERT ON http_request TO reinlab_app;
REVOKE UPDATE,DELETE,TRUNCATE ON http_request FROM reinlab_app;
