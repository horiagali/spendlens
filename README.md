# spendlens

**See where your Revolut money actually goes, on your own machine.**

spendlens is a small, local-first spending tracker for Revolut personal accounts. It fixes what the Revolut app's own analytics get wrong:

- **Splitting bills.** You pay €60 for groceries and your roommate sends you €30: spendlens counts €30 of groceries, not €60 spent and €30 earned. It spots these paybacks for you and links them in one click.
- **Noise.** Spare-change round-ups, moves to savings vaults, pockets and currency exchanges are filtered out automatically. They are your money moving around, not spending.
- **Real categories.** Label a merchant once and every past and future payment there is labeled. Add your own rules for everything else.
- **"Am I spending more?"** Compare average monthly spending before and after a date (a new job, a move), per category, and with big one-off purchases set aside.

## Why local

- **Your data stays yours.** Everything lives in one SQLite file on your computer. No account, no cloud, no third-party budgeting service storing your transactions, no telemetry.
- **No AI needed.** Categorizing is done by plain, transparent rules you can see and edit. Nothing is sent to a model, and nothing is guessed behind your back.
- **Open source.** Read every line that touches your money. MIT licensed.
- **Tiny.** Node.js plus a built-in SQLite database. The server has zero runtime dependencies.

## Getting started

Requires **Node.js 24+**.

```sh
git clone https://github.com/horiagali/spendlens.git
cd spendlens
npm run setup      # installs dependencies and builds the web app
npm start          # http://127.0.0.1:5174
```

The server only listens on `127.0.0.1`, so it is not reachable from other devices.

### Import your history

In the Revolut app go to **Accounts → ⋯ → Statement → Excel/CSV**, pick a period (as long as you like) and download it. Then drop the file on the **Import & settings** page, or:

```sh
npm run import -- ~/Downloads/account-statement.csv
```

Re-importing overlapping periods is safe: duplicates are skipped and pending payments are updated once they complete.

Want to try it without your own data first? `npm run demo` writes a made-up statement to `data/demo-statement.csv`.

### Then

1. **Label** merchants on the *Label* page, most frequent first. A few dozen labels usually cover almost everything.
2. **Splits**: confirm the suggested "someone paid you back" matches.
3. **Transactions**: tick big purchases as *one-off* (1×), fix anything odd. Your manual changes always win over rules.
4. **Overview**: pick a date under *Before vs after* to see how your spending changed.

## Automatic sync (optional)

Revolut has no public API for personal accounts, but EU Open Banking (PSD2) lets you read your own account through a licensed provider. [Enable Banking](https://enablebanking.com) offers this **free for personal use** ("restricted" production mode, which can only read accounts you link yourself). Your transactions go from Revolut via Enable Banking straight to your machine.

1. Create an account at enablebanking.com → *Control Panel* → *API applications* → *Add a new application*.
   - Environment: **Production** (Sandbox only has fake banks).
   - Key: *Generate in the browser*. Save the downloaded `.pem` file as `data/enablebanking.pem`.
   - Redirect URL: `https://localhost/callback`. It does not have to load; you'll copy the URL from the address bar.
   - Then *Activate by linking accounts* and link your Revolut account(s), including every currency pocket you use.
2. Run `npm run bank -- setup` and enter the application ID and your country.
3. Run `npm run bank -- link`. Open the printed URL, approve in Revolut, and paste back the URL you land on. The first sync then fetches as much history as Revolut allows.

While `npm start` is running it syncs every 8 hours. Access lasts about 180 days; the *Import & settings* page tells you when to run `npm run bank -- link` again. CSV imports and bank sync can be mixed: the same payment from both sources is only counted once.

## How it decides what counts

Every transaction gets a **kind**:

| Kind | Meaning | Counts as |
|---|---|---|
| `spend` | purchases, fees, and refunds (which reduce spending) | spending |
| `income` | salary and other money from outside | income |
| `reimbursement` | someone paying you back; nets against the linked expense | reduces that expense |
| `internal` | savings, vaults, round-ups, exchanges, transfers between your own accounts | nothing |
| `excluded` | failed/reverted payments, or anything you choose to ignore | nothing |

**Rules** (on the *Rules* page) set kinds and categories. They run in priority order; built-in rules handle Revolut's noise and can be edited or disabled. Tip: add a rule *counterparty is "Your Name" → internal* for transfers between your own accounts at other banks.

## Your data

Everything lives in `data/` (override with `SPENDLENS_DATA=/path`): the database, Enable Banking config and key. It is git-ignored, and a pre-commit hook refuses to commit CSVs, keys, databases or anything that looks like an IBAN. Back it up by copying the folder.

## Development

```sh
npm run dev        # API server with auto-reload (port 5174)
npm run dev:web    # web app with hot reload (port 5173, proxies /api)
npm test
npm run typecheck
```

- `server/`: TypeScript run directly by Node (no build step), `node:sqlite`, no runtime dependencies.
- `web/`: React + Vite, hand-made SVG charts.

## Limitations

- Only Revolut CSV exports and Enable Banking are supported as sources (PRs for other banks welcome).
- Reports use one base currency (default EUR); transactions in other currencies are listed but not converted.
- Bank sync gives dates without times, and vault/round-up moves are recognized by their description text. If something slips through, add a rule.
