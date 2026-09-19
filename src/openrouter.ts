import { config } from "./config";
import { QUESTIONS, type Decision, type Model, type TradeState } from "./model";

/** Uses OpenRouter's typed decisions endpoint, not chat completions. */
export class OpenRouterModel implements Model {
  readonly name = config.openRouterModelId;
  constructor(private apiKey = config.openRouterApiKey, private request: (url: string, init: RequestInit) => Promise<Response> = fetch) {
    if (!apiKey) throw new Error("OPENROUTER_API_KEY is required for MODEL=openrouter");
  }

  async decide(state: TradeState): Promise<Decision> {
    const started = performance.now();
    const response = await this.request("https://openrouter.ai/api/alpha/decisions", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      // Flatten instructions to the string format in the supplied API example.
      body: JSON.stringify({ model: this.name, state: JSON.stringify(state), questions: {
        direction: { ...QUESTIONS.direction, instructions: Object.values(QUESTIONS.direction.instructions).join("\n") },
      } }),
      signal: AbortSignal.timeout(2000),
    });
    // Never log response bodies, which may contain sensitive provider diagnostics.
    if (!response.ok) throw new Error(`OpenRouter decisions HTTP ${response.status}`);
    const data = await response.json() as any;
    const answer = data?.answers?.direction;
    const buy = answer?.probabilities?.buy;
    const sell = answer?.probabilities?.sell;
    if (!["buy", "sell"].includes(answer?.choice) ||
        typeof buy !== "number" || typeof sell !== "number" ||
        !Number.isFinite(buy) || !Number.isFinite(sell) ||
        buy < 0 || sell < 0 || buy > 1 || sell > 1 || Math.abs(buy + sell - 1) > 0.01) {
      throw new Error("Invalid OpenRouter direction answer; skipping this decision");
    }
    const tokens = data?.usage?.input_tokens ?? data?.usage?.prompt_tokens ?? 0;
    return { action: answer.choice, probabilities: { buy, sell, hold: 0 }, upIn10: buy,
      latencyMs: performance.now() - started,
      inputTokens: typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0 ? tokens : 0 };
  }
}
