// Card element, running inside its own iframe. Raw card data stays in this frame:
// it is posted straight to /v1/payment_methods with the publishable key, and only the
// resulting payment method id (plus brand/last4) is sent back to the parent page.
(function () {
  const params = new URLSearchParams(location.search);
  const scheme = params.get('scheme') || 'normal';
  document.documentElement.style.colorScheme = scheme;
  if (!/dark/.test(scheme)) document.documentElement.classList.add('light-only');
  const pk = params.get('pk');
  const account = params.get('account');
  const parentOrigin = params.get('origin') || location.origin;
  const $ = (id) => document.getElementById(id);
  const number = $('number'), exp = $('exp'), cvc = $('cvc'), row = $('row'), brandEl = $('brand');
  const lang = (params.get('locale') || navigator.language || 'en').slice(0, 2);
  const T = ({
    de: ['Kartennummer', 'MM / JJ', 'Prüfnr.', 'Ihre Kartennummer ist ungültig.', 'Ihre Kartendaten sind unvollständig.', 'Ablaufdatum', 'Sicherheitscode'],
    fr: ['Numéro de carte', 'MM / AA', 'CVC', 'Votre numéro de carte est invalide.', 'Les informations de votre carte sont incomplètes.', "Date d'expiration", 'Code de sécurité'],
    es: ['Número de tarjeta', 'MM / AA', 'CVC', 'El número de tu tarjeta no es válido.', 'Los datos de tu tarjeta están incompletos.', 'Fecha de caducidad', 'Código de seguridad'],
    ja: ['カード番号', '月 / 年', 'CVC', 'カード番号が無効です。', 'カード情報が不完全です。', '有効期限', 'セキュリティコード'],
  })[lang] || ['Card number', 'MM / YY', 'CVC', 'Your card number is invalid.', 'Your card details are incomplete.', 'Expiration date', 'Security code'];
  if (lang !== 'en') {
    document.documentElement.lang = lang;
    number.placeholder = T[0]; number.setAttribute('aria-label', T[0]);
    exp.placeholder = T[1]; exp.setAttribute('aria-label', T[5]);
    cvc.placeholder = T[2]; cvc.setAttribute('aria-label', T[6]);
  }

  function brandOf(n) {
    if (/^4/.test(n)) return 'visa';
    if (/^(5[1-5]|2[2-7])/.test(n)) return 'mastercard';
    if (/^3[47]/.test(n)) return 'amex';
    if (/^6(011|5)/.test(n)) return 'discover';
    return '';
  }
  function luhn(n) {
    let s = 0, d = false;
    for (let i = n.length - 1; i >= 0; i--) { let x = +n[i]; if (d) { x *= 2; if (x > 9) x -= 9; } s += x; d = !d; }
    return n.length >= 12 && s % 10 === 0;
  }
  function state() {
    const n = number.value.replace(/\D/g, '');
    const [m, y] = exp.value.split('/').map((s) => s.trim());
    const complete = luhn(n) && /^\d{2}$/.test(m || '') && /^\d{2}$/.test(y || '') && /^\d{3,4}$/.test(cvc.value);
    let error = null;
    if (n.length >= 12 && !luhn(n) && n.length >= (brandOf(n) === 'amex' ? 15 : 16)) error = T[3];
    return { n, m, y, complete, error, brand: brandOf(n), empty: !n && !exp.value && !cvc.value };
  }
  function emit() {
    const s = state();
    row.classList.toggle('invalid', !!s.error);
    brandEl.textContent = s.brand;
    parent.postMessage({ source: 'tessera-card', type: 'change', complete: s.complete, empty: s.empty, brand: s.brand || 'unknown', error: s.error ? { message: s.error } : null }, parentOrigin);
  }
  number.addEventListener('input', () => {
    const d = number.value.replace(/\D/g, '').slice(0, 19);
    const groups = brandOf(d) === 'amex' ? [4, 6, 5] : [4, 4, 4, 4, 3];
    let out = '', i = 0;
    for (const g of groups) { if (i >= d.length) break; out += (out ? ' ' : '') + d.slice(i, i + g); i += g; }
    number.value = out;
    if (d.length >= 16 && luhn(d)) exp.focus();
    emit();
  });
  exp.addEventListener('input', () => {
    const d = exp.value.replace(/\D/g, '').slice(0, 4);
    exp.value = d.length > 2 ? `${d.slice(0, 2)} / ${d.slice(2)}` : d;
    if (d.length === 4) cvc.focus();
    emit();
  });
  cvc.addEventListener('input', () => { cvc.value = cvc.value.replace(/\D/g, '').slice(0, 4); emit(); });
  [number, exp, cvc].forEach((el) => {
    el.addEventListener('focus', () => parent.postMessage({ source: 'tessera-card', type: 'focus' }, parentOrigin));
    el.addEventListener('blur', () => parent.postMessage({ source: 'tessera-card', type: 'blur' }, parentOrigin));
  });

  window.addEventListener('message', async (e) => {
    if (e.origin !== parentOrigin || !e.data || e.data.target !== 'tessera-card') return;
    const reply = (payload) => parent.postMessage({ source: 'tessera-card', type: 'result', id: e.data.id, ...payload }, parentOrigin);
    if (e.data.type === 'clear') { number.value = exp.value = cvc.value = ''; emit(); return; }
    if (e.data.type === 'focus') { number.focus(); return; }
    if (e.data.type !== 'tokenize') return;
    const s = state();
    if (!s.complete) return reply({ error: { type: 'validation_error', message: s.error || T[4] } });
    const body = new URLSearchParams({ type: 'card', 'card[number]': s.n, 'card[exp_month]': s.m, 'card[exp_year]': s.y, 'card[cvc]': cvc.value });
    const bd = e.data.billing_details || {};
    for (const [k, v] of Object.entries(bd)) if (v && typeof v !== 'object') body.set(`billing_details[${k}]`, v);
    if (bd.address) for (const [k, v] of Object.entries(bd.address)) if (v) body.set(`billing_details[address][${k}]`, v);
    try {
      const res = await fetch('/v1/payment_methods', { method: 'POST', headers: Object.assign({ authorization: 'Bearer ' + pk, 'content-type': 'application/x-www-form-urlencoded' }, account ? { 'stripe-account': account } : {}), body });
      const json = await res.json();
      if (!res.ok) return reply({ error: json.error });
      reply({ paymentMethod: json });
    } catch (err) {
      reply({ error: { type: 'api_connection_error', message: 'Could not reach the payments API.' } });
    }
  });
  parent.postMessage({ source: 'tessera-card', type: 'ready' }, parentOrigin);
})();
