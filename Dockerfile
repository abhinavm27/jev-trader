FROM oven/bun:1.3
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production
COPY src ./src
RUN OPENROUTER_MODEL_ID=~typesafe/jev-latest bun test src/trial.test.ts src/paper.test.ts src/openrouter.test.ts src/enriched.test.ts src/queue.test.ts
ENV NODE_ENV=production
CMD ["bun", "run", "src/index.ts"]
