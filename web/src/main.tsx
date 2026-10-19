import { AcceptInvite, DataTools, Emails, ScheduledReports, Security, SessionCtx, Team } from './pages/settings.tsx';
import { GlobalSearch, SearchPage } from './pages/b2b.tsx';
import { Capital, CapitalApply, Climate, ClimateCertificate, LinkAccounts, LinkedAccounts, RevenueRecognition } from './pages/services.tsx';
import { Files, Sql } from './pages/data.tsx';
import { StrictMode, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import './tokens.css';
import './styles.css';
import { dash, Link, match, Router, setCsrf, ToastProvider, useRouter } from './lib.tsx';
import { Badge, Icon } from './ui.tsx';
import { AuthPage } from './pages/auth.tsx';
import { Home } from './pages/home.tsx';
import { PaymentDetail, Payments } from './pages/payments.tsx';
import { CustomerDetail, Customers } from './pages/customers.tsx';
import { Balances } from './pages/balances.tsx';
import { CheckoutLinks, PaymentLinkDetail } from './pages/checkout.tsx';
import { MeterDetail, Meters, ScheduleDetail, Schedules } from './pages/growth.tsx';
import { LinkUnavailable } from './pages/hosted.tsx';
import { CreditNotes, Identity, ShippingRates, VerificationDetail, Verify } from './pages/finance.tsx';
import { IssuingAuthorizations, IssuingCardDetail, IssuingCards, ReaderDetail, Terminal } from './pages/operations.tsx';
import { FinancialAccountDetail, FinancialAccounts } from './pages/treasury.tsx';
import { Radar, Reviews } from './pages/radar.tsx';
import { ApiKeys, Events, Ledger, Logs, Webhooks } from './pages/developers.tsx';
import { PaymentMethodsSettings } from './pages/methods.tsx';
import { SystemHealth } from './pages/system.tsx';
import { BillingSettings, ElementsPlayground, Features } from './pages/billing2.tsx';
import { Authenticate, InvoicePay, Pay, QuartetApprove, Receipt, VerifyMicrodeposits } from './pages/hosted.tsx';
import { ApplicationFees, ConnectedAccountDetail, ConnectedAccounts, Payouts, Transfers } from './pages/connect.tsx';
import { ExpressDashboard, Onboarding } from './pages/hostedConnect.tsx';
import { DisputeDetail, Disputes } from './pages/disputes.tsx';
import { Reports } from './pages/reports.tsx';
import { Tax } from './pages/tax.tsx';
import { QuoteDetail, Quotes } from './pages/quotes.tsx';
import { Portal, PortalSettings } from './pages/portal.tsx';
import { Coupons, InvoiceDetail, Invoices, ProductDetail, Products, SubscriptionDetail, Subscriptions, TestClockDetail, TestClocks } from './pages/billing.tsx';

type Session = { user: { id: string; email: string; name: string | null; role: string; role_label: string; two_step: boolean }; permissions: { team: boolean; keys: boolean; sandbox: boolean; write: any }; account: any; csrf: string; api_version: string };

const NAV: ({ group: string } | { to: string; label: string; icon: string })[] = [
  { to: '/', label: 'Home', icon: 'home' },
  { to: '/payments', label: 'Payments', icon: 'card' },
  { to: '/customers', label: 'Customers', icon: 'users' },
  { to: '/balances', label: 'Balances', icon: 'wallet' },
  { to: '/payouts', label: 'Payouts', icon: 'bank' },
  { to: '/reports', label: 'Reports', icon: 'chart' },
  { to: '/sql', label: 'SQL', icon: 'database' },
  { to: '/scheduled-reports', label: 'Scheduled reports', icon: 'clock' },
  { to: '/checkout', label: 'Payment links', icon: 'link' },
  { to: '/shipping-rates', label: 'Shipping rates', icon: 'truck' },
  { to: '/identity', label: 'Identity', icon: 'id' },
  { to: '/terminal', label: 'Terminal', icon: 'terminal-reader' },
  { to: '/treasury', label: 'Financial accounts', icon: 'bank' },
  { to: '/linked-accounts', label: 'Linked accounts', icon: 'link' },
  { to: '/climate', label: 'Climate', icon: 'leaf' },
  { group: 'Issuing' },
  { to: '/issuing', label: 'Cards', icon: 'card' },
  { to: '/issuing/activity', label: 'Card activity', icon: 'list' },
  { group: 'Connect' },
  { to: '/connect/accounts', label: 'Connected accounts', icon: 'network' },
  { to: '/connect/transfers', label: 'Transfers', icon: 'send' },
  { to: '/connect/fees', label: 'Collected fees', icon: 'percent' },
  { to: '/capital', label: 'Capital', icon: 'coins' },
  { group: 'Billing' },
  { to: '/products', label: 'Products', icon: 'box' },
  { to: '/subscriptions', label: 'Subscriptions', icon: 'repeat' },
  { to: '/subscription-schedules', label: 'Schedules', icon: 'calendar' },
  { to: '/meters', label: 'Meters', icon: 'gauge' },
  { to: '/features', label: 'Features', icon: 'check' },
  { to: '/invoices', label: 'Invoices', icon: 'receipt' },
  { to: '/credit-notes', label: 'Credit notes', icon: 'receipt' },
  { to: '/revenue-recognition', label: 'Revenue recognition', icon: 'chart' },
  { to: '/quotes', label: 'Quotes', icon: 'quote' },
  { to: '/coupons', label: 'Coupons', icon: 'tag' },
  { to: '/test-clocks', label: 'Test clocks', icon: 'clock' },
  { to: '/tax', label: 'Tax', icon: 'percent' },
  { to: '/portal-settings', label: 'Customer portal', icon: 'users' },
  { group: 'Fraud' },
  { to: '/radar', label: 'Rules', icon: 'shield' },
  { to: '/reviews', label: 'Reviews', icon: 'flag' },
  { to: '/disputes', label: 'Disputes', icon: 'alert' },
  { group: 'Developers' },
  { to: '/developers/keys', label: 'API keys', icon: 'key' },
  { to: '/developers/webhooks', label: 'Webhooks', icon: 'hook' },
  { to: '/developers/events', label: 'Events', icon: 'list' },
  { to: '/developers/logs', label: 'Logs', icon: 'terminal' },
  { to: '/developers/ledger', label: 'Ledger', icon: 'book' },
  { to: '/developers/files', label: 'Files', icon: 'file' },
  { to: '/developers/emails', label: 'Emails', icon: 'mail' },
  { to: '/developers/elements', label: 'Elements', icon: 'card' },
  { to: '/developers/system', label: 'System health', icon: 'database' },
  { group: 'Settings' },
  { to: '/settings/payment-methods', label: 'Payment methods', icon: 'card' },
  { to: '/settings/billing', label: 'Billing', icon: 'repeat' },
  { to: '/settings/team', label: 'Team', icon: 'users' },
  { to: '/settings/security', label: 'Security', icon: 'shield' },
  { to: '/settings/data', label: 'Data', icon: 'database' },
];

function Shell({ session, children, onLogout }: { session: Session; children: ReactNode; onLogout: () => void }) {
  const { path } = useRouter();
  const p = path.split('?')[0]!;
  const active = (to: string) => (to === '/' ? p === '/' : p === to || p.startsWith(to + '/'));
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <div className="test-band" aria-hidden="true" />
      <div className="shell">
        <nav className="sidebar" aria-label="Main">
          <div className="brand">
            <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="var(--color-brand)" /><path d="M9 9h6v6H9zM17 9h6v6h-6zM9 17h6v6H9z" fill="var(--color-on-brand)" /><path d="M17 17h6v6h-6z" fill="var(--color-on-brand)" opacity=".5" /></svg>
            <div>Tessera<small>{session.account.business_profile?.name}</small></div>
          </div>
          {NAV.filter((n) => !('to' in n) || n.to !== '/developers/keys' || session.permissions.keys).map((n, i) =>
            'group' in n ? <div key={i} className="nav-group">{n.group}</div> : (
              <Link key={n.to} to={n.to} className="nav-item" aria-current={active(n.to) ? 'page' : undefined}><Icon name={n.icon} />{n.label}</Link>
            ),
          )}
        </nav>
        <div className="main">
          <header className="topbar">
            <div className="row"><Badge kind="test">Test mode</Badge><span className="muted topbar-note" style={{ fontSize: 13 }}>Simulated card network · no real money moves</span></div>
            <GlobalSearch />
            <div className="row">
              <span className="soft" style={{ fontSize: 13 }}>{session.user.email}</span>
              <Badge>{session.user.role_label}</Badge>
              <button className="btn btn-ghost btn-sm" onClick={onLogout}>Sign out</button>
            </div>
          </header>
          <main id="main" className="content">{children}</main>
        </div>
      </div>
    </>
  );
}

