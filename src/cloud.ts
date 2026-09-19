// Paper research only: no wallet or paid inference, regardless of external settings.
process.env.DRY_RUN = "true";
process.env.MODEL = "mock";
delete process.env.PRIVATE_KEY;
delete process.env.OPENROUTER_API_KEY;
delete process.env.TYPESAFE_AI_API_KEY;
await import("./research");
