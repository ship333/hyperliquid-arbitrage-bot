import { Request, Response, NextFunction } from "express";

function genId() {
  return Math.random().toString(36).slice(2, 10);
}

export function loggingMiddleware(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  const reqId = (req.headers["x-request-id"] as string) || genId();
  (res as any).locals = (res as any).locals || {};
  (res as any).locals.requestId = reqId;
  res.setHeader("x-request-id", reqId);

  res.on("finish", () => {
    const ms = Date.now() - start;
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      level: "info",
      msg: "http_request",
      reqId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      ms,
      len: res.getHeader("content-length") || 0,
    }));
  });
  next();
}
