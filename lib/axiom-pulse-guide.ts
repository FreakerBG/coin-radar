// A manual research setup for Axiom Pulse. The field names and phase labels come from Axiom's published
// Pulse guide; the numeric values are Coin Radar study hypotheses, not Axiom defaults or proven edges.
export const AXIOM_PULSE_URL = 'https://axiom.trade/pulse';
export const AXIOM_PULSE_DOCS_URL = 'https://docs.axiom.trade/axiom/finding-tokens/pulse';
export const AXIOM_MARKET_DOCS_URL = 'https://docs.axiom.trade/axiom/swap/market';

export const PULSE_PHASES = [
  {name: 'New Pairs', note: 'Launches appear early. Coin Radar’s hourly sampling cannot validate a launch-minute entry.'},
  {name: 'Final Stretch', note: 'Tokens near migration. Bonding-curve risk and timing differ from a migrated pool.'},
  {name: 'Migrated', note: 'Start the research watchlist here; check the exact live pool before any trade.'},
] as const;

export type PulseField = {name: string; studyValue: string; why: string; caveat?: string};
export const PULSE_STUDY_FIELDS: PulseField[] = [
  {name: 'Age (mins)', studyValue: '30–1,440', why: 'Compare established intraday pools before testing earlier launches.'},
  {name: 'Top 10 Holders %', studyValue: '≤30%', why: 'A concentration hypothesis to compare with later outcomes.', caveat: 'Coin Radar’s RugCheck top-holder set is not guaranteed to be exactly ten wallets.'},
  {name: 'Dev Holding %', studyValue: '≤5%', why: 'A stricter research group than Coin Radar’s creator holding safety bar.', caveat: 'Axiom dev holding and RugCheck creator balance can cover different wallets.'},
  {name: 'Snipers %', studyValue: '≤15%', why: 'Study early-buyer concentration.', caveat: 'Coin Radar does not collect this field.'},
  {name: 'Insiders %', studyValue: '≤10%', why: 'Study team-linked supply concentration.', caveat: 'Coin Radar only checks a separate RugCheck insider-network signal.'},
  {name: 'Bundle %', studyValue: '≤10%', why: 'Study coordinated initial buying.', caveat: 'Coin Radar does not collect this field.'},
  {name: 'Holders', studyValue: '≥100', why: 'A study group for distribution; wallet count is not unique people.'},
  {name: 'Liquidity ($)', studyValue: '≥50,000', why: 'Compare with the existing $25,000 Goldmine hard floor; verify the live pool.'},
  {name: 'Market Cap ($)', studyValue: '250,000–5,000,000', why: 'A test band, not a validated minimum cap. Confirm market cap is present rather than substituting FDV.'},
  {name: 'Volume ($)', studyValue: '≥25,000 / 1h', why: 'Compare activity only within the same time window; volume can be manipulated.'},
  {name: 'Txns (Transactions)', studyValue: '≥100 / 1h', why: 'A liquidity/activity study group; transactions are not unique traders.'},
  {name: 'Num Sells', studyValue: '≥20 / 1h', why: 'Check that selling is observed; it does not prove sellability for your order.'},
];

export const pulseStudyText = () => [
  'Coin Radar × Axiom Pulse — migrated watchlist experiment (unvalidated; manual setup)',
  ...PULSE_STUDY_FIELDS.map(field => `${field.name}: ${field.studyValue}`),
  'Choose the 1h window for volume/transactions/sells if available. Confirm live contract, pool, liquidity, fees and slippage before any order.',
].join('\n');
