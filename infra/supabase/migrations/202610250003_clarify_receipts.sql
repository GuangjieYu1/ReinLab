-- Global compatibility seed uses the established role_def shape; actual grants are frozen per run.
update role_def set prompt_ref='roles/research-clarify.md',tool_grants='{"literature":{"risk":"read","permission":"allow"},"question":{"risk":"read","permission":"allow"}}' where id='research-clarify';
-- Retain the usage proof even if the account process never receives the buffered response.
alter table clarify_model_request add response_receipt jsonb check(response_receipt is null or jsonb_typeof(response_receipt)='object');
