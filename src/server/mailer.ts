// Sends the magic-link login email. Two transports:
//   console — logs the link to the server log (dev / fallback)
//   resend  — posts to the Resend HTTP API (no SDK dependency)

import { config } from './config';

export async function sendMagicLink(email: string, link: string): Promise<void> {
  if (config.mailTransport === 'resend' && config.resendApiKey) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.resendApiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: config.mailFrom,
          to: email,
          subject: 'Your NixBall sign-in link',
          html:
            `<p>Click to sign in to NixBall:</p>` +
            `<p><a href="${link}">${link}</a></p>` +
            `<p>This link expires in 15 minutes. If you didn't request it, ignore this email.</p>`,
        }),
      });
      if (!res.ok) {
        console.error('resend send failed', res.status, await res.text());
      }
      return;
    } catch (err) {
      console.error('resend send error', err);
      return;
    }
  }
  // console transport
  console.log(`\n=== NixBall magic link for ${email} ===\n${link}\n=======================================\n`);
}
