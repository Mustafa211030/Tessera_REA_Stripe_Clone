// Payment element: one form for every payment method a PaymentIntent accepts (cards, US bank
// accounts, Pay in 4). It runs in its own frame; raw card and bank numbers are posted straight to
// /v1/payment_methods with the publishable key, and only the resulting payment method goes back
// to the page.
(function () {
  const q = new URLSearchParams(location.search);
  const pk = q.get('pk'), account = q.get('account'), parentOrigin = q.get('origin') || location.origin;
  const clientSecret = q.get('client_secret') || '';
  const layout = q.get('layout') === 'accordion' ? 'accordion' : 'tabs';
  const business = q.get('business') || '';
  const scheme = q.get('scheme') || 'normal';
  let appearance = {};
  try { appearance = JSON.parse(q.get('appearance') || '{}'); } catch { appearance = {}; }
  const lang = (q.get('locale') || navigator.language || 'en').slice(0, 2);
  const L = {
    en: { card: 'Card', bank: 'US bank account', quartet: 'Pay in 4', number: 'Card number', exp: 'Expiration', cvc: 'CVC', country: 'Country', zip: 'ZIP', name: 'Full name', email: 'Email', routing: 'Routing number', account: 'Account number', type: 'Account type', checking: 'Checking', savings: 'Savings', mandate: 'By providing your bank details and confirming this payment, you authorize {b} to debit this account for this payment and to correct errors. Test bank accounts are verified with test deposits.', plan: '4 interest-free payments of {a}', redirect: "You'll continue to Quartet to approve your plan.", invalidNumber: 'Your card number is invalid.', incomplete: 'Complete the payment details.', today: 'Today', weeks: 'in {n} weeks' },
    de: { card: 'Karte', bank: 'US-Bankkonto', quartet: 'In 4 Raten', number: 'Kartennummer', exp: 'Ablaufdatum', cvc: 'Prüfnr.', country: 'Land', zip: 'PLZ', name: 'Vollständiger Name', email: 'E-Mail', routing: 'Routing-Nummer', account: 'Kontonummer', type: 'Kontoart', checking: 'Girokonto', savings: 'Sparkonto', mandate: 'Mit Angabe Ihrer Bankdaten und der Bestätigung ermächtigen Sie {b}, dieses Konto für diese Zahlung zu belasten und Fehler zu korrigieren.', plan: '4 zinsfreie Raten à {a}', redirect: 'Sie bestätigen den Ratenplan bei Quartet.', invalidNumber: 'Ihre Kartennummer ist ungültig.', incomplete: 'Bitte füllen Sie die Zahlungsdaten aus.', today: 'Heute', weeks: 'in {n} Wochen' },
    fr: { card: 'Carte', bank: 'Compte bancaire US', quartet: 'Payer en 4 fois', number: 'Numéro de carte', exp: 'Expiration', cvc: 'CVC', country: 'Pays', zip: 'Code postal', name: 'Nom complet', email: 'E-mail', routing: "Numéro d'acheminement", account: 'Numéro de compte', type: 'Type de compte', checking: 'Courant', savings: 'Épargne', mandate: 'En fournissant vos coordonnées bancaires et en confirmant, vous autorisez {b} à prélever ce compte pour ce paiement et à corriger les erreurs.', plan: '4 paiements sans frais de {a}', redirect: 'Vous approuverez votre échéancier sur Quartet.', invalidNumber: 'Votre numéro de carte est invalide.', incomplete: 'Complétez les informations de paiement.', today: "Aujourd'hui", weeks: 'dans {n} semaines' },
    es: { card: 'Tarjeta', bank: 'Cuenta bancaria de EE. UU.', quartet: 'Paga en 4', number: 'Número de tarjeta', exp: 'Caducidad', cvc: 'CVC', country: 'País', zip: 'Código postal', name: 'Nombre completo', email: 'Correo', routing: 'Número de ruta', account: 'Número de cuenta', type: 'Tipo de cuenta', checking: 'Corriente', savings: 'Ahorros', mandate: 'Al facilitar tus datos bancarios y confirmar, autorizas a {b} a cargar este pago en la cuenta y a corregir errores.', plan: '4 pagos sin intereses de {a}', redirect: 'Aprobarás tu plan en Quartet.', invalidNumber: 'El número de tarjeta no es válido.', incomplete: 'Completa los datos de pago.', today: 'Hoy', weeks: 'en {n} semanas' },
    ja: { card: 'カード', bank: '米国の銀行口座', quartet: '4回払い', number: 'カード番号', exp: '有効期限', cvc: 'CVC', country: '国', zip: '郵便番号', name: '氏名', email: 'メール', routing: 'ルーティング番号', account: '口座番号', type: '口座種別', checking: '当座', savings: '普通', mandate: '口座情報を入力して確定すると、{b}がこの支払いのために口座から引き落とし、誤りを訂正することを承認します。', plan: '{a}×4回（手数料無料）', redirect: 'Quartetで支払いプランを承認します。', invalidNumber: 'カード番号が無効です。', incomplete: '支払い情報を入力してください。', today: '今日', weeks: '{n}週間後' },
  }[lang] || null;
  const T = L || { card: 'Card', bank: 'US bank account', quartet: 'Pay in 4', number: 'Card number', exp: 'Expiration', cvc: 'CVC', country: 'Country', zip: 'ZIP', name: 'Full name', email: 'Email', routing: 'Routing number', account: 'Account number', type: 'Account type', checking: 'Checking', savings: 'Savings', mandate: 'By providing your bank details and confirming this payment, you authorize {b} to debit this account for this payment and to correct errors. Test bank accounts are verified with test deposits.', plan: '4 interest-free payments of {a}', redirect: "You'll continue to Quartet to approve your plan.", invalidNumber: 'Your card number is invalid.', incomplete: 'Complete the payment details.', today: 'Today', weeks: 'in {n} weeks' };
  const t = (k, v = {}) => T[k].replace(/\{(\w)\}/g, (_, x) => v[x] ?? '');

  // ---------------------------------------------------------------- appearance
  const root = document.documentElement;
  root.style.colorScheme = scheme;
  if (appearance.theme === 'night' || (appearance.theme === undefined && /dark/.test(scheme) && matchMedia('(prefers-color-scheme: dark)').matches)) root.classList.add('night');
  if (appearance.theme === 'flat') root.classList.add('flat');
  const vars = appearance.variables || {};
  const map = { colorPrimary: '--primary', colorBackground: '--bg', colorText: '--text', colorDanger: '--danger', borderRadius: '--radius', fontFamily: '--font', spacingUnit: '--space' };
  for (const [k, css] of Object.entries(map)) if (typeof vars[k] === 'string' && /^[#\w\s,.'"()%-]{1,80}$/.test(vars[k])) root.style.setProperty(css, vars[k]);

  // ---------------------------------------------------------------- messaging
  const post = (m) => parent.postMessage(Object.assign({ source: 'tessera-payment' }, m), parentOrigin);
  const api = async (method, path, body) => {
    const r = await fetch(path, { method, headers: Object.assign({ authorization: 'Bearer ' + pk, 'content-type': 'application/x-www-form-urlencoded' }, account ? { 'stripe-account': account } : {}), body });
    return { ok: r.ok, json: await r.json() };
  };
  new ResizeObserver(() => post({ type: 'resize', height: Math.ceil(document.body.scrollHeight) + 2 })).observe(document.body);

  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'text') n.textContent = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else if (v !== false && v !== undefined) n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids) if (c) n.append(c);
    return n;
  };
  const ICON = {
    card: 'M3 6h18v12H3zM3 10h18',
    us_bank_account: 'M3 10h18M5 10v8M9 10v8M15 10v8M19 10v8M3 20h18M12 3l9 5H3z',
    quartet: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 3v9h9',
  };
  const icon = (m) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('width', '18'); s.setAttribute('height', '18'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.8'); s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', ICON[m]); s.append(p);
    return s;
  };

  // ---------------------------------------------------------------- card helpers
  const brandOf = (n) => (/^4/.test(n) ? 'visa' : /^(5[1-5]|2[2-7])/.test(n) ? 'mastercard' : /^3[47]/.test(n) ? 'amex' : /^6(011|5)/.test(n) ? 'discover' : '');
  const luhn = (n) => { let s = 0, d = false; for (let i = n.length - 1; i >= 0; i--) { let x = +n[i]; if (d) { x *= 2; if (x > 9) x -= 9; } s += x; d = !d; } return n.length >= 12 && s % 10 === 0; };

  let pi = null, methods = [], current = 'card';
  const f = {};
  const panels = {};
  const errBox = el('div', { class: 'err', role: 'alert' });

  function field(label, input) { return el('label', {}, el('span', { text: label }), input); }
  function input(id, attrs) { const i = el('input', Object.assign({ id }, attrs)); i.addEventListener('input', changed); f[id] = i; return i; }

  function cardPanel() {
    const number = input('number', { inputmode: 'numeric', autocomplete: 'cc-number', placeholder: '1234 1234 1234 1234', maxlength: 23 });
    number.addEventListener('input', () => {
      const d = number.value.replace(/\D/g, '').slice(0, 19);
      const groups = brandOf(d) === 'amex' ? [4, 6, 5] : [4, 4, 4, 4, 3];
      let out = '', i = 0;
      for (const g of groups) { if (i >= d.length) break; out += (out ? ' ' : '') + d.slice(i, i + g); i += g; }
      number.value = out;
    });
    const exp = input('exp', { inputmode: 'numeric', autocomplete: 'cc-exp', placeholder: 'MM / YY', maxlength: 7 });
    exp.addEventListener('input', () => { const d = exp.value.replace(/\D/g, '').slice(0, 4); exp.value = d.length > 2 ? `${d.slice(0, 2)} / ${d.slice(2)}` : d; });
    const cvc = input('cvc', { inputmode: 'numeric', autocomplete: 'cc-csc', placeholder: 'CVC', maxlength: 4 });
    const country = el('select', { id: 'country', autocomplete: 'country' });
    for (const c of ['US', 'CA', 'GB', 'DE', 'FR', 'ES', 'IT', 'NL', 'IE', 'AU', 'JP', 'MX']) country.append(el('option', { value: c, text: c }));
    country.addEventListener('change', () => { zipWrap.hidden = !['US', 'CA', 'GB'].includes(country.value); changed(); });
    f.country = country;
    const zip = input('zip', { autocomplete: 'postal-code', placeholder: '12345' });
    const zipWrap = field(t('zip'), zip);
    return el('div', { class: 'grid' }, field(t('number'), number), el('div', { class: 'row2' }, field(t('exp'), exp), field(t('cvc'), cvc)), el('div', { class: 'row2' }, field(t('country'), country), zipWrap));
  }
  function bankPanel() {
    const type = el('select', { id: 'acct_type' }, el('option', { value: 'checking', text: t('checking') }), el('option', { value: 'savings', text: t('savings') }));
    f.acct_type = type;
    return el('div', { class: 'grid' },
      field(t('name'), input('bank_name', { autocomplete: 'name' })),
      field(t('email'), input('bank_email', { type: 'email', autocomplete: 'email' })),
      el('div', { class: 'row2' }, field(t('routing'), input('routing', { inputmode: 'numeric', placeholder: '110000000', maxlength: 9 })), field(t('account'), input('acct', { inputmode: 'numeric', placeholder: '000123456789', maxlength: 17 }))),
      field(t('type'), type),
      el('p', { class: 'note', text: t('mandate', { b: business || 'the business' }) }));
  }
  function quartetPanel() {
    const fmt = (a) => new Intl.NumberFormat(q.get('locale') || undefined, { style: 'currency', currency: pi.currency.toUpperCase() }).format(['jpy', 'krw'].includes(pi.currency) ? a : a / 100);
    const part = Math.floor(pi.amount / 4);
    const plan = el('div', { class: 'plan' });
    [pi.amount - part * 3, part, part, part].forEach((a, i) => plan.append(el('div', {}, el('span', { class: 'dot', style: `opacity:${1 - i * 0.2}` }), el('b', { text: fmt(a) }), el('span', { class: 'note', text: i === 0 ? t('today') : t('weeks', { n: i * 2 }) }))));
    return el('div', { class: 'grid' },
      el('strong', { text: t('plan', { a: fmt(part) }) }), plan,
      el('div', { class: 'row2' }, field(t('name'), input('q_name', { autocomplete: 'name' })), field(t('email'), input('q_email', { type: 'email', autocomplete: 'email' }))),
      el('p', { class: 'note', text: t('redirect') }));
  }

  function state() {
    if (current === 'card') {
      const n = (f.number.value || '').replace(/\D/g, '');
      const [m, y] = (f.exp.value || '').split('/').map((s) => s.trim());
      const needZip = ['US', 'CA', 'GB'].includes(f.country.value);
      const error = n.length >= (brandOf(n) === 'amex' ? 15 : 16) && !luhn(n) ? t('invalidNumber') : null;
      f.number.classList.toggle('invalid', !!error);
      const complete = luhn(n) && /^\d{2}$/.test(m || '') && /^\d{2}$/.test(y || '') && /^\d{3,4}$/.test(f.cvc.value) && (!needZip || f.zip.value.trim().length >= 3);
      return { complete, empty: !n && !f.exp.value && !f.cvc.value, error };
    }
    if (current === 'us_bank_account') {
      const complete = !!f.bank_name.value.trim() && /@/.test(f.bank_email.value) && /^\d{9}$/.test(f.routing.value) && /^\d{4,17}$/.test(f.acct.value);
      return { complete, empty: !f.bank_name.value && !f.routing.value && !f.acct.value, error: null };
    }
    const complete = !!f.q_name.value.trim() && /@/.test(f.q_email.value);
    return { complete, empty: !f.q_name.value && !f.q_email.value, error: null };
  }
  function changed() {
    const s = state();
    errBox.textContent = s.error ?? '';
    post({ type: 'change', complete: s.complete, empty: s.empty, value: { type: current }, error: s.error ? { message: s.error } : null });
  }
  function select(m) {
    current = m;
    for (const [k, p] of Object.entries(panels)) p.hidden = k !== m;
    document.querySelectorAll('[data-method]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.method === m)));
    document.querySelectorAll('.acc-head input').forEach((r) => { r.checked = r.value === m; });
    errBox.textContent = '';
    changed();
  }

  function render() {
    const rootEl = document.getElementById('root');
    const builders = { card: cardPanel, us_bank_account: bankPanel, quartet: quartetPanel };
    const label = { card: t('card'), us_bank_account: t('bank'), quartet: t('quartet') };
    methods = (pi.payment_method_types || ['card']).filter((m) => builders[m]);
    for (const m of methods) panels[m] = builders[m]();
    if (layout === 'tabs' || methods.length === 1) {
      if (methods.length > 1) {
        const tabs = el('div', { class: 'tabs', role: 'tablist' });
        for (const m of methods) tabs.append(el('button', { type: 'button', role: 'tab', class: 'tab', 'data-method': m, 'aria-selected': String(m === methods[0]), onclick: () => select(m) }, icon(m), el('span', { text: label[m] })));
        rootEl.append(tabs);
      }
      for (const m of methods) rootEl.append(panels[m]);
    } else {
      const acc = el('div', { class: 'acc' });
      for (const m of methods) {
        const radio = el('input', { type: 'radio', name: 'method', value: m, style: 'width:auto;height:auto' });
        acc.append(el('div', { class: 'acc-item' }, el('label', { class: 'acc-head', onclick: () => select(m) }, radio, icon(m), el('span', { text: label[m] })), el('div', { class: 'acc-body' }, panels[m])));
      }
      rootEl.append(acc);
    }
    rootEl.append(errBox);
    select(methods[0]);
    post({ type: 'ready', methods });
  }

  async function createPaymentMethod(bd) {
    const s = state();
    if (!s.complete) return { error: { type: 'validation_error', message: s.error || t('incomplete') } };
    const body = new URLSearchParams();
    const set = (k, v) => { if (v !== undefined && v !== null && v !== '') body.set(k, String(v)); };
    for (const [k, v] of Object.entries(bd || {})) if (typeof v !== 'object') set(`billing_details[${k}]`, v);
    if (current === 'card') {
      const n = f.number.value.replace(/\D/g, ''), [m, y] = f.exp.value.split('/').map((x) => x.trim());
      set('type', 'card'); set('card[number]', n); set('card[exp_month]', m); set('card[exp_year]', y); set('card[cvc]', f.cvc.value);
      set('billing_details[address][country]', f.country.value);
      if (!f.zip.parentElement.hidden) set('billing_details[address][postal_code]', f.zip.value.trim());
    } else if (current === 'us_bank_account') {
      set('type', 'us_bank_account'); set('us_bank_account[routing_number]', f.routing.value); set('us_bank_account[account_number]', f.acct.value); set('us_bank_account[account_type]', f.acct_type.value);
      set('billing_details[name]', f.bank_name.value.trim()); set('billing_details[email]', f.bank_email.value.trim());
    } else {
      set('type', 'quartet'); set('billing_details[name]', f.q_name.value.trim()); set('billing_details[email]', f.q_email.value.trim());
    }
    try {
      const r = await api('POST', '/v1/payment_methods', body);
      return r.ok ? { paymentMethod: r.json } : { error: r.json.error };
    } catch {
      return { error: { type: 'api_connection_error', message: 'Could not reach the payments API.' } };
    }
  }

  window.addEventListener('message', async (e) => {
    if (e.origin !== parentOrigin || !e.data || e.data.target !== 'tessera-payment') return;
    const reply = (payload) => post(Object.assign({ type: 'result', id: e.data.id }, payload));
    if (e.data.type === 'validate') { const s = state(); if (!s.complete) errBox.textContent = s.error || t('incomplete'); return reply(s.complete ? {} : { error: { type: 'validation_error', message: s.error || t('incomplete') } }); }
    if (e.data.type === 'create') return reply(await createPaymentMethod(e.data.billing_details));
    if (e.data.type === 'focus') { const i = panels[current]?.querySelector('input'); i && i.focus(); }
  });

  (async () => {
    const id = clientSecret.split('_secret_')[0];
    if (!/^pi_/.test(id)) { document.getElementById('root').append(el('p', { class: 'err', text: 'The payment element needs a PaymentIntent client secret.' })); return post({ type: 'loaderror', error: { message: 'Invalid client secret.' } }); }
    const r = await api('GET', `/v1/payment_intents/${id}?client_secret=${encodeURIComponent(clientSecret)}`);
    if (!r.ok) { document.getElementById('root').append(el('p', { class: 'err', text: r.json.error?.message || 'Could not load the payment.' })); return post({ type: 'loaderror', error: r.json.error }); }
    pi = r.json;
    render();
  })();
})();
