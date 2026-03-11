import express from "express";
import pinoHttp from "pino-http";
import { env, hasWebhookSecret } from "./config";
import { logger } from "./logger";
import { isValidSignature } from "./signature";
import { normalizeWebhookPayload } from "./normalize";
import { ingestWebhook } from "./repository";

function getHeaderValue(headers: Record<string, string | string[] | undefined>, headerName: string): string {
  const key = headerName.toLowerCase();
  const value = headers[key] ?? headers[headerName];
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}

export function createApp(): express.Express {
  const app = express();

  app.use(
    express.json({
      limit: env.MAX_BODY_SIZE,
      verify: (req, _res, buffer) => {
        (req as express.Request).rawBody = buffer.toString("utf8");
      }
    })
  );

  app.use(pinoHttp({ logger }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/webhooks/linq/message", async (req, res) => {
    try {
      const rawBody = req.rawBody ?? JSON.stringify(req.body ?? {});

      if (hasWebhookSecret) {
        const signature = getHeaderValue(req.headers as Record<string, string | string[] | undefined>, env.SIGNATURE_HEADER);
        const valid = isValidSignature(env.WEBHOOK_SECRET, rawBody, signature);

        if (!valid) {
          req.log.warn({ signatureHeader: env.SIGNATURE_HEADER }, "Invalid webhook signature");
          res.status(401).json({ ok: false, error: "Invalid signature" });
          return;
        }
      }

      const normalized = normalizeWebhookPayload(req.body, rawBody);
      const result = await ingestWebhook(
        normalized,
        req.body,
        req.headers as Record<string, string | string[] | undefined>
      );

      res.status(result.duplicate ? 200 : 202).json({
        ok: true,
        duplicate: result.duplicate,
        webhook_event_id: result.webhookEventId,
        message_id: result.messageId
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error";
      req.log.error({ err: error }, "Failed to process webhook");
      res.status(500).json({ ok: false, error: message });
    }
  });

  return app;
}
