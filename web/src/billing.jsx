import { useEffect, useRef, useState } from 'react';
import { CreditCard } from 'lucide-react';
import { api } from './api.js';
import { Badge } from './ui/badge.jsx';
import { Button } from './ui/button.jsx';
import { Card, CardAction, CardContent, CardHeader } from './ui/card.jsx';
import { Switch } from './ui/switch.jsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.jsx';
import { Figure, Notice, PageHeader } from './components.jsx';
import { count, credit, money, monthName, plural, usd, utcDate } from './format.js';
import { routeHref } from './route.js';
import { UsageNotice } from './usage.jsx';

const kinds = { purchase: 'Credit bought', 'top-up': 'Auto top-up', grant: 'Added by atmin' };
const kindLabel = row => (row.kind === 'grant' && row.usd < 0 ? 'Removed by atmin' : kinds[row.kind] ?? row.kind);
// Turning auto top-up on starts at this amount; the admin can pick another.
const defaultTopUp = 25;

function price(plan) {
  const multiplier = `model cost × ${plan.multiplier}`;
  return plan.minimumUsd > 0 ? `${multiplier}, at least ${money(plan.minimumUsd)}` : multiplier;
}

// What is left, and buying more on Stripe's Checkout page. Stripe returns here with
// ?checkout=<session>, and the server checks Stripe took the payment before adding the credit.
function Balance({ installation, checkout, patchInstallation }) {
  const { billing, creditUsd } = installation;
  // `pending` is the amount whose Checkout page is opening, or 'confirm' while a return is checked.
  const [status, setStatus] = useState({ pending: null, error: null, added: null });
  const confirmed = useRef(null);

  useEffect(() => {
    if (!checkout || confirmed.current === checkout) return;
    confirmed.current = checkout;
    window.history.replaceState(null, '', routeHref({ view: 'billing', installation: installation.id }));
    setStatus({ pending: 'confirm', error: null, added: null });
    api.billingConfirm(installation.id, checkout).then(result => {
      const { addedUsd, card, ...change } = result;
      console.info(`atmin review: ${addedUsd} USD of credit added for installation ${installation.id}`);
      patchInstallation(installation.id, change);
      setStatus({ pending: null, error: null, added: addedUsd });
    }, failure => {
      console.info(`atmin review: credit confirmation failed for installation ${installation.id}: ${failure.status}`);
      setStatus({ pending: null, error: failure.message, added: null });
    });
  }, [checkout, installation.id, patchInstallation]);

  async function buy(amount) {
    setStatus({ pending: amount, error: null, added: null });
    try {
      const { url } = await api.billingCheckout(installation.id, amount);
      console.info(`atmin review: credit checkout for ${amount} USD opened for installation ${installation.id}`);
      window.location.assign(url);
    } catch (failure) {
      console.info(`atmin review: credit checkout failed for installation ${installation.id}: ${failure.status}`);
      setStatus({ pending: null, error: failure.message, added: null });
    }
  }

  return <Card>
    <CardHeader><h2 className="panel-title">Review credit</h2></CardHeader>
    <CardContent className="grid gap-4">
      {status.pending === 'confirm' && <Notice>Checking the payment with Stripe…</Notice>}
      {status.added !== null && <Notice>Added {credit(status.added)} of credit.</Notice>}
      {status.error && <Notice tone="error">{status.error}</Notice>}
      <p className="flex items-baseline gap-2">
        <Figure className="text-[28px] leading-none">{credit(creditUsd)}</Figure>
        <span className="text-muted-foreground">left</span>
      </p>
      {creditUsd < 0 && <p className="text-[13px] text-muted-foreground">The last review cost more than was left. The next purchase covers it.</p>}
      <div className="grid gap-2">
        <p className="text-[13px] font-medium">Buy credit</p>
        <div className="flex flex-wrap gap-2">
          {billing.amounts.map(amount => <Button key={amount} variant="outline" className="min-w-20" disabled={status.pending !== null} onClick={() => buy(amount)}>
            {status.pending === amount ? 'Opening Stripe…' : money(amount)}
          </Button>)}
        </div>
      </div>
      <p className="text-[13px] text-muted-foreground">Paid on Stripe’s page, in US dollars. Credit does not expire, and the card you pay with is saved for auto top-up.</p>
    </CardContent>
  </Card>;
}

