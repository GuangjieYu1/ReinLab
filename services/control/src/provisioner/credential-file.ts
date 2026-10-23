import { z } from "zod";
import { Tokens } from "./runtime";
export const ACCOUNT_CREDENTIAL_PATH = "/run/reinlab-source/account.json";
export const accountCredentialFiles = (
  accountId: string,
  tokens: z.infer<typeof Tokens>,
) => {
  z.string().uuid().parse(accountId);
  Tokens.parse(tokens);
  return [
    {
      guest_path: ACCOUNT_CREDENTIAL_PATH,
      raw_value: Buffer.from(
        JSON.stringify({
          schema: "account_credentials@1",
          accountId,
          ...tokens,
        }),
      ).toString("base64"),
    },
  ];
};
export function tokensFromFiles(files: unknown, accountId: string) {
  const rows = z
    .array(
      z
        .object({
          guest_path: z.literal(ACCOUNT_CREDENTIAL_PATH),
          raw_value: z.string().max(4096),
        })
        .strict(),
    )
    .length(1)
    .parse(files);
  const raw = rows[0].raw_value;
  if (Buffer.from(raw, "base64").toString("base64") !== raw)
    throw Error("ACCOUNT_CREDENTIALS_INVALID");
  const value = z
    .object({
      schema: z.literal("account_credentials@1"),
      accountId: z.literal(accountId),
      ...Tokens.shape,
    })
    .strict()
    .parse(JSON.parse(Buffer.from(raw, "base64").toString("utf8")));
  return Tokens.parse({ auth: value.auth, container: value.container });
}
export function sameCredentialFiles(actual: unknown, expected: unknown) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}
