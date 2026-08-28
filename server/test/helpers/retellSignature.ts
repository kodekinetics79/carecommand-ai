import { createHmac } from 'node:crypto';

export function signRetell(rawBody: string | Buffer, apiKey: string, timestamp = Date.now()) {
  const timestampText = String(timestamp);
  const digest = createHmac('sha256', apiKey).update(rawBody).update(timestampText).digest('hex');
  return `v=${timestampText},d=${digest}`;
}
