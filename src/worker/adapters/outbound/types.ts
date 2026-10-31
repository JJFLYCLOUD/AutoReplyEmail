export interface OutboundMessage {
  from: { name: string; email: string };
  to: string;
  replyTo?: string | null;
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
}

export interface SendResult {
  providerMessageId?: string;
  response?: string;
}
