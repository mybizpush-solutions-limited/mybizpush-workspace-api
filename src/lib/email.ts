import { Resend } from "resend";
import { env } from "../config/env";

// Resend client. If no API key is configured (local dev), emails are logged to
// the console instead of being sent — so flows don't break before keys exist.
const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;

export interface SendEmailInput {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
}

export async function sendEmail(input: SendEmailInput): Promise<void> {
  if (!resend) {
    console.info(`[email:dev] → ${Array.isArray(input.to) ? input.to.join(", ") : input.to} :: ${input.subject}`);
    return;
  }
  await resend.emails.send({
    from: env.EMAIL_FROM,
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.text,
  });
}

// Example templated sends — these map to the UI's digest preferences and will
// be triggered by the relevant domain events / scheduled jobs.
export const emails = {
  welcome: (to: string, name: string) =>
    sendEmail({
      to,
      subject: "Welcome to MyBizPush Dev Space",
      html: `<p>Hi ${name},</p><p>Your MyBizPush Dev Space account is ready.</p>`,
    }),
  feedbackRequested: (to: string, itemTitle: string, fromName: string) =>
    sendEmail({
      to,
      subject: `${fromName} requested your feedback`,
      html: `<p>${fromName} asked for your feedback on <strong>${itemTitle}</strong>.</p>`,
    }),
  passwordReset: (to: string, resetLink: string) =>
    sendEmail({
      to,
      subject: "Reset your MyBizPush Dev Space password",
      html: `<p>We received a request to reset your password.</p>
<p><a href="${resetLink}">Click here to choose a new password</a>. This link expires in 30 minutes.</p>
<p>If you didn't request this, you can safely ignore this email.</p>`,
      text: `Reset your password: ${resetLink} (expires in 30 minutes)`,
    }),
  verifyOtp: (to: string, code: string) =>
    sendEmail({
      to,
      subject: `${code} is your MyBizPush Dev Space verification code`,
      html: `<p>Welcome to MyBizPush Dev Space! Use this code to finish creating your account:</p>
<p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:12px 0">${code}</p>
<p>This code expires in 10 minutes. If you didn't request it, you can ignore this email.</p>`,
      text: `Your MyBizPush Dev Space verification code is ${code} (expires in 10 minutes).`,
    }),
};
