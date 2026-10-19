/*!
 * tessera.js: client SDK for Tessera (local test-mode payments platform).
 *
 *   const tessera = Tessera('pk_test_...');
 *   const elements = tessera.elements({ clientSecret, appearance: { theme: 'flat' } });
 *   elements.create('expressCheckout').mount('#express');
 *   elements.create('payment').mount('#payment');
 *   const { paymentIntent, error } = await tessera.confirmPayment({ elements, redirect: 'if_required' });
 *
 *   // or the card element on its own:
 *   const card = tessera.elements().create('card');
 *   card.mount('#card-element');
 *   const { paymentIntent, error } = await tessera.confirmCardPayment(clientSecret, {
 *     payment_method: { card, billing_details: { name: 'Jenny' } },
 *     return_url: location.href,
 *   });
 */
(function (global) {
  const ORIGIN = (function () {
    const s = document.currentScript;
    return s ? new URL(s.src).origin : location.origin;
  })();

  /** The page's color scheme (CSS color-scheme, else the color-scheme meta tag). */
  function pageScheme(el) {
    const css = getComputedStyle(el || document.documentElement).colorScheme;
    if (css && css !== 'normal') return css;
    const meta = document.querySelector('meta[name="color-scheme"]');
    return (meta && meta.getAttribute('content')) || 'normal';
  }

  function api(auth, method, path, params) {
    const pk = auth.pk;
    const body = new URLSearchParams();
    const add = (prefix, v) => {
      if (v === undefined || v === null) return;
      if (typeof v === 'object') for (const [k, x] of Object.entries(v)) add(prefix ? `${prefix}[${k}]` : k, x);
      else body.append(prefix, String(v));
    };
    add('', params || {});
    const url = ORIGIN + path + (method === 'GET' ? '?' + body.toString() : '');
    return fetch(url, {
      method,
      headers: Object.assign({ authorization: 'Bearer ' + pk, 'content-type': 'application/x-www-form-urlencoded' }, auth.account ? { 'stripe-account': auth.account } : {}),
      body: method === 'GET' ? undefined : body,
    }).then(async (r) => ({ ok: r.ok, json: await r.json() }));
  }

  function CardElement() {
    this._listeners = {};
    this._pending = new Map();
    this._seq = 0;
    this._frame = null;
  }
  CardElement.prototype.mount = function (target, pk, account, locale) {
    const el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) throw new Error('tessera.js: mount target not found');
    const f = document.createElement('iframe');
    // The frame follows the page's color scheme, so it stays transparent and matches light or dark pages.
    const scheme = pageScheme(el);
    f.src = `${ORIGIN}/elements/card.html?pk=${encodeURIComponent(pk)}&origin=${encodeURIComponent(location.origin)}${account ? `&account=${encodeURIComponent(account)}` : ''}${locale ? `&locale=${encodeURIComponent(locale)}` : ''}&scheme=${encodeURIComponent(scheme)}`;
    f.title = 'Secure card payment input frame';
    f.setAttribute('allow', 'payment');
    f.style.cssText = 'border:0;width:100%;height:46px;display:block;';
    f.style.colorScheme = scheme;
    el.innerHTML = '';
    el.appendChild(f);
    this._frame = f;
    this._onMsg = (e) => {
      if (e.origin !== ORIGIN || !e.data || e.data.source !== 'tessera-card' || e.source !== f.contentWindow) return;
      if (e.data.type === 'result') {
        const p = this._pending.get(e.data.id);
        if (p) { this._pending.delete(e.data.id); p(e.data); }
        return;
      }
      (this._listeners[e.data.type] || []).forEach((cb) => cb(e.data));
    };
    window.addEventListener('message', this._onMsg);
    return this;
  };
  CardElement.prototype.on = function (evt, cb) { (this._listeners[evt] ||= []).push(cb); return this; };
  CardElement.prototype.clear = function () { this._post({ type: 'clear' }); };
  CardElement.prototype.focus = function () { this._post({ type: 'focus' }); };
  CardElement.prototype.unmount = function () { window.removeEventListener('message', this._onMsg); this._frame?.remove(); };
  CardElement.prototype._post = function (msg) { this._frame?.contentWindow?.postMessage({ target: 'tessera-card', ...msg }, ORIGIN); };
  CardElement.prototype._tokenize = function (billing_details) {
    const id = ++this._seq;
    return new Promise((resolve) => { this._pending.set(id, resolve); this._post({ type: 'tokenize', id, billing_details }); });
  };

  /** Tessera(pk, { stripeAccount }) acts on a connected account (direct charges). */
  function Tessera(pk, options) {
    if (!(this instanceof Tessera)) return new Tessera(pk, options);
    if (!/^pk_test_/.test(pk || '')) throw new Error('tessera.js: a publishable key (pk_test_...) is required');
    this._pk = pk;
    this._account = (options && options.stripeAccount) || null;
    this._auth = { pk, account: this._account };
  }
  /**
   * elements(options) groups the elements of one payment form.
   *   locale        en, de, fr, es, ja (placeholders and messages)
   *   clientSecret  a PaymentIntent's client secret: needed for 'payment' and 'expressCheckout'
   *   appearance    { theme: 'stripe' | 'night' | 'flat', variables: { colorPrimary, colorBackground,
   *                   colorText, colorDanger, borderRadius, fontFamily, spacingUnit } }
   *   business      { name } shown in mandate text
   */
  Tessera.prototype.elements = function (options) {
    const o = options || {};
    const pk = this._pk;
    const account = this._account;
    const locale = (o.locale && o.locale !== 'auto') ? o.locale : '';
    const tessera = this;
    const group = {
      _clientSecret: o.clientSecret || null, _appearance: o.appearance || {}, _business: (o.business && o.business.name) || '', _locale: locale,
      _payment: null, _express: null, _expressEl: null, _auth: this._auth,
      create: (type, options) => {
        if (type === 'paymentRequestButton') return new PaymentRequestButton(options && options.paymentRequest, options && options.style);
        if (type === 'card') { const c = new CardElement(); const m = c.mount.bind(c); c.mount = (t) => m(t, pk, account, locale); return c; }
        if (type === 'payment') { if (!group._clientSecret) throw new Error("tessera.js: elements({ clientSecret }) is needed for the 'payment' element"); return (group._payment = new PaymentElement(group, options)); }
        if (type === 'expressCheckout') { if (!group._clientSecret) throw new Error("tessera.js: elements({ clientSecret }) is needed for the 'expressCheckout' element"); return (group._expressEl = new ExpressCheckoutElement(group, tessera, options)); }
        throw new Error('Available elements: payment, expressCheckout, card, paymentRequestButton');
      },
      getElement: (type) => (type === 'payment' ? group._payment : type === 'expressCheckout' ? group._expressEl : null),
      /** Validates the payment element before you call your server or confirmPayment. */
      submit: async () => {
        if (!group._payment) return {};
        const r = await group._payment._call('validate');
        return r.error ? { error: r.error } : {};
      },
      update: (opts) => { if (opts && opts.appearance) group._appearance = opts.appearance; },
    };
    return group;
  };

  function frameUrl(page, group, extra) {
    const q = new URLSearchParams({ pk: group._auth.pk, origin: location.origin, client_secret: group._clientSecret, scheme: extra.scheme, appearance: JSON.stringify(group._appearance || {}) });
    if (group._auth.account) q.set('account', group._auth.account);
    if (group._locale) q.set('locale', group._locale);
    for (const [k, v] of Object.entries(extra)) if (k !== 'scheme' && v) q.set(k, v);
    return `${ORIGIN}/elements/${page}.html?${q}`;
  }
  function mountFrame(self, target, src, title, source) {
    const el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) throw new Error('tessera.js: mount target not found');
    const f = document.createElement('iframe');
    f.src = src; f.title = title;
    f.setAttribute('allow', 'payment');
    f.style.cssText = 'border:0;width:100%;height:0;display:block;transition:height .15s';
    f.style.colorScheme = pageScheme(el);
    el.innerHTML = '';
    el.appendChild(f);
    self._frame = f;
    self._onMsg = (e) => {
      if (e.origin !== ORIGIN || !e.data || e.data.source !== source || e.source !== f.contentWindow) return;
      if (e.data.type === 'resize') { f.style.height = e.data.height + 'px'; return; }
      if (e.data.type === 'result') { const p = self._pending.get(e.data.id); if (p) { self._pending.delete(e.data.id); p(e.data); } return; }
      self._handle && self._handle(e.data);
      (self._listeners[e.data.type] || []).forEach((cb) => cb(e.data));
    };
    window.addEventListener('message', self._onMsg);
  }

  /** One form for every payment method the PaymentIntent accepts: card, US bank account, Pay in 4. */
  function PaymentElement(group, options) {
    this._group = group; this._opts = options || {};
    this._listeners = {}; this._pending = new Map(); this._seq = 0; this._frame = null; this._value = { type: null };
  }
  PaymentElement.prototype.mount = function (target) {
    const el = typeof target === 'string' ? document.querySelector(target) : target;
    const layout = typeof this._opts.layout === 'string' ? this._opts.layout : (this._opts.layout && this._opts.layout.type) || 'tabs';
    mountFrame(this, el, frameUrl('payment', this._group, { scheme: pageScheme(el), layout, business: this._group._business }), 'Secure payment input frame', 'tessera-payment');
    return this;
  };
  PaymentElement.prototype._handle = function (d) { if (d.type === 'change') this._value = d.value; };
  PaymentElement.prototype.on = function (evt, cb) { (this._listeners[evt] ||= []).push(cb); return this; };
  PaymentElement.prototype.off = function (evt, cb) { this._listeners[evt] = (this._listeners[evt] || []).filter((x) => x !== cb); return this; };
  PaymentElement.prototype.focus = function () { this._post({ type: 'focus' }); };
  PaymentElement.prototype.unmount = function () { window.removeEventListener('message', this._onMsg); this._frame && this._frame.remove(); };
  PaymentElement.prototype._post = function (msg) { this._frame && this._frame.contentWindow && this._frame.contentWindow.postMessage(Object.assign({ target: 'tessera-payment' }, msg), ORIGIN); };
  PaymentElement.prototype._call = function (type, extra) {
    if (!this._frame) return Promise.resolve({ error: { type: 'validation_error', message: 'The payment element is not mounted.' } });
    const id = ++this._seq;
    return new Promise((resolve) => { this._pending.set(id, resolve); this._post(Object.assign({ type, id }, extra || {})); });
  };

  /**
   * A row of quick ways to pay: device wallet and one-click Quick pay. Listen for 'confirm', then
   * call tessera.confirmPayment({ elements }) — it uses the payment method the customer chose here.
   */
  function ExpressCheckoutElement(group, tessera, options) {
    this._group = group; this._tessera = tessera; this._opts = options || {};
    this._listeners = {}; this._pending = new Map(); this._frame = null; this._pr = null;
  }
  ExpressCheckoutElement.prototype.mount = function (target) {
    const el = typeof target === 'string' ? document.querySelector(target) : target;
    const pm = this._opts.paymentMethods || {};
    const methods = ['wallet', 'oneclick'].filter((m) => pm[m === 'wallet' ? 'deviceWallet' : 'oneclick'] !== 'never').join(',');
    mountFrame(this, el, frameUrl('express', this._group, { scheme: pageScheme(el), methods }), 'Express checkout', 'tessera-express');
    return this;
  };
  ExpressCheckoutElement.prototype.on = PaymentElement.prototype.on;
  ExpressCheckoutElement.prototype.off = PaymentElement.prototype.off;
  ExpressCheckoutElement.prototype.unmount = function () { window.removeEventListener('message', this._onMsg); this._frame && this._frame.remove(); this._pr && this._pr.abort(); };
  ExpressCheckoutElement.prototype._handle = function (d) {
    if (d.type === 'ready') this._pi = { amount: d.amount, currency: d.currency };
    if (d.type === 'wallet') {
      const pr = (this._pr = new PaymentRequest(this._group._auth, { currency: this._pi.currency, total: { label: this._group._business || 'Total', amount: this._pi.amount }, requestPayerName: true, requestPayerEmail: true, locale: this._group._locale }));
      pr.on('paymentmethod', (ev) => this._fireConfirm('device_wallet', ev.paymentMethod, { name: ev.payerName, email: ev.payerEmail }, ev.complete));
      pr.on('cancel', () => (this._listeners.cancel || []).forEach((cb) => cb({ expressPaymentType: 'device_wallet' })));
      pr.show();
    }
    if (d.type === 'paymentmethod') {
      const frame = this._frame;
      this._fireConfirm(d.expressPaymentType, d.paymentMethod, d.billingDetails || {}, (status, message) => frame.contentWindow.postMessage({ target: 'tessera-express', type: 'complete', status, message }, ORIGIN));
    }
  };
  ExpressCheckoutElement.prototype._fireConfirm = function (expressPaymentType, paymentMethod, billingDetails, complete) {
    let done = false;
    this._group._express = { expressPaymentType, paymentMethod, complete: (s, m) => { if (!done) { done = true; complete(s, m); } } };
    const ev = {
      expressPaymentType, billingDetails, paymentMethod: { id: paymentMethod.id, type: paymentMethod.type },
      paymentFailed: (opts) => this._group._express && this._group._express.complete('fail', opts && opts.message),
    };
    const ls = this._listeners.confirm || [];
    // With no 'confirm' listener, confirm straight away.
    if (!ls.length) this._tessera.confirmPayment({ elements: this._group, redirect: 'if_required' });
    ls.forEach((cb) => cb(ev));
  };

  /**
   * Confirms the PaymentIntent with whatever the customer entered: an express payment method if
   * they picked one, otherwise the payment element's form.
   *   tessera.confirmPayment({ elements, confirmParams: { return_url }, redirect: 'always' | 'if_required' })
   */
  Tessera.prototype.confirmPayment = async function (opts) {
    const o = opts || {};
    const group = o.elements;
    const clientSecret = o.clientSecret || (group && group._clientSecret);
    if (!clientSecret) return { error: { type: 'invalid_request_error', message: 'confirmPayment needs elements created with a clientSecret (or a clientSecret).' } };
    const cp = o.confirmParams || {};
    const id = clientSecret.split('_secret_')[0];
    const express = group && group._express;
    let pm, type;
    if (express) { pm = express.paymentMethod.id; type = 'card'; group._express = null; }
    else if (cp.payment_method) { pm = cp.payment_method; }
    else if (group && group._payment) {
      const r = await group._payment._call('create', { billing_details: (cp.payment_method_data && cp.payment_method_data.billing_details) || {} });
      if (r.error) return { error: r.error };
      pm = r.paymentMethod.id; type = r.paymentMethod.type;
    } else return { error: { type: 'invalid_request_error', message: 'Mount a payment element or use express checkout first.' } };
    const params = { client_secret: clientSecret, payment_method: pm, return_url: cp.return_url || location.href, receipt_email: cp.receipt_email };
    if (type === 'us_bank_account') params.mandate_data = { customer_acceptance: { type: 'online', online: { infer_from_client: 'true', user_agent: navigator.userAgent } } };
    if (cp.setup_future_usage) params.setup_future_usage = cp.setup_future_usage;
    const r = await api(this._auth, 'POST', `/v1/payment_intents/${id}/confirm`, params);
    if (!r.ok) { express && express.complete('fail', r.json.error && r.json.error.message); return { error: r.json.error }; }
    const pi = r.json;
    if (pi.status === 'requires_action' && pi.next_action && pi.next_action.type === 'redirect_to_url') {
      express && express.complete('success');
      location.assign(pi.next_action.redirect_to_url.url);
      return new Promise(() => {});
    }
    express && express.complete(['succeeded', 'processing', 'requires_capture'].includes(pi.status) ? 'success' : 'fail');
    if (o.redirect !== 'if_required' && ['succeeded', 'processing', 'requires_capture'].includes(pi.status) && cp.return_url) {
      const u = new URL(cp.return_url, location.href);
      u.searchParams.set('payment_intent', pi.id); u.searchParams.set('payment_intent_client_secret', clientSecret); u.searchParams.set('redirect_status', pi.status === 'processing' ? 'pending' : 'succeeded');
      location.assign(u.toString());
      return new Promise(() => {});
    }
    return { paymentIntent: pi };
  };
  /** Card element: { card, billing_details }. Other types: { type: 'us_bank_account' | 'quartet', ..., billing_details }. */
  Tessera.prototype.createPaymentMethod = async function (opts) {
    if (opts && opts.card && opts.card._tokenize) {
      const r = await opts.card._tokenize(opts.billing_details);
      return r.error ? { error: r.error } : { paymentMethod: r.paymentMethod };
    }
    const r = await api(this._auth, 'POST', '/v1/payment_methods', opts);
    return r.ok ? { paymentMethod: r.json } : { error: r.json.error };
  };

  // ---------------------------------------------------------------- device wallets
  /**
   * A payment request opens the device wallet sheet (simulated in test mode):
   *   const pr = tessera.paymentRequest({ country: 'US', currency: 'usd', total: { label: 'Shop', amount: 1999 } });
   *   if (await pr.canMakePayment()) elements.create('paymentRequestButton', { paymentRequest: pr }).mount('#wallet');
   *   pr.on('paymentmethod', async (ev) => { ...confirm with ev.paymentMethod.id...; ev.complete('success'); });
   */
  function PaymentRequest(auth, options) {
    this._auth = auth;
    this._opts = Object.assign({ country: 'US', requestPayerName: false, requestPayerEmail: false }, options || {});
    if (!this._opts.currency || !this._opts.total || typeof this._opts.total.amount !== 'number') throw new Error('tessera.js: paymentRequest needs currency and total { label, amount }');
    this._listeners = {};
    this._overlay = null;
  }
  PaymentRequest.prototype.on = function (evt, cb) { (this._listeners[evt] ||= []).push(cb); return this; };
  PaymentRequest.prototype._fire = function (evt, data) { (this._listeners[evt] || []).forEach((cb) => cb(data)); };
  PaymentRequest.prototype.update = function (opts) { Object.assign(this._opts, opts || {}); };
  /** Test mode always has a device wallet with test cards in it. */
  PaymentRequest.prototype.canMakePayment = function () { return Promise.resolve({ deviceWallet: true }); };
  PaymentRequest.prototype.isShowing = function () { return !!this._overlay; };
  PaymentRequest.prototype.abort = function () { this._close(); };
  PaymentRequest.prototype._close = function () {
    if (this._onMsg) window.removeEventListener('message', this._onMsg);
    this._overlay && this._overlay.remove();
    this._overlay = null;
  };
  PaymentRequest.prototype.show = function () {
    if (this._overlay) return;
    const o = this._opts;
    const q = new URLSearchParams({ scheme: pageScheme(), pk: this._auth.pk, origin: location.origin, amount: String(o.total.amount), currency: o.currency, label: o.total.label || '', name: o.requestPayerName ? '1' : '', email: o.requestPayerEmail ? '1' : '', locale: o.locale || '' });
    if (this._auth.account) q.set('account', this._auth.account);
    const overlay = document.createElement('div');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'Device wallet');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(20,20,18,.45);display:flex;align-items:flex-end;justify-content:center';
    const frame = document.createElement('iframe');
    frame.title = 'Device wallet';
    frame.src = ORIGIN + '/elements/wallet.html?' + q.toString();
    frame.style.cssText = 'width:min(420px,100%);height:min(560px,100%);border:0;border-radius:16px 16px 0 0;background:transparent';
    frame.style.colorScheme = q.get('scheme');
    overlay.appendChild(frame);
    document.body.appendChild(overlay);
    this._overlay = overlay;
    this._onMsg = (e) => {
      if (e.origin !== ORIGIN || !e.data || e.data.source !== 'tessera-wallet' || e.source !== frame.contentWindow) return;
      if (e.data.type === 'cancel') { this._close(); this._fire('cancel', {}); }
      if (e.data.type === 'paymentmethod') {
        let done = false;
        this._fire('paymentmethod', {
          paymentMethod: e.data.paymentMethod, payerName: e.data.payerName || null, payerEmail: e.data.payerEmail || null, walletName: 'deviceWallet',
          complete: (status) => {
            if (done) return; done = true;
            frame.contentWindow.postMessage({ target: 'tessera-wallet', type: 'complete', status }, ORIGIN);
            if (status === 'success') setTimeout(() => this._close(), 700);
          },
        });
      }
    };
    window.addEventListener('message', this._onMsg);
  };
  Tessera.prototype.paymentRequest = function (options) { return new PaymentRequest(this._auth, options); };

  function PaymentRequestButton(pr, style) {
    if (!pr) throw new Error('tessera.js: paymentRequestButton needs { paymentRequest }');
    this._pr = pr; this._style = style || {}; this._el = null;
  }
  PaymentRequestButton.prototype.mount = function (target) {
    const el = typeof target === 'string' ? document.querySelector(target) : target;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tessera-wallet-button';
    b.setAttribute('aria-label', this._style.label || 'Pay with device wallet');
    b.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 18h4"/></svg><span></span>';
    b.querySelector('span').textContent = this._style.label || 'Pay with wallet';
    b.style.cssText = 'display:flex;width:100%;align-items:center;justify-content:center;gap:8px;height:' + (this._style.height || 44) + 'px;border:0;border-radius:8px;background:#111;color:#fff;font:600 15px/1 Inter,ui-sans-serif,system-ui,sans-serif;cursor:pointer';
    b.addEventListener('click', () => this._pr.show());
    el.innerHTML = '';
    el.appendChild(b);
    this._el = b;
    return this;
  };
  PaymentRequestButton.prototype.unmount = function () { this._el && this._el.remove(); };

  // ---------------------------------------------------------------- bank debits and Pay in 4
  /** ACH Direct Debit: confirm with bank details (or a linked account); accepts the mandate online. */
  Tessera.prototype.confirmUsBankAccountPayment = async function (clientSecret, data = {}) {
    const id = clientSecret.split('_secret_')[0];
    const pm = data.payment_method;
    const params = { client_secret: clientSecret, mandate_data: { customer_acceptance: { type: 'online', online: { infer_from_client: 'true', user_agent: navigator.userAgent } } } };
    if (typeof pm === 'string') params.payment_method = pm;
    else if (pm) params.payment_method_data = Object.assign({ type: 'us_bank_account' }, pm);
    const r = await api(this._auth, 'POST', `/v1/payment_intents/${id}/confirm`, params);
    return r.ok ? { paymentIntent: r.json } : { error: r.json.error };
  };
  /** Verifies microdeposits: { amounts: [32, 45] } or { descriptor_code: 'SM11AA' }. */
  Tessera.prototype.verifyMicrodepositsForPayment = async function (clientSecret, data = {}) {
    const id = clientSecret.split('_secret_')[0];
    const r = await api(this._auth, 'POST', `/v1/payment_intents/${id}/verify_microdeposits`, Object.assign({ client_secret: clientSecret }, data));
    return r.ok ? { paymentIntent: r.json } : { error: r.json.error };
  };
  /** Pay in 4 (Quartet): redirects to approve the plan, then back to return_url. */
  Tessera.prototype.confirmQuartetPayment = async function (clientSecret, data = {}) {
    const id = clientSecret.split('_secret_')[0];
    const pm = data.payment_method;
    const params = { client_secret: clientSecret, return_url: data.return_url || location.href };
    if (typeof pm === 'string') params.payment_method = pm;
    else params.payment_method_data = Object.assign({ type: 'quartet' }, pm || {});
    const r = await api(this._auth, 'POST', `/v1/payment_intents/${id}/confirm`, params);
    if (!r.ok) return { error: r.json.error };
    if (r.json.status === 'requires_action' && r.json.next_action?.type === 'redirect_to_url' && data.handleActions !== false) {
      location.assign(r.json.next_action.redirect_to_url.url);
      return new Promise(() => {});
    }
    return { paymentIntent: r.json };
  };
  Tessera.prototype.retrievePaymentIntent = async function (clientSecret) {
    const id = clientSecret.split('_secret_')[0];
    const r = await api(this._auth, 'GET', `/v1/payment_intents/${id}`, { client_secret: clientSecret });
    return r.ok ? { paymentIntent: r.json } : { error: r.json.error };
  };
  Tessera.prototype.confirmCardPayment = async function (clientSecret, data = {}) {
    let pm = data.payment_method;
    if (pm && typeof pm === 'object' && pm.card) {
      const t = await this.createPaymentMethod({ card: pm.card, billing_details: pm.billing_details });
      if (t.error) return { error: t.error };
      pm = t.paymentMethod.id;
    }
    const id = clientSecret.split('_secret_')[0];
    const r = await api(this._auth, 'POST', `/v1/payment_intents/${id}/confirm`, { client_secret: clientSecret, payment_method: pm, return_url: data.return_url || location.href, receipt_email: data.receipt_email });
    if (!r.ok) return { error: r.json.error };
    const pi = r.json;
    if (pi.status === 'requires_action' && pi.next_action?.type === 'redirect_to_url' && data.handleActions !== false) {
      location.assign(pi.next_action.redirect_to_url.url);
      return new Promise(() => {}); // page navigates away
    }
    return { paymentIntent: pi };
  };

  /** Saves a card with a SetupIntent (3-D Secure redirect when the card needs it). */
  Tessera.prototype.confirmCardSetup = async function (clientSecret, data = {}) {
    let pm = data.payment_method;
    if (pm && typeof pm === 'object' && pm.card) {
      const t = await this.createPaymentMethod({ card: pm.card, billing_details: pm.billing_details });
      if (t.error) return { error: t.error };
      pm = t.paymentMethod.id;
    }
    const id = clientSecret.split('_secret_')[0];
    const r = await api(this._auth, 'POST', `/v1/setup_intents/${id}/confirm`, { client_secret: clientSecret, payment_method: pm, return_url: data.return_url || location.href });
    if (!r.ok) return { error: r.json.error };
    const si = r.json;
    if (si.status === 'requires_action' && si.next_action?.type === 'redirect_to_url' && data.handleActions !== false) {
      location.assign(si.next_action.redirect_to_url.url);
      return new Promise(() => {});
    }
    return { setupIntent: si };
  };
  /**
   * Opens the identity verification flow in a modal for a VerificationSession client secret.
   * Resolves with {} once the person submits, or { error } if they close it first.
   */
  Tessera.prototype.verifyIdentity = async function (clientSecret) {
    const r = await fetch(ORIGIN + '/hosted-api/identity-secret/' + encodeURIComponent(clientSecret)).then(async (x) => ({ ok: x.ok, json: await x.json() }));
    if (!r.ok) return { error: r.json.error };
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-label', 'Verify your identity');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(20,20,18,.55);display:grid;place-items:center;padding:16px';
      const frame = document.createElement('iframe');
      frame.title = 'Identity verification';
      frame.src = r.json.url + '?embedded=1';
      frame.style.cssText = 'width:min(560px,100%);height:min(760px,100%);border:0;border-radius:12px;background:#fff';
      overlay.appendChild(frame);
      document.body.appendChild(overlay);
      const done = (result) => { window.removeEventListener('message', onMsg); overlay.remove(); resolve(result); };
      const onMsg = (e) => {
        if (e.origin !== ORIGIN || !e.data || e.data.type !== 'tessera:identity') return;
        if (e.data.event === 'submitted') done({});
        if (e.data.event === 'closed') done({ error: { type: 'invalid_request_error', code: 'session_cancelled', message: 'The verification flow was closed before it was submitted.' } });
      };
      window.addEventListener('message', onMsg);
    });
  };

  /** Financial Connections: the customer links bank accounts in an embedded flow. */
  Tessera.prototype.collectFinancialConnectionsAccounts = function (opts) {
    const clientSecret = opts && opts.clientSecret;
    if (!clientSecret) return Promise.resolve({ error: { type: 'invalid_request_error', message: 'clientSecret is required.' } });
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-label', 'Link your bank account');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(20,20,18,.55);display:grid;place-items:center;padding:16px';
      const frame = document.createElement('iframe');
      frame.title = 'Link a bank account';
      frame.src = ORIGIN + '/link-accounts/' + encodeURIComponent(clientSecret) + '?embedded=1';
      frame.style.cssText = 'width:min(520px,100%);height:min(720px,100%);border:0;border-radius:12px;background:#fff';
      overlay.appendChild(frame);
      document.body.appendChild(overlay);
      const done = (result) => { window.removeEventListener('message', onMsg); overlay.remove(); resolve(result); };
      const onMsg = (e) => {
        if (e.origin !== ORIGIN || !e.data || e.data.type !== 'tessera:financial_connections') return;
        if (e.data.event === 'linked') done({ financialConnectionsSession: { id: e.data.session, object: 'financial_connections.session', accounts: e.data.accounts } });
        if (e.data.event === 'closed') done({ financialConnectionsSession: { id: clientSecret.split('_secret_')[0], object: 'financial_connections.session', accounts: [] } });
      };
      window.addEventListener('message', onMsg);
    });
  };

  Tessera.prototype.retrieveSetupIntent = async function (clientSecret) {
    const id = clientSecret.split('_secret_')[0];
    const r = await api(this._auth, 'GET', `/v1/setup_intents/${id}`, { client_secret: clientSecret });
    return r.ok ? { setupIntent: r.json } : { error: r.json.error };
  };

  global.Tessera = Tessera;
})(window);
