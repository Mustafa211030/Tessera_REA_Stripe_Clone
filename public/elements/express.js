// Express checkout element: one row of quick ways to pay above the payment form.
//   Wallet     opens the device wallet sheet (the page shows it; this frame only asks)
//   Quick pay  one-click checkout: email → six-digit code → a saved card
// Whichever the customer picks, the page gets a payment method to confirm with.
(function () {
  const q = new URLSearchParams(location.search);
  const pk = q.get('pk'), account = q.get('account'), parentOrigin = q.get('origin') || location.origin;
  const clientSecret = q.get('client_secret') || '';
  const scheme = q.get('scheme') || 'normal';
  const want = (q.get('methods') || 'wallet,oneclick').split(',');
  let appearance = {};
  try { appearance = JSON.parse(q.get('appearance') || '{}'); } catch { appearance = {}; }
  const root = document.documentElement;
  root.style.colorScheme = scheme;
  if (appearance.theme === 'night' || (appearance.theme === undefined && /dark/.test(scheme) && matchMedia('(prefers-color-scheme: dark)').matches)) root.classList.add('night');
  const vars = appearance.variables || {};
  const map = { colorPrimary: '--primary', colorBackground: '--bg', colorText: '--text', colorDanger: '--danger', borderRadius: '--radius', fontFamily: '--font' };
  for (const [k, css] of Object.entries(map)) if (typeof vars[k] === 'string' && /^[#\w\s,.'"()%-]{1,80}$/.test(vars[k])) root.style.setProperty(css, vars[k]);

  const post = (m) => parent.postMessage(Object.assign({ source: 'tessera-express' }, m), parentOrigin);
  const headers = Object.assign({ authorization: 'Bearer ' + pk }, account ? { 'stripe-account': account } : {});
  const hosted = async (path, body) => {
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.assign({ client_secret: clientSecret }, body)) });
    return { ok: r.ok, json: await r.json() };
  };
  new ResizeObserver(() => post({ type: 'resize', height: Math.ceil(document.body.scrollHeight) + 4 })).observe(document.body);

  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'text') n.textContent = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else if (v !== false && v !== undefined) n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids) if (c) n.append(c);
    return n;
  };
  const svg = (d) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('width', '18'); s.setAttribute('height', '18'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2'); s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', d); s.append(p);
    return s;
  };
  const fmt = (amount, cur) => { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur.toUpperCase() }).format(amount / (['jpy', 'krw'].includes(cur) ? 1 : 100)); } catch { return `${amount} ${cur}`; } };

  const rootEl = document.getElementById('root');
  const panel = el('div', { class: 'panel', hidden: true });
  let pi = null, session = null, challenge = null;

  function step(...kids) { panel.replaceChildren(...kids); panel.hidden = false; }
  function errLine() { return el('div', { class: 'err', role: 'alert' }); }

  function emailStep() {
    const email = el('input', { type: 'email', placeholder: 'you@example.com', autocomplete: 'email', 'aria-label': 'Email' });
    const err = errLine();
    const go = el('button', { type: 'button', class: 'sec', text: 'Continue' });
    const submit = async () => {
      go.disabled = true; err.textContent = '';
      const r = await hosted('/hosted-api/elements/oneclick/lookup', { email: email.value });
      go.disabled = false;
      if (!r.ok) { err.textContent = r.json.error?.message || 'Something went wrong.'; return; }
      if (!r.json.exists) { err.textContent = 'No one-click details are saved for that email. Pay below instead.'; return; }
      challenge = r.json.challenge;
      codeStep(r.json.masked_email);
    };
    go.addEventListener('click', submit);
    email.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    step(el('h2', { text: 'Quick pay' }), el('p', { class: 'note', text: 'Pay with a card you saved for one-click checkout.' }), el('div', { class: 'line' }, email, go), err);
    email.focus();
  }
  function codeStep(masked) {
    const code = el('input', { inputmode: 'numeric', maxlength: '6', placeholder: '000000', autocomplete: 'one-time-code', 'aria-label': 'Verification code' });
    const err = errLine();
    const go = el('button', { type: 'button', class: 'sec', text: 'Verify' });
    const submit = async () => {
      go.disabled = true; err.textContent = '';
      const r = await hosted('/hosted-api/oneclick/verify', { challenge, code: code.value });
      go.disabled = false;
      if (!r.ok) { err.textContent = r.json.error?.message || 'That code did not work.'; return; }
      session = r.json;
      cardsStep();
    };
    go.addEventListener('click', submit);
    code.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    step(el('h2', { text: 'Enter your code' }), el('p', { class: 'note', text: `We sent a code to ${masked}. In test mode, 000000 also works.` }), el('div', { class: 'line' }, code, go), err);
    code.focus();
  }
  function cardsStep() {
    let chosen = session.default_card;
    const list = el('div', { style: 'display:grid;gap:6px' });
    for (const c of session.cards) {
      const r = el('input', { type: 'radio', name: 'card', value: c.id, checked: c.id === chosen, onchange: () => { chosen = c.id; } });
      list.append(el('label', { class: 'card' }, r, el('span', { text: `${c.brand[0].toUpperCase()}${c.brand.slice(1)} •••• ${c.last4}` }), el('span', { class: 'note', style: 'margin-left:auto', text: `${String(c.exp_month).padStart(2, '0')}/${String(c.exp_year).slice(-2)}` })));
    }
    const err = errLine();
    const pay = el('button', { type: 'button', class: 'btn quick', text: `Pay ${fmt(pi.amount, pi.currency)}` });
    pay.addEventListener('click', async () => {
      pay.disabled = true; err.textContent = '';
      const r = await hosted('/hosted-api/elements/oneclick/payment_method', { token: session.token, card: chosen });
      if (!r.ok) { pay.disabled = false; err.textContent = r.json.error?.message || 'Could not use that card.'; return; }
      pay.textContent = 'Processing…';
      post({ type: 'paymentmethod', expressPaymentType: 'oneclick', paymentMethod: r.json, billingDetails: { email: session.email, name: session.name } });
    });
    const other = el('button', { type: 'button', class: 'link', text: 'Not you? Use another email', onclick: () => { session = null; emailStep(); } });
    step(el('h2', { text: `Welcome back${session.name ? `, ${session.name.split(' ')[0]}` : ''}` }), list, pay, err, other);
    panel.dataset.pay = '1';
  }

  window.addEventListener('message', (e) => {
    if (e.origin !== parentOrigin || !e.data || e.data.target !== 'tessera-express') return;
    if (e.data.type === 'complete') {
      const pay = panel.querySelector('.btn.quick');
      if (e.data.status === 'success') step(el('p', { class: 'ok', text: 'Paid. Thank you!' }));
      else if (pay) { pay.disabled = false; pay.textContent = `Pay ${fmt(pi.amount, pi.currency)}`; panel.querySelector('.err').textContent = e.data.message || 'The payment failed. Try another card or pay below.'; }
    }
  });

  (async () => {
    const id = clientSecret.split('_secret_')[0];
    const r = await fetch(`/v1/payment_intents/${encodeURIComponent(id)}?client_secret=${encodeURIComponent(clientSecret)}`, { headers });
    const j = await r.json();
    if (!r.ok) { rootEl.append(el('p', { class: 'err', text: j.error?.message || 'Could not load the payment.' })); return post({ type: 'loaderror', error: j.error }); }
    pi = j;
    const types = pi.payment_method_types || [];
    const methods = types.includes('card') ? want.filter((m) => m === 'wallet' || m === 'oneclick') : [];
    const row = el('div', { class: 'row' });
    if (methods.includes('wallet')) row.append(el('button', { type: 'button', class: 'btn wallet', 'aria-label': 'Pay with device wallet', onclick: () => post({ type: 'wallet' }) }, svg('M8 2h8a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3zM10 18h4'), el('span', { text: 'Wallet' })));
    if (methods.includes('oneclick')) row.append(el('button', { type: 'button', class: 'btn quick', 'aria-label': 'Quick pay with saved details', onclick: () => (panel.hidden ? emailStep() : (panel.hidden = true)) }, svg('M13 2L4 14h7l-1 8 9-12h-7z'), el('span', { text: 'Quick pay' })));
    rootEl.append(row, panel);
    post({ type: 'ready', availablePaymentMethods: { deviceWallet: methods.includes('wallet'), oneclick: methods.includes('oneclick') }, amount: pi.amount, currency: pi.currency });
  })();
})();
