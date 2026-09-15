import { createHmac } from 'node:crypto';

export class QiniuError extends Error {}

function base64UrlSafe(data: Buffer): string {
  return data.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

function filterNull(obj: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

export class Qiniu {
  constructor(
    private accessKey: string,
    private secretKey: string,
    private endpoint = 'api.qiniu.com',
  ) {}

  private sign(path: string, queryStr: string | null): string {
    const signStr = path + (queryStr ? '?' + queryStr : '') + '\n';
    const hmac = createHmac('sha1', this.secretKey).update(signStr).digest();
    return this.accessKey + ':' + base64UrlSafe(hmac);
  }

  async request(method: string, path: string, query?: Record<string, any> | null, params?: Record<string, any> | null): Promise<any> {
    let url = 'https://' + this.endpoint + path;
    let queryStr: string | null = null;
    let body: string | null = null;

    if (query && Object.keys(query).length) {
      const q = filterNull(query);
      queryStr = new URLSearchParams(q as any).toString();
      url += '?' + queryStr;
    }
    if (params && Object.keys(params).length) {
      body = JSON.stringify(filterNull(params));
    }

    const headers: Record<string, string> = { Authorization: 'QBox ' + this.sign(path, queryStr) };
    if (body) headers['Content-Type'] = 'application/json';

    const res = await fetch(url, { method, headers, body: body || undefined });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (res.status >= 200 && res.status < 300) {
      return json ?? true;
    }
    if (json && json.error) throw new QiniuError(String(json.error));
    throw new QiniuError('返回数据解析失败');
  }
}