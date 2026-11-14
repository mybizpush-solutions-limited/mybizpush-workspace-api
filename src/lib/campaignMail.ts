import { Resend } from "resend";
import { env } from "../config/env";

// Sending campaign email (API-CHANGES A602). Separate from transactional email:
// campaigns need their own sender and unsubscribe headers, and the provider's
// message id back so delivery webhooks can find the recipient. Without a Resend
// key it logs instead, so the whole flow runs in development without sending.

export interface CampaignMail {
  from: string;
  to: string;
  replyTo?: string | null;
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
}

export interface CampaignTransport {
  send(mail: CampaignMail): Promise<{ providerId: string | null }>;
}

const devTransport: CampaignTransport = {
  async send(mail) {
    console.info(`[campaign:dev] ${mail.from} to ${mail.to} :: ${mail.subject}`);
    return { providerId: null };
  },
};

function resendTransport(apiKey: string): CampaignTransport {
  const client = new Resend(apiKey);
  return {
    async send(mail) {
      const { data, error } = await client.emails.send({
        from: mail.from,
        to: mail.to,
        replyTo: mail.replyTo ?? undefined,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        headers: mail.headers,
      });
      if (error) throw new Error(error.message ?? "Email provider refused the message");
      return { providerId: data?.id ?? null };
    },
  };
}

let transport: CampaignTransport | null = null;
export function campaignTransport(): CampaignTransport {
  transport ??= env.RESEND_API_KEY ? resendTransport(env.RESEND_API_KEY) : devTransport;
  return transport;
}

// Lets a test watch what would have been sent.
export function setCampaignTransport(t: CampaignTransport | null): void {
  transport = t;
}
