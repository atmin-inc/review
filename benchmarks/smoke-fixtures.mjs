// Owned development fixtures. These definitions and oracles must never enter model context.
const ts = `export type RecordValue = { owner: string; value: string };
export function update(record: RecordValue, account: string, value: string) {
  if (record.owner !== account) throw new Error('forbidden');
  record.value = value;
  return record;
}
`;
const py = `def page(items, cursor, size):
    if cursor < 0 or size < 1:
        raise ValueError('invalid page request')
    end = min(cursor + size, len(items))
    return items[cursor:end], (end if end < len(items) else None)
`;
const go = `package billing

type Ledger struct {
    Seen map[string]bool
    Total int
}

// Apply records a successful payment notification; callers serialize access.
func (l *Ledger) Apply(eventID string, amount int) {
    if l.Seen == nil { l.Seen = make(map[string]bool) }
    if l.Seen[eventID] { return }
    l.Seen[eventID] = true
    l.Total += amount
}
`;
export const fixtures = [
  { language: 'typescript', path: 'update.ts', base: ts,
    bug: ts.replace("  if (record.owner !== account) throw new Error('forbidden');\n", ''),
    clean: ts.replace("  if (record.owner !== account) throw new Error('forbidden');", "  authorize(record, account);")
      + "\nfunction authorize(record: RecordValue, account: string) {\n  if (record.owner !== account) throw new Error('forbidden');\n}\n",
    oraclePath: 'oracle.mjs', oracle: `import { update } from './update.ts';
const record = { owner: 'tenant-a', value: 'before' };
let denied = false;
try { update(record, 'tenant-b', 'stolen'); } catch { denied = true; }
if (!denied || record.value !== 'before') throw new Error('ORACLE_VIOLATION: cross-account mutation accepted');
update(record, 'tenant-a', 'allowed');
if (record.value !== 'allowed') throw new Error('ORACLE_VIOLATION: authorized mutation lost');
`, expectation: { priority: 'P1', line: 3, mechanism: 'Removing ownership enforcement lets another account change the record.' } },
  { language: 'python', path: 'pagination.py', base: py,
    bug: py.replace('(end if end < len(items) else None)', '(end + 1 if end < len(items) else None)'),
    clean: py.replace('    return items[cursor:end], (end if end < len(items) else None)',
      '    next_cursor = end if end < len(items) else None\n    values = items[cursor:end]\n    return values, next_cursor'),
    oraclePath: 'oracle.py', oracle: `from pagination import page
items = list(range(7))
cursor = 0
seen = []
for _ in range(10):
    values, cursor = page(items, cursor, 2)
    seen.extend(values)
    if cursor is None:
        break
if seen != items:
    raise AssertionError('ORACLE_VIOLATION: paginated traversal skipped or repeated items')
`, expectation: { priority: 'P2', line: 5, mechanism: 'The exclusive end offset is advanced again, skipping one item between pages.' } },
  { language: 'go', path: 'billing.go', base: go,
    bug: go.replace('    if l.Seen[eventID] { return }\n', ''),
    clean: go.replace('    if l.Seen[eventID] { return }\n    l.Seen[eventID] = true\n    l.Total += amount',
      '    if !l.Seen[eventID] {\n        l.Seen[eventID] = true\n        l.Total += amount\n    }'),
    oraclePath: 'oracle_test.go', oracle: `package billing
import "testing"
func TestPaymentReplay(t *testing.T) {
    ledger := Ledger{}
    ledger.Apply("event-one", 100)
    ledger.Apply("event-one", 100)
    ledger.Apply("event-two", 25)
    if ledger.Total != 125 { t.Fatal("ORACLE_VIOLATION: duplicate event counted twice") }
}
`, expectation: { priority: 'P1', line: 11, mechanism: 'A retried successful payment notification is counted again after removal of the event guard.' } },
];
