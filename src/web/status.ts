export function statusTone(status: string): "slate" | "green" | "red" | "amber" | "blue" | "indigo" {
  switch (status) {
    case "replied":
    case "sent":
    case "active":
    case "done":
      return "green";
    case "queued":
    case "pending":
    case "running":
      return "amber";
    case "failed":
    case "dead":
    case "error":
      return "red";
    case "skipped":
    case "duplicate":
      return "slate";
    case "received":
      return "blue";
    default:
      return "slate";
  }
}

export function statusLabel(status: string): string {
  const map: Record<string, string> = {
    replied: "已回复",
    sent: "已发送",
    queued: "排队中",
    pending: "等待中",
    running: "执行中",
    done: "完成",
    failed: "失败",
    dead: "已终止",
    error: "错误",
    skipped: "已跳过",
    duplicate: "重复",
    received: "已接收",
    active: "启用",
  };
  return map[status] || status;
}

export function directionLabel(direction: string): string {
  return direction === "in" ? "收件" : "发件";
}

export function channelLabel(kind: string): string {
  const map: Record<string, string> = {
    cf_routing: "Cloudflare Routing",
    cf_reply: "Cloudflare 原生回复",
    imap: "IMAP",
    pop3: "POP3",
    smtp: "SMTP",
    resend: "Resend",
    mailgun: "Mailgun",
  };
  return map[kind] || kind;
}
