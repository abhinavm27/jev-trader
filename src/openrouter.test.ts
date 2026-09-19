import { test, expect } from "bun:test";
import { OpenRouterModel } from "./openrouter";
import type { TradeState } from "./model";

const state = { market: "MON-USDC", block: 123 } as TradeState;
const reply = (body: unknown, status = 200) => (async () => Response.json(body, { status }));

test("sends a typed direction question and maps the distribution", async () => {
  let requestBody: any;
  const request = (async (url: string, options: RequestInit) => {
    expect(url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(options.signal).toBeDefined();
    requestBody = JSON.parse(options.body as string);
    return Response.json({ answers: { direction: { choice: "sell", probabilities: { buy: 0.2, sell: 0.8 } } }, usage: { prompt_tokens: 100 } });
  });
  const decision = await new OpenRouterModel("test-only", request).decide(state);
  expect(requestBody.model).toBe("~typesafe/jev-latest");
  expect(JSON.parse(requestBody.state).block).toBe(123);
  expect(requestBody.questions.direction.type).toBe("choice");
  expect(decision.action).toBe("sell");
  expect(decision.probabilities).toEqual({ buy: 0.2, sell: 0.8, hold: 0 });
  expect(decision.inputTokens).toBe(100);
});

test("rejects missing credentials", () => {
  expect(() => new OpenRouterModel("")).toThrow("OPENROUTER_API_KEY");
});

test("rejects invalid responses instead of producing a trade", async () => {
  for (const direction of [null, { choice: "hold", probabilities: { buy: 0.5, sell: 0.5 } },
    { choice: "buy", probabilities: { buy: 2, sell: -1 } },
    { choice: "buy", probabilities: { buy: 0.2, sell: 0.2 } },
    { choice: "buy" }]) {
    await expect(new OpenRouterModel("test-only", reply({ answers: { direction } })).decide(state)).rejects.toThrow("Invalid");
  }
});

test("HTTP errors expose only status and do not retry", async () => {
  await expect(new OpenRouterModel("test-only", reply({ secret: "never log" }, 401)).decide(state)).rejects.toThrow("OpenRouter decisions HTTP 401");
});
