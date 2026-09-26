import { Card, CardContent, CardHeader } from './ui/card.jsx';
import { Figure, Link, Notice, PageHeader, Progress } from './components.jsx';
import { count, monthName, plural, usd, utcDate } from './format.js';
import { routeHref } from './route.js';

// Shown wherever reviews are not running because of the organization's plan.
export function UsageNotice({ installation, link = false }) {
  const { plan, usage, account } = installation;
  const more = link && <Link className="link whitespace-nowrap" href={routeHref({ view: 'usage', installation: installation.id })}>View usage</Link>;
  if (plan.monthlyReviews === 0) {
    return <Notice action={more}>Reviews are turned off for {account}. Contact atmin to turn them on.</Notice>;
  }
  if (usage.reviews >= plan.monthlyReviews) {
    return <Notice action={more}>
      {account} used all {count(plan.monthlyReviews)} reviews for {monthName(usage.month)}. Until reviews resume on {utcDate(usage.resetsAt)}, pull requests get a “review not run” comment instead.
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
          <CardHeader><h2 className="panel-title">Estimated charges</h2></CardHeader>
          <CardContent className="grid gap-4">
            <p><Figure className="text-[28px] leading-none">{usd(usage.estimatedUsd)}</Figure></p>
            <p className="text-muted-foreground">An estimate for reviews beyond the {plural(plan.freeReviews, 'free review')} this month.</p>
            {usage.unknownCostReviews > 0 && <p className="text-[13px] text-muted-foreground">
              The estimate leaves out {plural(usage.unknownCostReviews, 'review')} whose cost is not settled yet.
            </p>}
          </CardContent>
        </Card>
      </div>
    </div>
  </>;
}
