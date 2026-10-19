/**
 * API error model, mirroring the public Stripe error shape:
 * { error: { type, code, decline_code, message, param, ... } }
 */
export type ErrorType =
  | 'api_error'
  | 'card_error'
  | 'idempotency_error'
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'rate_limit_error';

export class ApiError extends Error {
  status: number;
  type: ErrorType;
  code?: string;
  param?: string;
  declineCode?: string;
  extra: Record<string, unknown>;
  headers: Record<string, string>;

  constructor(
    status: number,
    type: ErrorType,
    message: string,
    opts: { code?: string; param?: string; declineCode?: string; extra?: Record<string, unknown>; headers?: Record<string, string> } = {},
  ) {
    super(message);
    this.status = status;
    this.type = type;
    this.code = opts.code;
    this.param = opts.param;
    this.declineCode = opts.declineCode;
    this.extra = opts.extra ?? {};
    this.headers = opts.headers ?? {};
  }

  toJSON() {
    const body: Record<string, unknown> = { type: this.type, message: this.message };
    if (this.code) body.code = this.code;
    if (this.declineCode) body.decline_code = this.declineCode;
    if (this.param) body.param = this.param;
    if (this.code) body.doc_url = `http://localhost/docs/error-codes/${this.code.replace(/_/g, '-')}`;
    Object.assign(body, this.extra);
    return { error: body };
  }
}

export const invalid = (message: string, param?: string, code = param ? 'parameter_invalid' : undefined) =>
  new ApiError(400, 'invalid_request_error', message, { param, code });

export const missing = (param: string) =>
  new ApiError(400, 'invalid_request_error', `Missing required param: ${param}.`, { param, code: 'parameter_missing' });

export const notFound = (type: string, id: string, param = 'id') =>
  new ApiError(404, 'invalid_request_error', `No such ${type}: '${id}'`, { param, code: 'resource_missing' });

export const unexpectedState = (message: string) =>
  new ApiError(400, 'invalid_request_error', message, { code: 'payment_intent_unexpected_state' });

/**
 * Returned (not thrown) by domain code when the request must fail but its writes must
 * still commit, e.g. a declined charge is recorded and then a 402 is returned.
 */
export class CommitThenFail {
  constructor(public error: ApiError) {}
}