// Charges the saved card a chosen amount whenever credit falls below a threshold, so reviews
// do not stop. A charge the card does not pay stops it until an admin buys credit or retries.
function AutoTopUp({ installation, patchInstallation }) {
  const { billing } = installation, { topUp } = billing;
  const [status, setStatus] = useState({ pending: false, error: null });
  // A failed top-up keeps its amount but is off until it is tried again.
  const on = topUp.usd !== null && !topUp.failed;

  async function save(usd) {
    setStatus({ pending: true, error: null });
    try {
      const change = await api.billingTopUp(installation.id, usd);
      console.info(`atmin review: auto top-up for installation ${installation.id} ${usd === null ? 'turned off' : `set to ${usd} USD`}`);
      patchInstallation(installation.id, change);
      setStatus({ pending: false, error: null });
    } catch (failure) {
      console.info(`atmin review: saving auto top-up failed for installation ${installation.id}: ${failure.status}`);
      setStatus({ pending: false, error: failure.message });
    }
  }

  return <Card>
    <CardHeader>
      <h2 className="panel-title">Auto top-up</h2>
      <CardAction>
        <Switch aria-label="Auto top-up" checked={on} disabled={!billing.card || status.pending} onCheckedChange={checked => save(checked ? topUp.usd ?? defaultTopUp : null)}/>
      </CardAction>
    </CardHeader>
    <CardContent className="grid gap-4">
      {topUp.failed && <Notice tone="error" action={<Button size="sm" variant="outline" disabled={status.pending} onClick={() => save(topUp.usd)}>Try again</Button>}>
        Auto top-up stopped. {topUp.failed} Buy credit with another card, or try this one again.
      </Notice>}
      {status.error && <Notice tone="error">{status.error}</Notice>}
      {!billing.card
        ? <p className="text-muted-foreground">Buy credit once to save a card. Auto top-up charges it when credit runs low.</p>
        : on
          ? <p>When credit falls below <Figure>{money(topUp.belowUsd)}</Figure>, {billing.card} is charged <Figure>{money(topUp.usd)}</Figure>.</p>
          : <p className="text-muted-foreground">Off. Reviews past the free ones stop when credit runs out.</p>}
      {billing.card && on && <div role="group" aria-label="Top-up amount" className="flex flex-wrap gap-2">
        {billing.amounts.map(amount => <Button key={amount} size="sm" variant={amount === topUp.usd ? 'default' : 'outline'} aria-pressed={amount === topUp.usd}
          disabled={status.pending} onClick={() => amount !== topUp.usd && save(amount)}>{money(amount)}</Button>)}
      </div>}
    </CardContent>
  </Card>;
}

function PlanCard({ installation }) {
  const { plan, usage } = installation;
  return <Card>
    <CardHeader>
      <h2 className="panel-title">Plan</h2>
      <CardAction><Badge variant="secondary">{plan.custom ? 'Custom plan' : 'Prepaid'}</Badge></CardAction>
    </CardHeader>
    <CardContent className="grid gap-4">
      <dl className="facts">
        <div><dt>Free reviews</dt><dd><Figure>{count(plan.freeReviews)}</Figure> a month</dd></div>
        <div><dt>Each review after that</dt><dd>{price(plan)}</dd></div>
        <div><dt>Review limit</dt><dd>{plan.monthlyReviews ? <><Figure>{count(plan.monthlyReviews)}</Figure> a month</> : 'Reviews off'}</dd></div>
        <div><dt>Paid from credit in {monthName(usage.month)}</dt><dd><Figure>{usd(usage.estimatedUsd)}</Figure></dd></div>
      </dl>
      <p className="text-[13px] text-muted-foreground">
        {plan.custom ? 'Set by atmin for this organization. ' : ''}Each PR comment shows what its review cost and the credit left.
      </p>
    </CardContent>
  </Card>;
}

