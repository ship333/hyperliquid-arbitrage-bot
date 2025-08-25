import express, { Request, Response } from "express";
import dotenv from "dotenv";
import evalRouter from "./routes/eval";
import strategyRouter from "./routes/strategy";
import botRouter from "./routes/bot";
import configRouter from "./routes/config";
import { z } from "zod";
import { loggingMiddleware } from "./middleware/logging";
import { metricsMiddleware, register } from "./middleware/metrics";
import { State } from "./state";
import { rateLimit } from "./middleware/rateLimit";

dotenv.config();

export const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(loggingMiddleware);
app.use(metricsMiddleware);

app.get("/health", (_req: Request, res: Response) => res.json({ ok: true }));
app.use("/api/eval", evalRouter);
app.get("/metrics", async (_req: Request, res: Response) => {
  res.setHeader("Content-Type", register.contentType);
  res.end(await register.metrics());
});

// Read-only endpoints for UI
app.get("/api/stats", (_req: Request, res: Response) => {
  res.json(State.getStats());
});

app.get("/api/signals/active", (_req: Request, res: Response) => {
  res.json(State.getActiveSignals());
});

app.get("/api/opportunities/recent", (req: Request, res: Response) => {
  const limitSchema = z.coerce.number().int().min(1).max(200).default(50);
  const parse = limitSchema.safeParse(req.query.limit);
  const limit = parse.success ? parse.data : 50;
  res.json(State.getRecentOpportunities(limit));
});

// Strategy + Bot routes
app.use("/api/strategy", rateLimit({ capacity: 20, refillPerMs: 250 }), strategyRouter);
app.use("/api/bot", botRouter);
app.use("/api/config", configRouter);
