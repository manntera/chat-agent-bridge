import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { IUsageFetcher, UsageInfo } from '../domain/types.js';

const CREDENTIALS_PATH = join(homedir(), '.claude', '.credentials.json');
const USAGE_API_URL = 'https://api.anthropic.com/api/oauth/usage';

interface UsageApiResponse {
  five_hour: { utilization: number; resets_at: string } | null;
  seven_day: { utilization: number; resets_at: string } | null;
  seven_day_sonnet: { utilization: number; resets_at: string } | null;
}

function mapBucket(bucket: { utilization: number; resets_at: string } | null) {
  if (bucket === null) return null;
  return { utilization: bucket.utilization, resetsAt: bucket.resets_at };
}

async function readAccessToken(): Promise<string> {
  const raw = await readFile(CREDENTIALS_PATH, 'utf-8');
  const creds = JSON.parse(raw);
  const token = creds?.claudeAiOauth?.accessToken ?? creds?.accessToken ?? creds?.access_token;
  if (typeof token !== 'string' || token === '') {
    throw new Error('Access token not found in credentials');
  }
  return token;
}

export class UsageFetcher implements IUsageFetcher {
  async fetch(): Promise<UsageInfo> {
    const token = await readAccessToken();
    const res = await fetch(USAGE_API_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
    });
    if (!res.ok) {
      throw new Error(`Usage API returned ${res.status}`);
    }
    const data = (await res.json()) as UsageApiResponse;
    return {
      fiveHour: mapBucket(data.five_hour),
      sevenDay: mapBucket(data.seven_day),
      sevenDaySonnet: mapBucket(data.seven_day_sonnet),
    };
  }
}
