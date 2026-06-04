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
  // Resend resolves with `{ data, error }` rather than throwing on API errors
  // (unverified sending domain, bad key, etc.) — so we must inspect `error`
  // explicitly, otherwise failed sends look successful.
  const { data, error } = await resend.emails.send({
    from: env.EMAIL_FROM,
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.text,
  });
  const recipients = Array.isArray(input.to) ? input.to.join(", ") : input.to;
  if (error) {
    console.error(`[email] Resend rejected → ${recipients} :: ${input.subject} ::`, error);
    throw new Error(`Email send failed: ${error.message ?? "unknown error"}`);
  }
  // Log every accepted send with Resend's message id so delivery can be traced
  // in the Resend dashboard (Logs → search the id).
  console.info(`[email] sent → ${recipients} :: ${input.subject} :: id=${data?.id ?? "?"}`);
}

// ---- Branded layout --------------------------------------------------------
const LOGO_URL =
  "https://res.cloudinary.com/dkgbn7lfa/image/upload/q_auto/f_auto/v1780430173/mybizpush_logo_rszcoh.png";

export const BRAND = {
  purple: "#960095",
  purpleDark: "#790278",
  blue: "#3906FE",
  text: "#1f2430",
  subtle: "#5b6270",
  muted: "#9aa0ad",
  page: "#f3f3f7",
  line: "#ececf1",
};

export interface EmailLayout {
  preheader?: string; // hidden inbox-preview text
  heading: string;
  bodyHtml: string; // inner content (paragraphs etc.)
  cta?: { label: string; url: string };
}

