// This cloud entry point deliberately cannot place real trades.
process.env.DRY_RUN = "true";
delete process.env.PRIVATE_KEY;
await import("./index");
