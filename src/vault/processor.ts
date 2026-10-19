/**
 * Simulated card network / acquirer. Only the vault may call it (it is the
 * "allow-listed processor"), so raw card numbers never reach the API layer.
 *
 * Test card numbers follow the widely published test-card conventions.
 */
export type CardInfo = { brand: string; country: string; funding: 'credit' | 'debit' | 'prepaid' };

type Behaviour =
  | { kind: 'approve' }
  | { kind: 'decline'; decline_code: string; code: string; message: string }
  | { kind: 'error'; code: string; message: string };

const DECLINES: Record<string, Behaviour> = {
  '4000000000000002': { kind: 'decline', code: 'card_declined', decline_code: 'generic_decline', message: 'Your card was declined.' },
  '4000000000009995': { kind: 'decline', code: 'card_declined', decline_code: 'insufficient_funds', message: 'Your card has insufficient funds.' },
  '4000000000009987': { kind: 'decline', code: 'card_declined', decline_code: 'lost_card', message: 'Your card was declined.' },
  '4000000000009979': { kind: 'decline', code: 'card_declined', decline_code: 'stolen_card', message: 'Your card was declined.' },
  '4000000000000069': { kind: 'decline', code: 'expired_card', decline_code: 'expired_card', message: 'Your card has expired.' },
  '4000000000000127': { kind: 'decline', code: 'incorrect_cvc', decline_code: 'incorrect_cvc', message: "Your card's security code is incorrect." },
  '4000000000000119': { kind: 'error', code: 'processing_error', message: 'An error occurred while processing your card. Try again in a little bit.' },
  '4000008260003178': { kind: 'decline', code: 'card_declined', decline_code: 'insufficient_funds', message: 'Your card has insufficient funds.' },
  '4000000000000341': { kind: 'decline', code: 'card_declined', decline_code: 'generic_decline', message: 'Your card was declined.' },
};

/**
 * Strong customer authentication profiles (as on the public test-card list):
 *   setup   authentication needed for one-time payments, but not once the card is set up
 *           for off-session use (SetupIntent or setup_future_usage)
 *   always  every payment needs authentication; off-session payments fail with authentication_required
 */
export const AUTH_PROFILE: Record<string, 'setup' | 'always'> = {
  '4000002500003155': 'setup',
  '4000003800000446': 'setup',
  '4000002760003184': 'always',
  '4000000000003220': 'always',
  '4000008260003178': 'always',
};
export const THREE_DS_REQUIRED = new Set(Object.keys(AUTH_PROFILE));
/** Cards whose successful payments are later disputed by the cardholder (or flagged by the issuer). */
export const DISPUTE_PROFILE: Record<string, { reason: string; inquiry?: boolean; efw?: boolean }> = {
  '4000000000000259': { reason: 'fraudulent' },
  '4000000000002685': { reason: 'product_not_received' },
  '4000000000001976': { reason: 'fraudulent', inquiry: true },
  '4000000000005423': { reason: 'fraudulent', efw: true },
};
/** Cards that can be attached to a customer (zero-amount check passes) but whose charges decline. */
export const ATTACH_OK = new Set(['4000000000000341']);
/** Cards that pass tokenization but fail the CVC check. */
export const CVC_FAIL = new Set(['4000000000000101']);
/** Cards whose payments become available immediately (no pending period). */
export const BYPASS_PENDING = new Set(['4000000000000077']);
/** Risk signals the simulated network attaches (consumed by fraud rules). */
export const RISK_HINT: Record<string, number> = { '4100000000000019': 95, '4000000000009235': 70 };

const COUNTRY_BY_NUMBER: Record<string, string> = {
  '4000000760000002': 'BR', '4000001240000000': 'CA', '4000004840008001': 'MX', '4000000360000006': 'AU',
  '4000008260000000': 'GB', '4000002500000003': 'FR', '4000002760000016': 'DE', '4000003920000003': 'JP',
  '4000003560000008': 'IN', '4000007020000003': 'SG',
};

export function luhn(num: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = num.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return num.length >= 12 && sum % 10 === 0;
}

export function cardInfo(num: string): CardInfo {
  let brand = 'unknown';
  if (/^4/.test(num)) brand = 'visa';
  else if (/^(5[1-5]|2[2-7])/.test(num)) brand = 'mastercard';
  else if (/^3[47]/.test(num)) brand = 'amex';
  else if (/^6(011|5)/.test(num)) brand = 'discover';
  else if (/^35/.test(num)) brand = 'jcb';
  else if (/^3(0|6|8)/.test(num)) brand = 'diners';
  else if (/^62/.test(num)) brand = 'unionpay';
  const funding = num === '4000056655665556' || num === '5200828282828210' ? 'debit' : 'credit';
  return { brand, country: COUNTRY_BY_NUMBER[num] ?? 'US', funding };
}

export type AuthResult =
  | { approved: true; network_transaction_id: string; network_status: 'approved_by_network' }
  | { approved: false; network_status: 'declined_by_network' | 'not_sent_to_network'; code: string; decline_code?: string; message: string };

export function authorize(pan: string, amount: number): AuthResult {
  const b = amount === 0 && ATTACH_OK.has(pan) ? { kind: 'approve' as const } : DECLINES[pan] ?? { kind: 'approve' };
  if (b.kind === 'decline') return { approved: false, network_status: 'declined_by_network', code: b.code, decline_code: b.decline_code, message: b.message };
  if (b.kind === 'error') return { approved: false, network_status: 'not_sent_to_network', code: b.code, message: b.message };
  if (amount > 99_999_999) return { approved: false, network_status: 'declined_by_network', code: 'card_declined', decline_code: 'card_velocity_exceeded', message: 'Your card was declined.' };
  return { approved: true, network_status: 'approved_by_network', network_transaction_id: `ntx_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}` };
}
