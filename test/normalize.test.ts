import { describe, expect, it } from "vitest";
import { normalizeWebhookPayload } from "../src/normalize";

describe("normalizeWebhookPayload", () => {
  it("normalizes canonical webhook payload", () => {
    const payload = {
      event_id: "evt_1",
      event_type: "message.received",
      occurred_at: "2026-03-10T16:00:00.000Z",
      trace_id: "trace_1",
      message: {
        id: "msg_1",
        chat_id: "chat_1",
        protocol: "imessage",
        direction: "inbound",
        text: "hello",
        contact: {
          id: "ct_1",
          phone: "+12025550123",
          name: "Alex"
        },
        attachments: []
      }
    };

    const normalized = normalizeWebhookPayload(payload, JSON.stringify(payload));

    expect(normalized.dedupeKey).toBe("event:evt_1");
    expect(normalized.eventType).toBe("message.received");
    expect(normalized.traceId).toBe("trace_1");
    expect(normalized.conversation?.externalChatId).toBe("chat_1");
    expect(normalized.contact?.phoneNumber).toBe("+12025550123");
    expect(normalized.message?.direction).toBe("inbound");
  });

  it("uses hash dedupe when event id is missing", () => {
    const payload = { type: "message.received", body: "hello" };
    const normalized = normalizeWebhookPayload(payload, JSON.stringify(payload));

    expect(normalized.dedupeKey.startsWith("hash:")).toBe(true);
    expect(normalized.message?.direction).toBe("unknown");
  });
});
