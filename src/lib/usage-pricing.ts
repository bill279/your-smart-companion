// Approximate per-1M-token prices in USD. Adjust as provider pricing shifts.
// Kept intentionally simple; the ledger stores computed cost, so historic
// numbers stay stable even when these change.
type Price = { input: number; output: number };

const PRICES: Record<string, Price> = {
  "openai/gpt-5.5": { input: 1.25, output: 10 },
  "openai/gpt-5.5-mini": { input: 0.25, output: 2 },
  "openai/gpt-5.4": { input: 2.5, output: 10 },
  "openai/text-embedding-3-small": { input: 0.02, output: 0 },
  "gpt-realtime-mini": { input: 10, output: 20 }, // audio tokens
  "gpt-realtime": { input: 40, output: 80 },
};

export function priceFor(model: string): Price {
  return PRICES[model] ?? { input: 1, output: 3 };
}

export function computeCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = priceFor(model);
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

// Flat per-call estimates for tools whose cost isn't token-based.
// These are rough — good enough to see "where is the money going".
export const TOOL_FLAT_COST_USD: Record<string, number> = {
  web_search: 0.005,
  web_scrape: 0.002,
  send_email: 0,
  create_calendar_event: 0,
  generate_document: 0.001,
  product_search: 0.005,
  remember_fact: 0,
  recall_facts: 0,
  search_knowledge: 0,
};