const ROUTES: [string, (p: Record<string, string>) => ReactNode][] = [
  ['/', () => <Home />],
  ['/payments', () => <Payments />],
  ['/payments/:id', (p) => <PaymentDetail id={p.id!} />],
  ['/customers', () => <Customers />],
  ['/customers/:id', (p) => <CustomerDetail id={p.id!} />],
  ['/balances', () => <Balances />],
  ['/checkout', () => <CheckoutLinks />],
  ['/shipping-rates', () => <ShippingRates />],
  ['/identity', () => <Identity />],
  ['/identity/:id', (p) => <VerificationDetail id={p.id!} />],
  ['/credit-notes', () => <CreditNotes />],
  ['/terminal', () => <Terminal />],
  ['/treasury', () => <FinancialAccounts />],
  ['/treasury/:id', (p) => <FinancialAccountDetail id={p.id!} />],
  ['/terminal/readers/:id', (p) => <ReaderDetail id={p.id!} />],
  ['/issuing', () => <IssuingCards />],
  ['/issuing/activity', () => <IssuingAuthorizations />],
  ['/issuing/cards/:id', (p) => <IssuingCardDetail id={p.id!} />],
  ['/payment-links/:id', (p) => <PaymentLinkDetail id={p.id!} />],
  ['/meters', () => <Meters />],
  ['/meters/:id', (p) => <MeterDetail id={p.id!} />],
  ['/subscription-schedules', () => <Schedules />],
  ['/subscription-schedules/:id', (p) => <ScheduleDetail id={p.id!} />],
  ['/payouts', () => <Payouts />],
  ['/reports', () => <Reports />],
  ['/sql', () => <Sql />],
  ['/scheduled-reports', () => <ScheduledReports />],
  ['/developers/emails', () => <Emails />],
  ['/developers/system', () => <SystemHealth />],
  ['/developers/elements', () => <ElementsPlayground />],
  ['/settings/billing', () => <BillingSettings />],
  ['/features', () => <Features />],
  ['/settings/payment-methods', () => <PaymentMethodsSettings />],
  ['/settings/team', () => <Team />],
  ['/settings/security', () => <Security />],
  ['/settings/data', () => <DataTools />],
  ['/search', () => <SearchPage />],
  ['/climate', () => <Climate />],
  ['/capital', () => <Capital />],
  ['/linked-accounts', () => <LinkedAccounts />],
  ['/revenue-recognition', () => <RevenueRecognition />],
  ['/developers/files', () => <Files />],
  ['/tax', () => <Tax />],
  ['/quotes', () => <Quotes />],
  ['/quotes/:id', (p) => <QuoteDetail id={p.id!} />],
  ['/portal-settings', () => <PortalSettings />],
  ['/disputes', () => <Disputes />],
  ['/disputes/:id', (p) => <DisputeDetail id={p.id!} />],
  ['/connect/accounts', () => <ConnectedAccounts />],
  ['/connect/accounts/:id', (p) => <ConnectedAccountDetail id={p.id!} />],
  ['/connect/transfers', () => <Transfers />],
  ['/connect/fees', () => <ApplicationFees />],
  ['/products', () => <Products />],
  ['/products/:id', (p) => <ProductDetail id={p.id!} />],
  ['/subscriptions', () => <Subscriptions />],
  ['/subscriptions/:id', (p) => <SubscriptionDetail id={p.id!} />],
  ['/invoices', () => <Invoices />],
  ['/invoices/:id', (p) => <InvoiceDetail id={p.id!} />],
  ['/coupons', () => <Coupons />],
  ['/test-clocks', () => <TestClocks />],
  ['/test-clocks/:id', (p) => <TestClockDetail id={p.id!} />],
  ['/radar', () => <Radar />],
  ['/reviews', () => <Reviews />],
  ['/developers/keys', () => <ApiKeys />],
  ['/developers/webhooks', () => <Webhooks />],
  ['/developers/events', () => <Events />],
  ['/developers/logs', () => <Logs />],
  ['/developers/ledger', () => <Ledger />],
];

