export class ApiFailure extends Error {
  /** extra 会原样并进错误体（如 tombstone / latest），页面据此显示。 */
  constructor(
    readonly code: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 500 | 501 | 503,
    message: string,
    readonly extra?: Record<string, unknown>,
  ) { super(message); }
}
export const denied = () => new ApiFailure('RLS_DENIED',404,'档案不存在，或你无权访问。');
