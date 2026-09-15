import { createHash, createHmac } from 'node:crypto';

export class KingsoftError extends Error {}

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 'cdn';
const REQUEST_TYPE = 'aws4_request';

function sha256Hex(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function encodeValue(value: string): string {
  return encodeURIComponent(value).replace(/\+/g, '%20').replace(/[*]/g, '%2A').replace(/%7E/g, '~');
}

function encodePath(path: string): string {
  if (!path) return '/';
  return path
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function signingKey(secretKey: string, date: string, region: string): Buffer {
  const kDate = hmac('AWS4' + secretKey, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, SERVICE);
  return hmac(kService, REQUEST_TYPE);
}

export class Kingsoft {
  constructor(
    private accessKey: string,
    private secretKey: string,
    private region = 'cn-beijing-6',
    private endpoint = 'cdn.api.ksyun.com',
  ) {}

  private sign(signing: Buffer, msg: string): string {
    return createHmac('sha256', signing).update(msg).digest('hex');
  }

  async get(action: string, version: string, path: string, params: Record<string, any> = {}): Promise<any> {
    const ts = timestamp();
    const date = ts.slice(0, 8);
    const allParams: Record<string, string> = {};
    allParams.Action = action;
    allParams.Version = version;
    for (const [k, v] of Object.entries(params)) {
      if (v !== null && v !== undefined && v !== '') allParams[k] = String(v);
    }
    allParams['X-Amz-Algorithm'] = ALGORITHM;
    allParams['X-Amz-Credential'] = this.accessKey + '/' + date + '/' + this.region + '/' + SERVICE + '/' + REQUEST_TYPE;
    allParams['X-Amz-Date'] = ts;
    allParams['X-Amz-Expires'] = '300';
    allParams['X-Amz-SignedHeaders'] = 'host;x-amz-date';

    const sortedKeys = Object.keys(allParams).sort();
    const canonicalQueryString = sortedKeys.map((k) => encodeValue(k) + '=' + encodeValue(allParams[k])).join('&');
    const canonicalHeaders = 'host:' + this.endpoint + '\nx-amz-date:' + ts + '\n';
    const canonicalRequest =
      'GET\n' + encodePath(path) + '\n' + canonicalQueryString + '\n' + canonicalHeaders + '\n' + 'host;x-amz-date\n' + EMPTY_SHA256;
    const credentialScope = date + '/' + this.region + '/' + SERVICE + '/' + REQUEST_TYPE;
    const stringToSign = ALGORITHM + '\n' + ts + '\n' + credentialScope + '\n' + sha256Hex(canonicalRequest);
    const signature = this.sign(signingKey(this.secretKey, date, this.region), stringToSign);

    allParams['X-Amz-Signature'] = signature;
    const finalKeys = Object.keys(allParams).sort();
    const query = finalKeys.map((k) => encodeValue(k) + '=' + encodeValue(allParams[k])).join('&');
    const url = 'https://' + this.endpoint + encodePath(path) + '?' + query;

    const res = await fetch(url, {
      method: 'GET',
      headers: { Host: this.endpoint, 'X-Amz-Date': ts, 'X-Action': action, 'X-Version': version },
    });
    return this.parse(res);
  }

  async post(action: string, version: string, path: string, body: Record<string, any> | null, useJson: boolean): Promise<any> {
    const ts = timestamp();
    const date = ts.slice(0, 8);
    const contentType = useJson ? 'application/json' : 'application/x-www-form-urlencoded';
    let payload: string;
    if (useJson) {
      payload = body ? JSON.stringify(body) : '{}';
    } else {
      const params: Record<string, string> = {};
      if (body) for (const [k, v] of Object.entries(body)) if (v !== null && v !== undefined) params[k] = String(v);
      payload = Object.keys(params)
        .sort()
        .map((k) => encodeValue(k) + '=' + encodeValue(params[k]))
        .join('&');
    }

    const headers: Record<string, string> = { host: this.endpoint, 'x-amz-date': ts, 'content-type': contentType };
    const signedHeaders = ['content-type', 'host', 'x-amz-date'].join(';');
    const canonicalHeaders = ['content-type:' + contentType, 'host:' + this.endpoint, 'x-amz-date:' + ts].join('\n') + '\n';
    const canonicalRequest = 'POST\n' + encodePath(path) + '\n\n' + canonicalHeaders + '\n' + signedHeaders + '\n' + sha256Hex(payload);
    const credentialScope = date + '/' + this.region + '/' + SERVICE + '/' + REQUEST_TYPE;
    const stringToSign = ALGORITHM + '\n' + ts + '\n' + credentialScope + '\n' + sha256Hex(canonicalRequest);
    const signature = this.sign(signingKey(this.secretKey, date, this.region), stringToSign);
    const authorization = ALGORITHM + ' Credential=' + this.accessKey + '/' + credentialScope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;

    const res = await fetch('https://' + this.endpoint + encodePath(path), {
      method: 'POST',
      headers: {
        Host: this.endpoint,
        'X-Amz-Date': ts,
        'Content-Type': contentType,
        Authorization: authorization,
        'X-Action': action,
        'X-Version': version,
      },
      body: payload,
    });
    return this.parse(res);
  }

  private async parse(res: Response): Promise<any> {
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (res.status >= 200 && res.status < 300) return json ?? {};
    const err = json?.Error || json?.error;
    const code = err?.Code || err?.code;
    const message = err?.Message || err?.message;
    if (code || message) throw new KingsoftError((code ? code + ': ' : '') + (message || ''));
    throw new KingsoftError('Kingsoft CDN API call failed: HTTP ' + res.status);
  }
}