// The card the last purchase saved; buying credit with another card replaces it.
function PaymentMethod({ installation }) {
  const { billing, account } = installation;
  return <Card>
    <CardHeader><h2 className="panel-title">Payment method</h2></CardHeader>
    <CardContent className="grid gap-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-md border bg-muted text-muted-foreground"><CreditCard aria-hidden="true" className="size-5"/></span>
        <div className="grid min-w-48 flex-1 gap-0.5">
          <p className="font-medium">{billing.card ?? 'No card saved'}</p>
          <p className="text-[13px] text-muted-foreground">
            {billing.card
              ? `${billing.expires ? `Expires ${billing.expires}. ` : ''}${billing.email ? `Receipts go to ${billing.email}.` : 'Stripe has no email for receipts.'}`
              : 'Buying credit saves the card you pay with.'}
          </p>
        </div>
      </div>
      <p className="text-[13px] text-muted-foreground">
        Buying credit with a different card replaces this one. Stripe keeps the card details; only an admin of a repository connected in {account} can buy credit or change auto top-up.
      </p>
    </CardContent>
  </Card>;
}

// Purchases, top-ups and credit atmin added, newest first, with Stripe's receipt for each payment.
function History({ installation }) {
  const { billing } = installation;
  return <Card className="panel">
    <CardHeader className="panel-toolbar border-b"><h2 className="panel-title">Credit history</h2></CardHeader>
    <div className="panel-table overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="max-sm:hidden">Date</TableHead>
            <TableHead>Description</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead><span className="sr-only">Receipt</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {billing.history.length === 0 && <TableRow>
            <TableCell colSpan={4} className="empty-cell">No credit yet. Reviews paid from credit are on the Usage page.</TableCell>
          </TableRow>}
          {billing.history.map((row, index) => <TableRow key={`${row.date}-${index}`}>
            <TableCell className="max-sm:hidden">{utcDate(row.date)}</TableCell>
            <TableCell>{kindLabel(row)}<div className="text-[13px] text-muted-foreground sm:hidden">{utcDate(row.date)}</div></TableCell>
            <TableCell className="text-right"><Figure>{row.usd > 0 ? '+' : ''}{credit(row.usd)}</Figure></TableCell>
            <TableCell className="text-right">
              {row.receipt && <a className="link" href={row.receipt} target="_blank" rel="noreferrer"
                onClick={() => console.info(`atmin review: ${row.kind} receipt opened for installation ${installation.id}`)}>Receipt</a>}
            </TableCell>
          </TableRow>)}
        </TableBody>
      </Table>
    </div>
  </Card>;
}

export function BillingPage({ installation, checkout, patchInstallation }) {
  const { account, billing, plan } = installation;
  if (!billing) {
    return <PageHeader title="Billing">Credit cannot be bought on this atmin service. {account} gets its free reviews each month, and atmin can add credit.</PageHeader>;
  }
  return <>
    <PageHeader title="Billing">{account} gets {plural(plan.freeReviews, 'free review')} a month. Reviews after that are paid from prepaid credit.</PageHeader>
    <div className="grid grid-cols-1 gap-4">
      <UsageNotice installation={installation}/>
      <div className="usage-grid">
        <Balance installation={installation} checkout={checkout} patchInstallation={patchInstallation}/>
        <AutoTopUp installation={installation} patchInstallation={patchInstallation}/>
      </div>
      <div className="usage-grid">
        <PlanCard installation={installation}/>
        <PaymentMethod installation={installation}/>
      </div>
      <History installation={installation}/>
    </div>
  </>;
}
