import { Card, CardContent, CardHeader } from './ui/card.jsx';
import { Figure, Link, Notice, PageHeader, Progress } from './components.jsx';
import { count, credit, monthName, plural, usd, utcDate } from './format.js';
import { routeHref } from './route.js';

// Below this, credit is shown as running low, as the PR comment does (render.ts `lowCreditUsd`).
const lowCreditUsd = 2;

// Shown wherever reviews are not running, or soon will not, because of the organization's plan
// or credit. `link` adds a link to the page that explains it: Billing for credit, Usage otherwise.
export function UsageNotice({ installation, link = false }) {
  const { plan, usage, account, billing, creditUsd } = installation;
  const to = (view, label) => link && <Link className="link whitespace-nowrap" href={routeHref({ view, installation: installation.id })}>{label}</Link>;
  if (plan.monthlyReviews === 0) {
    return <Notice action={to('usage', 'View usage')}>Reviews are turned off for {account}. Contact atmin to turn them on.</Notice>;
  }
  if (usage.reviews >= plan.monthlyReviews) {
    return <Notice action={to('usage', 'View usage')}>
      {account} used all {count(plan.monthlyReviews)} reviews for {monthName(usage.month)}. Until reviews resume on {utcDate(usage.resetsAt)}, pull requests get a “review not run” comment instead.
    </Notice>;
  }
  if (usage.reviews < plan.freeReviews) return null;
  const free = plan.freeReviews ? <>used its {count(plan.freeReviews)} free reviews for {monthName(usage.month)} and </> : null;
  if (creditUsd <= 0) {
    return <Notice action={billing && to('billing', 'Buy credit')}>
      {account} {free}has no review credit left. {billing ? 'A repository admin can buy credit to keep reviewing' : 'Contact atmin to add credit'}{plan.freeReviews ? `; otherwise free reviews start again on ${utcDate(usage.resetsAt)}` : ''}.
    </Notice>;
  }
  // Auto top-up refills it before it runs out, unless it stopped.
  if (creditUsd < lowCreditUsd && !(billing?.topUp.usd && !billing.topUp.failed)) {
    return <Notice action={billing && to('billing', 'Buy credit')}>
      {account} has {credit(creditUsd)} of review credit left. Reviews past the free ones stop when it runs out.
    </Notice>;
  }
  return null;
}

export function UsagePage({ installation }) {
  const { plan, usage, account } = installation;
  const free = Math.max(0, plan.freeReviews - usage.reviews);
  const off = plan.monthlyReviews === 0;
  return <>
    <PageHeader title="Usage">
      Reviews for {account} in {monthName(usage.month)}. Counts reset on {utcDate(usage.resetsAt)} at 00:00 UTC.
    </PageHeader>
    <div className="grid grid-cols-1 gap-4">
      <UsageNotice installation={installation}/>
      <div className="usage-grid">
        <Card>
          <CardHeader><h2 className="panel-title">Reviews this month</h2></CardHeader>
          <CardContent className="grid gap-4">
            <p className="flex items-baseline gap-2">
              <Figure className="text-[28px] leading-none">{count(usage.reviews)}</Figure>
              <span className="text-muted-foreground">{off ? 'reviews started' : <>of <Figure>{count(plan.monthlyReviews)}</Figure></>}</span>
            </p>
            {!off && <Progress value={usage.reviews} max={plan.monthlyReviews} label={`${usage.reviews} of ${plan.monthlyReviews} reviews used this month`}/>}
            <dl className="facts">
              {!off && <div><dt>Free reviews left</dt><dd><Figure>{count(free)}</Figure> of <Figure>{count(plan.freeReviews)}</Figure></dd></div>}
              <div><dt>Reviews left this month</dt><dd><Figure>{count(usage.remaining)}</Figure></dd></div>
              <div><dt>Resets</dt><dd>{utcDate(usage.resetsAt)}</dd></div>
            </dl>
            <p className="text-[13px] text-muted-foreground">Counts every review that started this month, including failed ones.</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><h2 className="panel-title">Paid from credit</h2></CardHeader>
          <CardContent className="grid gap-4">
            <p><Figure className="text-[28px] leading-none">{usd(usage.estimatedUsd)}</Figure></p>
            <p className="text-muted-foreground">For reviews beyond the {plural(plan.freeReviews, 'free review')} this month. <Figure>{credit(installation.creditUsd)}</Figure> of credit left.</p>
            {installation.billing && <Link className="link justify-self-start" href={routeHref({ view: 'billing', installation: installation.id })}>Buy credit and set auto top-up</Link>}
            {usage.unknownCostReviews > 0 && <p className="text-[13px] text-muted-foreground">
              Leaves out {plural(usage.unknownCostReviews, 'review')} whose cost is not settled yet; each is paid once it settles.
            </p>}
          </CardContent>
        </Card>
      </div>
    </div>
  </>;
}
