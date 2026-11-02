import {
  buildReferences,
  normalizeMessageId,
  normalizeSubject,
} from "./mime-lite";
import { normalizeReplySubject } from "../services/template";

export interface ReplyThreadInput {
  replyAsNew: boolean;
  inboundMessageId: string;
  inboundReferences?: string | null;
  inboundSubject: string;
  templateSubject: string;
}

export interface ReplyThreadResult {
  subject: string;
  inReplyTo: string | null;
  references: string[];
}

/**
 * Build the subject and threading headers for one auto-reply.
 *
 * replyAsNew = true:
 *   Start a new conversation. No In-Reply-To / References, and the subject is
 *   exactly what the template rendered.
 *
 * replyAsNew = false:
 *   Thread under the inbound message. In-Reply-To always targets the inbound
 *   message itself (not its parent), and References keeps the existing chain
 *   plus the inbound message id. The subject is forced to match the original
 *   unless the template renders the same base subject.
 */
export function buildReplyThread(input: ReplyThreadInput): ReplyThreadResult {
  if (input.replyAsNew) {
    return {
      subject: input.templateSubject || input.inboundSubject,
      inReplyTo: null,
      references: [],
    };
  }

  const messageId = normalizeMessageId(input.inboundMessageId);
  const references = buildReferences(input.inboundReferences, messageId);
  const templateSubject = input.templateSubject.trim();
  const subjectMatches =
    Boolean(templateSubject) &&
    normalizeSubject(templateSubject) === normalizeSubject(input.inboundSubject);

  return {
    subject: subjectMatches
      ? normalizeReplySubject(templateSubject)
      : normalizeReplySubject(input.inboundSubject),
    inReplyTo: messageId || null,
    references,
  };
}
