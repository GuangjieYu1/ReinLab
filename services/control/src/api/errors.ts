export class ApiFailure extends Error {
  constructor(readonly code: string, readonly status: 400|401|403|404|409|413|500|501|503, message: string) { super(message); }
}
export const denied = () => new ApiFailure('RLS_DENIED',404,'档案不存在，或你无权访问。');
