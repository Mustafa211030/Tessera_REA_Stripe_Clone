// Simulated device wallet sheet. Test cards "in the wallet" become payment methods through
// wallet tokens (tok_wallet_*); the parent page only receives the resulting payment method.
(function () {
  const q = new URLSearchParams(location.search);
  const scheme = q.get('scheme') || 'normal';
  document.documentElement.style.colorScheme = scheme;
  if (!/dark/.test(scheme)) document.documentElement.classList.add('light-only');
  const pk = q.get('pk'), account = q.get('account'), parentOrigin = q.get('origin') || location.origin;
  const lang = (q.get('locale') || navigator.language || 'en').slice(0, 2);
  const T = {
    en: { title: 'Wallet', cancel: 'Cancel', confirm: 'Confirm with passcode', auth: 'Authenticating…', done: 'Done', failed: 'Payment not completed. Try another card.', name: 'Name', email: 'Email', note: 'Test mode: a simulated device wallet with test cards.', declines: 'declines' },
    de: { title: 'Wallet', cancel: 'Abbrechen', confirm: 'Mit Code bestätigen', auth: 'Authentifizierung…', done: 'Fertig', failed: 'Zahlung nicht abgeschlossen. Andere Karte wählen.', name: 'Name', email: 'E-Mail', note: 'Testmodus: simulierte Geräte-Wallet mit Testkarten.', declines: 'wird abgelehnt' },
    fr: { title: 'Portefeuille', cancel: 'Annuler', confirm: 'Confirmer avec le code', auth: 'Authentification…', done: 'Terminé', failed: 'Paiement non abouti. Essayez une autre carte.', name: 'Nom', email: 'E-mail', note: 'Mode test : portefeuille simulé avec des cartes de test.', declines: 'refusée' },
    es: { title: 'Billetera', cancel: 'Cancelar', confirm: 'Confirmar con código', auth: 'Autenticando…', done: 'Listo', failed: 'Pago no completado. Prueba otra tarjeta.', name: 'Nombre', email: 'Correo', note: 'Modo de prueba: billetera simulada con tarjetas de prueba.', declines: 'rechazada' },
    ja: { title: 'ウォレット', cancel: 'キャンセル', confirm: 'パスコードで確認', auth: '認証中…', done: '完了', failed: '支払いが完了しませんでした。別のカードをお試しください。', name: '名前', email: 'メール', note: 'テストモード：テストカード入りのシミュレーションウォレットです。', declines: '拒否' },
  }[lang] || null;
  const t = T || { title: 'Wallet', cancel: 'Cancel', confirm: 'Confirm with passcode', auth: 'Authenticating…', done: 'Done', failed: 'Payment not completed. Try another card.', name: 'Name', email: 'Email', note: 'Test mode: a simulated device wallet with test cards.', declines: 'declines' };
  const CARDS = [
    { token: 'tok_wallet_visa', brand: 'visa', chip: 'VISA', last4: '4242', color: '#1a1f71', label: 'Visa' },
    { token: 'tok_wallet_mastercard', brand: 'mastercard', chip: 'MC', last4: '4444', color: '#eb001b', label: 'Mastercard' },
    { token: 'tok_wallet_amex', brand: 'amex', chip: 'AMEX', last4: '0005', color: '#2e77bc', label: 'American Express' },
    { token: 'tok_wallet_chargeDeclined', brand: 'visa', chip: 'VISA', last4: '0002', color: '#55554f', label: 'Visa', note: t.declines },
  ];
  const $ = (id) => document.getElementById(id);
  const post = (m) => parent.postMessage(Object.assign({ source: 'tessera-wallet' }, m), parentOrigin);
  const cur = (q.get('currency') || 'usd').toUpperCase();
  const amount = Number(q.get('amount') || 0);
  const zero = ['JPY', 'KRW', 'VND', 'CLP'].includes(cur);
  $('title').textContent = t.title;
  $('cancel').textContent = t.cancel;
  $('label').textContent = q.get('label') || '';
  $('amount').textContent = new Intl.NumberFormat(q.get('locale') || undefined, { style: 'currency', currency: cur }).format(zero ? amount : amount / 100);
  $('note').textContent = t.note;
  $('confirm').textContent = t.confirm;
  let selected = CARDS[0].token;
  CARDS.forEach((c, i) => {
    const row = document.createElement('label');
    row.className = 'card';
    row.innerHTML = `<input type="radio" name="card" ${i === 0 ? 'checked' : ''}><span class="chip" style="background:${c.color}">${c.chip}</span><span><span class="n"></span><small></small></span>`;
    row.querySelector('.n').textContent = `${c.label} •••• ${c.last4}`;
    row.querySelector('small').textContent = c.note || '';
    row.querySelector('input').value = c.token;
    row.querySelector('input').setAttribute('aria-label', `${c.label} ending ${c.last4}`);
    row.querySelector('input').addEventListener('change', () => { selected = c.token; });
    $('cards').appendChild(row);
  });
  const fields = [];
  if (q.get('name')) fields.push(['name', t.name, 'Jenny Rosen', 'name']);
  if (q.get('email')) fields.push(['email', t.email, 'jenny.rosen@example.com', 'email']);
  if (fields.length) {
    $('contact').hidden = false;
    for (const [key, label, def, auto] of fields) {
      const l = document.createElement('label');
      l.innerHTML = '<span></span><input>';
      l.querySelector('span').textContent = label;
      const inp = l.querySelector('input');
      inp.id = 'f_' + key; inp.value = def; inp.autocomplete = auto; inp.setAttribute('aria-label', label);
      $('contact').appendChild(l);
    }
  }
  $('cancel').addEventListener('click', () => post({ type: 'cancel' }));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') post({ type: 'cancel' }); });
  const status = (text, kind) => { $('status').textContent = text; $('status').className = 'status' + (kind ? ' ' + kind : ''); };

  $('confirm').addEventListener('click', async () => {
    $('confirm').disabled = true;
    status(t.auth);
    await new Promise((r) => setTimeout(r, 450)); // the device checks the passcode / biometrics
    const name = $('f_name')?.value || '';
    const email = $('f_email')?.value || '';
    const body = new URLSearchParams({ type: 'card', 'card[token]': selected });
    if (name) body.set('billing_details[name]', name);
    if (email) body.set('billing_details[email]', email);
    try {
      const res = await fetch('/v1/payment_methods', { method: 'POST', headers: Object.assign({ authorization: 'Bearer ' + pk, 'content-type': 'application/x-www-form-urlencoded' }, account ? { 'stripe-account': account } : {}), body });
      const json = await res.json();
      if (!res.ok) { status(json.error?.message || t.failed, 'err'); $('confirm').disabled = false; return; }
      post({ type: 'paymentmethod', paymentMethod: json, payerName: name || null, payerEmail: email || null });
    } catch {
      status(t.failed, 'err'); $('confirm').disabled = false;
    }
  });
  window.addEventListener('message', (e) => {
    if (e.origin !== parentOrigin || !e.data || e.data.target !== 'tessera-wallet' || e.data.type !== 'complete') return;
    if (e.data.status === 'success') status('✓ ' + t.done, 'ok');
    else { status(t.failed, 'err'); $('confirm').disabled = false; }
  });
  $('confirm').focus();
})();
