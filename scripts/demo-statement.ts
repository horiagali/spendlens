/**
 * Writes a synthetic Revolut statement CSV (fake people, fake merchants) for trying spendlens
 * without real data:  node scripts/demo-statement.ts > demo.csv
 * Story: a student who starts a job halfway through, then goes out more and buys a console.
 */
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;
const money = (n: number) => n.toFixed(2);

const rows: string[][] = [];
let balance = 800;
const add = (type: string, product: string, date: Date, desc: string, amount: number, fee = 0) => {
  if (product === 'Current') balance += amount - fee;
  const d = date.toISOString().replace('T', ' ').slice(0, 19);
  rows.push([type, product, d, d, desc, money(amount), money(fee), 'EUR', 'COMPLETED', money(balance)]);
};

const start = new Date(Date.UTC(2025, 6, 1));
const jobStart = new Date(Date.UTC(2026, 0, 15));
for (let day = 0; day < 500; day++) {
  const d = new Date(start.getTime() + day * 86_400_000 + Math.floor(rnd() * 12 + 8) * 3_600_000);
  const working = d >= jobStart;
  const dom = d.getUTCDate();
  if (dom === 1) add('TRANSFER', 'Current', d, 'To Sam Landlord', -450);
  if (dom === 25) add('TRANSFER', 'Current', d, working ? 'Payment from Northwind Systems BV' : 'Payment from Student Grants Office', working ? 2850 : 520);
  if (dom === 26 && working) { add('TRANSFER', 'Current', d, 'To EUR Savings', -600); add('TRANSFER', 'Savings', d, 'From EUR Current', 600); }
  if (dom === 3) add('CARD_PAYMENT', 'Current', d, 'Spotify', -10.99);
  if (dom === 8 && working) add('CARD_PAYMENT', 'Current', d, 'Netflix.com', -13.99);
  if (rnd() < 0.3) {
    const amt = -(20 + rnd() * 60);
    add('CARD_PAYMENT', 'Current', d, pick(['Albert Heijn 1234', 'Lidl 0042', 'Jumbo 556']), amt);
    add('TRANSFER', 'Current', d, 'To pocket EUR Round ups from EUR', -(Math.ceil(-amt) + amt));
    if (rnd() < 0.7) add('TRANSFER', 'Current', new Date(d.getTime() + 2 * 86_400_000), 'Transfer from ALEX ROOMMATE', Math.round((-amt / 2) * 100) / 100);
  }
  if (rnd() < (working ? 0.35 : 0.12)) add('CARD_PAYMENT', 'Current', d, pick(['SumUp *Cafe Noord', 'Bar Centraal', 'Thai Orchid', 'Uber *Eats']), -(8 + rnd() * (working ? 45 : 15)));
  if (working && rnd() < 0.06) add('CARD_PAYMENT', 'Current', d, pick(['Cinema Lumen', 'Restaurant De Kas', 'Cocktailbar Vesper']), -(40 + rnd() * 70));
  if (rnd() < 0.15) add('CARD_PAYMENT', 'Current', d, pick(['NS Reizigers', 'Uber *Trip']), -(3 + rnd() * 20));
  if (rnd() < 0.04) add('CARD_PAYMENT', 'Current', d, pick(['Bol.com', 'Zalando', 'HEMA']), -(15 + rnd() * 60));
  if (day === 260) add('CARD_PAYMENT', 'Current', d, 'Sony Interactive Entertainment', -549.99);
}
console.log(['Type', 'Product', 'Started Date', 'Completed Date', 'Description', 'Amount', 'Fee', 'Currency', 'State', 'Balance'].join(','));
for (const r of rows) console.log(r.map((v) => (/[,"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(','));
