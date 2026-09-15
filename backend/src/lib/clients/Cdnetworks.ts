import { createHash, createHmac } from 'node:crypto';

export class CdnetworksError extends Error {}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export interface CdnResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export class Cdnetworks {
  constructor(
    private accessKey: string,
    private secretKey: string,
    private endpoint = 'api.cdnetworks.com',
  ) {}

  private sign(method: string, uri: string, body: string, host: string, timestamp: string): string {
    const signedHeaders = 'content-type;host';
    const canonicalHeaders = 'content-type:application/json\nhost:' + host.toLowerCase() + '\n';
    const idx = uri.indexOf('?');
    const query = method !== 'POST' && idx !== -1 ? uri.slice(idx + 1) : '';
    const queryDecoded = decodeURIComponent(query);
    const payloadHash = sha256Hex(body || '');
    const canonicalRequest = [method, uri.split('?')[0], queryDecoded, canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const stringToSign = 'CNC-HMAC-SHA256\n' + timestamp + '\n' + sha256Hex(canonicalRequest);
    const signature = createHmac('sha256', this.secretKey).update(stringToSign).digest('hex').toLowerCase();
    return 'CNC-HMAC-SHA256 Credential=' + this.accessKey + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;
  }

  async request(method: string, path: string, body?: Record<string, any> | null): Promise<CdnResponse> {
    const hasBody = body && method !== 'GET';
    const payload = hasBody ? JSON.stringify(body) : '';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-cnc-auth-method': 'AKSK',
      Host: this.endpoint,
      'x-cnc-accessKey': this.accessKey,
      'x-cnc-timestamp': timestamp,
    };
    headers.Authorization = this.sign(method, path, payload, this.endpoint, timestamp);

    const res = await fetch('https://' + this.endpoint + path, {
      method,
      headers,
      body: payload || undefined,
    });
    const text = await res.text();
    const respHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      respHeaders[k.toLowerCase()] = v;
    });
    return { status: res.status, headers: respHeaders, body: text };
  }
}