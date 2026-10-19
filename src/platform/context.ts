/** Per-request context, attached by the auth layer. */
export type KeyType = 'secret' | 'publishable' | 'restricted' | 'dashboard';

export type Ctx = {
  accountId: string;
  /** Set when a platform acts on a connected account (Stripe-Account header). */
  platformAccountId?: string;
  livemode: false;
  apiVersion: string;
  keyType: KeyType;
  keyId?: string;
  permissions?: Record<string, 'read' | 'write' | 'none'>;
  requestId: string;
  idempotencyKey?: string;
  baseUrl: string;
};