function App() {
  const { path, navigate } = useRouter();
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const load = () => dash<Session>('GET', '/session').then((s) => { setCsrf(s.csrf); setSession(s); }, () => setSession(null));
  useEffect(() => { load(); }, []);

  // Public hosted pages do not need a dashboard session.
  const pay = match('/pay/:id', path);
  if (pay) return <Pay id={pay.id!} />;
  const auth = match('/authenticate/:id', path);
  if (auth) return <Authenticate id={auth.id!} />;
  const invPay = match('/invoices/pay/:id', path);
  if (invPay) return <InvoicePay id={invPay.id!} />;
  const onboard = match('/connect/onboarding/:token', path);
  if (onboard) return <Onboarding token={onboard.token!} />;
  const express = match('/connect/express/:token', path);
  if (express) return <ExpressDashboard token={express.token!} />;
  const portal = match('/portal/:token', path);
  if (portal) return <Portal token={portal.token!} />;
  const verify = match('/verify/:token', path);
  if (verify) return <Verify token={verify.token!} />;
  const unavailable = match('/link-unavailable/:code', path);
  if (unavailable) return <LinkUnavailable code={unavailable.code!} />;
  const receipt = match('/receipts/:id', path);
  if (receipt) return <Receipt id={receipt.id!} />;
  const linkAccounts = match('/link-accounts/:secret', path);
  if (linkAccounts) return <LinkAccounts secret={linkAccounts.secret!} />;
  const capitalApply = match('/capital/apply/:token', path);
  if (capitalApply) return <CapitalApply token={capitalApply.token!} />;
  const cert = match('/climate/certificates/:token', path);
  if (cert) return <ClimateCertificate token={cert.token!} />;
  const invite = match('/invite/:token', path);
  if (invite) return <AcceptInvite token={invite.token!} />;
  const quartet = match('/quartet/:id', path);
  if (quartet) return <QuartetApprove id={quartet.id!} />;
  const micro = match('/verify-microdeposits/:id', path);
  if (micro) return <VerifyMicrodeposits id={micro.id!} />;

  if (session === undefined) return <div className="center-page muted">Loading…</div>;
  if (session === null) return <AuthPage onDone={() => { load(); navigate('/'); }} />;

  let page: ReactNode = <div className="empty"><h2>Page not found</h2></div>;
  for (const [pattern, render] of ROUTES) {
    const m = match(pattern, path);
    if (m) { page = render(m); break; }
  }
  return (
    <SessionCtx.Provider value={session}>
      <Shell session={session} onLogout={async () => { await dash('POST', '/logout'); setSession(null); navigate('/'); }}>
        {page}
      </Shell>
    </SessionCtx.Provider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Router>
      <ToastProvider>
        <App />
      </ToastProvider>
    </Router>
  </StrictMode>,
);
