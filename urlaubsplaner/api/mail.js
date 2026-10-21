// Sends plain-text emails through Amazon SES (eu-central-1). Only used when MAIL_FROM is set.
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

export function createMailer(from) {
  const ses = new SESv2Client({});
  return async ({ to, subject, text }) => {
    await ses.send(new SendEmailCommand({
      FromEmailAddress: from,
      Destination: { ToAddresses: to },
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: { Text: { Data: text, Charset: 'UTF-8' } },
        },
      },
    }));
  };
}
