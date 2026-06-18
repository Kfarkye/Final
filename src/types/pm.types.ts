export interface RawMarketPayload {
  platform: 'kalshi' | 'polymarket';
  marketId: string;
  title: string;
  subtitle?: string;
  rulesText?: string;
  outcomesJson: any; // array or object of outcomes
  closeTimeUtc?: string;
  rawJson: any;
}
