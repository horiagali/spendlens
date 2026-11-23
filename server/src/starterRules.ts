import type { Condition } from './rules.ts';
import type { Kind } from './types.ts';

/**
 * Category labels for common (mostly Dutch / EU) chains and payees, added to new databases at
 * priority 150 so anything you label yourself (priority 100) wins. They are ordinary rules:
 * edit or delete them on the Rules page.
 */
export const STARTER_RULES: { name: string; category: string; kind?: Kind; conditions: Condition[] }[] = [];

const merchant = (name: string, category: string, pattern: string, extra: Condition[] = []) =>
  STARTER_RULES.push({ name, category, conditions: [{ field: 'merchant', op: 'regex', value: pattern }, ...extra] });
const out: Condition = { field: 'direction', op: 'equals', value: 'out' };
const inbound: Condition = { field: 'direction', op: 'equals', value: 'in' };
const transfer: Condition = { field: 'type', op: 'equals', value: 'TRANSFER' };

// Rent and tuition first: their memos ("For Dirk", "rent") must not be mistaken for groceries.
STARTER_RULES.push({ name: 'Rent paid by transfer (memo mentions rent/huur)', category: 'Rent',
  conditions: [out, transfer, { field: 'reference', op: 'regex', value: '\\b(rent|huur)\\b' }] });
merchant('Student housing', 'Rent', '\\b(duwo|ssh|xior|holland2stay)\\b');
// Not "For SPAR University To <friend>": that is a split-bill share of a shop on campus.
merchant('University tuition', 'Tuition', '\\b(universit(y|eit)|hogeschool|tu delft|tu eindhoven)\\b',
  [out, transfer, { field: 'reference', op: 'regex', value: '^(?!For\\s)' }]);
STARTER_RULES.push({ name: 'Tuition (memo mentions collegegeld/tuition)', category: 'Tuition',
  conditions: [out, { field: 'reference', op: 'regex', value: '\\b(collegegeld|tuition)\\b' }] });

merchant('Supermarkets', 'Groceries',
  '^(albert heijn|jumbo|lidl|aldi|spar|dirk|hoogvliet|plus|coop|vomar|ekoplaza|picnic|makro|carrefour|rewe|edeka|kaufland|tesco|sainsbury|mercadona|billa|penny|netto|7-eleven)\\b|\\b(ah to go|super ?markt|supermarket|flink|picnic|hellofresh|too good to go)\\b');
merchant('Food delivery & chains', 'Eating out',
  '\\b(uber eats|thuisbezorgd|deliveroo|just eat|mcdonald|burger king|kfc|starbucks|subway|domino|new york pizza|febo)\\b');
merchant('Public transport & rides', 'Transport',
  '^(ns|ns reizigers|ns internationaal|ns nl|uber|uber trip|bolt|greenwheels|lime|tier|ov-chipkaart|trans link|ret|htm|gvb|arriva|connexxion|qbuzz|atac|flixbus|db vertrieb|sncb)\\b');
// OVpay: tapping a bank card on Dutch public transport shows up as "NLOV" plus a random token.
merchant('OVpay public transport', 'Transport', '^nlov[a-z0-9]{10,}$');
merchant('Airlines & stays', 'Travel',
  '\\b(klm|ryanair|easyjet|wizz air|transavia|lufthansa|vueling|tarom|airbnb|booking com|hostelworld)\\b');
merchant('Subscriptions', 'Subscriptions',
  '\\b(spotify|netflix|disney|youtube|apple com bill|basic-fit|basic fit|anthropic|openai|chatgpt|google one|icloud|audible|hbo)');
merchant('Shops', 'Shopping',
  '^(action|ikea|hema|h&m|nl\\d+ - h&m|zara|primark|bol com|bol\\.com|amazon|amzn|temu|shein|decathlon|nike|adidas|uniqlo|blokker)\\b');
merchant('Electronics & games', 'Electronics & games',
  '^(steam|steamgames|playstation|nintendo|xbox|epic games|media ?markt|coolblue|proshop|lenovo|alternate|azerty)\\b');
merchant('Drugstores & pharmacies', 'Health', '\\b(kruidvat|etos|apotheek|pharmacy|da drogist|huisarts|tandarts)\\b');
merchant('Climbing & gyms', 'Sport', '\\b(boulder|klimhal|sportcentrum)');
merchant('Health insurance, phone, energy & local taxes', 'Bills & insurance',
  '\\b(zorgverzekeraar|vgz|zilveren kruis|menzis|ohra|youfone|odido|kpn|vodafone|ziggo|lebara|simyo|eneco|vattenfall|essent|belasting groep|waterschap)\\b');
STARTER_RULES.push({ name: 'Cash withdrawals', category: 'Cash', conditions: [{ field: 'type', op: 'equals', value: 'ATM' }] });

STARTER_RULES.push({ name: 'Salary (memo mentions salaris/salary)', category: 'Salary', kind: 'income',
  conditions: [inbound, { field: 'reference', op: 'regex', value: '\\b(salaris|salary|loon|stagevergoeding)' }] });
// Outgoing payments to the tax office are usually benefits paid back, so they count as negative income.
STARTER_RULES.push({ name: 'Government benefits (toeslagen, DUO, UWV)', category: 'Benefits', kind: 'income',
  conditions: [{ field: 'merchant', op: 'regex', value: '\\b(belastingdienst|duo|uwv|svb)\\b' }] });
