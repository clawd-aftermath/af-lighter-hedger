import { modeLogger } from "./logging";
export interface Alert {
  severity: "warning" | "error" | "critical";
  reason: string;
  market?: string;
  mode: string;
  ts: number;
}
export interface AlertSink {
  send(alert: Alert): Promise<void>;
}
export class LogAlertSink implements AlertSink {
  constructor(private write: (text: string) => void = console.error) {}
  async send(alert: Alert): Promise<void> {
    modeLogger(alert.mode, {
      write: (line) => this.write(line.trimEnd()),
    }).error("alert", { type: "alert", ...alert });
  }
}
export class TelegramAlertSink implements AlertSink {
  constructor(
    private token: string,
    private chatId: string,
    private request: typeof fetch = fetch,
  ) {}
  async send(alert: Alert): Promise<void> {
    // Never include the request URL or service error body in logs.
    let response: Response;
    try {
      response = await this.request(
        `https://api.telegram.org/bot${this.token}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: this.chatId,
            text: `[${alert.mode}] ${alert.severity}: ${alert.market ?? "all"} ${alert.reason}`,
          }),
          signal: AbortSignal.timeout(5000),
        },
      );
    } catch {
      throw new Error("Telegram alert delivery failed");
    }
    if (!response.ok) throw new Error("Telegram alert delivery rejected");
  }
}
export function alertSink(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AlertSink {
  const log = new LogAlertSink();
  const telegram =
    env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
      ? new TelegramAlertSink(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID)
      : null;
  return {
    send: async (alert) => {
      await log.send(alert);
      if (telegram)
        try {
          await telegram.send(alert);
        } catch {
          await log.send({ ...alert, reason: "telegram_delivery_failed" });
        }
    },
  };
}
