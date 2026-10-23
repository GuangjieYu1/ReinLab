export type AccountCredentials = Readonly<{ schema: "account_credentials@1"; accountId: string; auth: string; container: string }>;
export function readAccountCredentials(file: string, options: { accountId: string; owner?: number; parentOwner?: number }): AccountCredentials;

export function writeRuntimeAccountCredentials(file:string,credentials:AccountCredentials):void;
