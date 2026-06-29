export interface ApiIntegration {
  id: string;
  name: string;
  category: 'AI / LLM' | 'Productivity' | 'Payments' | 'Communication' | 'Dev / Data' | 'Markets';
  description: string;
  keyFields: { label: string; placeholder: string; key: string; isSecret: boolean }[];
  docUrl: string;
}