// Email-safe HTML (tables + inline styles): logo header, white card with a
// brand-gradient top bar, optional bulletproof button, muted footer.
export function renderEmail({ preheader, heading, bodyHtml, cta }: EmailLayout): string {
  const gradient = `linear-gradient(90deg, ${BRAND.purple} 0%, ${BRAND.purpleDark} 100%)`;
  const button = cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px auto 4px;">
         <tr><td align="center" bgcolor="${BRAND.purple}" style="border-radius:10px;background:${gradient};">
           <a href="${cta.url}" target="_blank"
              style="display:inline-block;padding:13px 28px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;">
             ${cta.label}
           </a>
         </td></tr>
       </table>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light only">
  <meta name="supported-color-schemes" content="light only">
</head>
<body style="margin:0;padding:0;background:${BRAND.page};">
  ${preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${preheader}</div>` : ""}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
         style="background:${BRAND.page};padding:28px 12px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;">
        <tr><td align="center" style="padding:6px 0 22px;">
          <img src="${LOGO_URL}" alt="MyBizPush" width="168"
               style="display:block;border:0;outline:none;text-decoration:none;height:auto;max-width:168px;">
        </td></tr>
        <tr><td style="background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid ${BRAND.line};">
          <div style="height:4px;background:${gradient};line-height:4px;font-size:0;">&nbsp;</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="padding:34px 34px 30px;">
              <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;font-weight:700;color:${BRAND.text};">${heading}</h1>
              <div style="font-size:14px;line-height:1.65;color:${BRAND.subtle};">${bodyHtml}</div>
              ${button}
            </td></tr>
          </table>
        </td></tr>
        <tr><td align="center" style="padding:22px 16px;font-size:11px;line-height:1.7;color:${BRAND.muted};">
          MyBizPush Solutions Limited · internal work hub<br>
          You're receiving this because you have a MyBizPush Dev Space account.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

const p = (html: string) => `<p style="margin:0 0 12px;">${html}</p>`;
const APP = env.APP_URL;

// ---- Templated sends -------------------------------------------------------
export const emails = {
  welcome: (to: string, name: string) =>
    sendEmail({
      to,
      subject: "Welcome to MyBizPush Dev Space",
      html: renderEmail({
        preheader: "Your MyBizPush Dev Space account is ready.",
        heading: `Welcome, ${name} 👋`,
        bodyHtml:
          p("Your <strong>MyBizPush Dev Space</strong> account is ready.") +
          p("Jump in to see what's assigned to you, track issues, and collaborate with your team."),
        cta: { label: "Open the Space", url: APP },
      }),
      text: `Welcome to MyBizPush Dev Space, ${name}. Your account is ready: ${APP}`,
    }),

  verifyOtp: (to: string, code: string) =>
    sendEmail({
      to,
      subject: `${code} is your MyBizPush Dev Space verification code`,
      html: renderEmail({
        preheader: `Your verification code is ${code}`,
        heading: "Verify your email",
        bodyHtml:
          p("Welcome to MyBizPush Dev Space! Use this code to finish creating your account:") +
          `<div style="text-align:center;margin:20px 0;">
             <span style="display:inline-block;font-size:30px;font-weight:700;letter-spacing:9px;color:${BRAND.purple};background:#f7eef7;border:1px solid #efddef;border-radius:12px;padding:14px 22px;">${code}</span>
           </div>` +
          p(`<span style="color:${BRAND.muted};">This code expires in 10 minutes. If you didn't request it, you can ignore this email.</span>`),
      }),
      text: `Your MyBizPush Dev Space verification code is ${code} (expires in 10 minutes).`,
    }),

  passwordChangeOtp: (to: string, code: string) =>
    sendEmail({
      to,
      subject: `${code} is your MyBizPush password-change code`,
      html: renderEmail({
        preheader: `Your password-change code is ${code}`,
        heading: "Confirm your password change",
        bodyHtml:
          p("Use this code to set a new password on your account:") +
          `<div style="text-align:center;margin:20px 0;">
             <span style="display:inline-block;font-size:30px;font-weight:700;letter-spacing:9px;color:${BRAND.purple};background:#f7eef7;border:1px solid #efddef;border-radius:12px;padding:14px 22px;">${code}</span>
           </div>` +
          p(`<span style="color:${BRAND.muted};">This code expires in 10 minutes. If you didn't request it, ignore this email and consider changing your password.</span>`),
      }),
      text: `Your MyBizPush password-change code is ${code} (expires in 10 minutes).`,
    }),

  secondaryEmailOtp: (to: string, code: string) =>
    sendEmail({
      to,
      subject: `${code} is your MyBizPush email-verification code`,
      html: renderEmail({
        preheader: `Your email-verification code is ${code}`,
        heading: "Confirm your secondary email",
        bodyHtml:
          p("Use this code to link this address to your MyBizPush Dev Space account:") +
          `<div style="text-align:center;margin:20px 0;">
             <span style="display:inline-block;font-size:30px;font-weight:700;letter-spacing:9px;color:${BRAND.purple};background:#f7eef7;border:1px solid #efddef;border-radius:12px;padding:14px 22px;">${code}</span>
           </div>` +
          p(`<span style="color:${BRAND.muted};">This code expires in 10 minutes. If you didn't request it, you can safely ignore this email.</span>`),
      }),
      text: `Your MyBizPush email-verification code is ${code} (expires in 10 minutes).`,
    }),

  passwordReset: (to: string, resetLink: string) =>
    sendEmail({
      to,
      subject: "Reset your MyBizPush Dev Space password",
      html: renderEmail({
        preheader: "Reset your password (link expires in 30 minutes).",
        heading: "Reset your password",
        bodyHtml:
          p("We received a request to reset your password. Click the button below to choose a new one.") +
          p(`<span style="color:${BRAND.muted};">This link expires in 30 minutes. If you didn't request it, you can safely ignore this email.</span>`),
        cta: { label: "Choose a new password", url: resetLink },
      }),
      text: `Reset your MyBizPush Dev Space password: ${resetLink} (expires in 30 minutes)`,
    }),

  // Generic real-time activity alert (assigned, status change, mention, comment…).
  activityAlert: (to: string, name: string, opts: { message: string; url: string }) =>
    sendEmail({
      to,
      subject: opts.message.length > 70 ? `${opts.message.slice(0, 67)}…` : opts.message,
      html: renderEmail({
        preheader: opts.message,
        heading: "You have an update",
        bodyHtml: p(`Hi ${name},`) + p(opts.message),
        cta: { label: "Open MyBizPush", url: opts.url },
      }),
      text: `${opts.message}\n\n${opts.url}`,
    }),

  // Sent when someone is made a project manager / department head, etc.
  roleAssigned: (to: string, name: string, opts: { role: string; contextName: string; url: string }) =>
    sendEmail({
      to,
      subject: `You're now ${opts.role} of ${opts.contextName}`,
      html: renderEmail({
        preheader: `You're now ${opts.role} of ${opts.contextName}.`,
        heading: `You're now ${opts.role}`,
        bodyHtml:
          p(`Hi ${name},`) +
          p(`You've been assigned as <strong>${opts.role}</strong> of <strong>${opts.contextName}</strong>.`),
        cta: { label: "Open MyBizPush", url: APP },
      }),
      text: `You're now ${opts.role} of ${opts.contextName}. ${APP}`,
    }),

  feedbackRequested: (to: string, itemTitle: string, fromName: string) =>
    sendEmail({
      to,
      subject: `${fromName} requested your feedback`,
      html: renderEmail({
        preheader: `${fromName} asked for your feedback on "${itemTitle}".`,
        heading: `${fromName} requested your feedback`,
        bodyHtml: p(`${fromName} asked for your feedback on <strong>${itemTitle}</strong>.`),
        cta: { label: "Open the Space", url: APP },
      }),
      text: `${fromName} requested your feedback on "${itemTitle}". ${APP}`,
    }),
};
