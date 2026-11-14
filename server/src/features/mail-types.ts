// Mail as the rest of Terminus sees it, whatever the source.

export interface MailMessage {
  uid: number;
  /** RFC 5322 Message-ID, angle brackets included. */
  messageId: string;
  from: { name: string; address: string };
  to: string;
  subject: string;
  /** ISO timestamp. */
  date: string;
  /** Gmail marked it Important. */
  important: boolean;
  labels: string[];
  /** Plain text body, trimmed. */
  text: string;
}

export interface MailVerdict {
  important: boolean;
  priority: number;
  category: string;
  summary: string;
}
