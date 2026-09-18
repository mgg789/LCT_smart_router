import nodemailer, { type Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';

/** Inline CID image attached to a catalogue letter. */
export interface OutboundMailAttachment {
  readonly filename: string;
  readonly cid: string;
  readonly content: Buffer;
  readonly contentType: string;
}

export interface OutboundMail {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly attachments?: readonly OutboundMailAttachment[];
}

export type TransportOutcome =
  | { readonly kind: 'accepted'; readonly response: string }
  | { readonly kind: 'rejected'; readonly response: string }
  | { readonly kind: 'unknown'; readonly response: string };

/**
 * Narrow send/verify surface so tests do not open a real socket.
 */
export interface MailTransport {
  send(mail: OutboundMail): Promise<TransportOutcome>;
  verify(): Promise<boolean>;
}

export class NodemailerTransport implements MailTransport {
  constructor(private readonly transporter: Transporter<SMTPTransport.SentMessageInfo>) {}

  async send(mail: OutboundMail): Promise<TransportOutcome> {
    try {
      const info = await this.transporter.sendMail({
        from: mail.from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        attachments: mail.attachments?.map((attachment) => ({
          filename: attachment.filename,
          cid: attachment.cid,
          content: attachment.content,
          contentType: attachment.contentType,
          contentDisposition: 'inline',
        })),
      });
      const response = info.response ?? '250 accepted';
      if ((info.rejected?.length ?? 0) > 0 && (info.accepted?.length ?? 0) === 0) {
        return { kind: 'rejected', response };
      }
      return { kind: 'accepted', response };
    } catch (error) {
      return classifyTransportError(error);
    }
  }

  async verify(): Promise<boolean> {
    try {
      await this.transporter.verify();
      return true;
    } catch {
      return false;
    }
  }
}

export function classifyTransportError(error: unknown): TransportOutcome {
  const response =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'smtp transport failed';
  const code =
    typeof error === 'object' && error !== null && 'responseCode' in error
      ? Number((error as { responseCode?: number }).responseCode)
      : Number.NaN;
  if (Number.isInteger(code) && code >= 400 && code < 600) {
    return { kind: 'rejected', response };
  }
  return { kind: 'unknown', response };
}

export function createNodemailerTransport(options: {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
}): NodemailerTransport {
  return new NodemailerTransport(
    nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.port === 465,
      requireTLS: options.port !== 465,
      auth: { user: options.user, pass: options.password },
      tls: { servername: 'mail.droidje.com' },
    }),
  );
}
