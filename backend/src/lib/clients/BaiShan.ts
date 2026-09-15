export class BaiShanError extends Error {}

function filterNull(obj: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

export class BaiShan {
  constructor(
    private token: string,
    private endpoint = 'cdn.api.baishan.com',
  ) {}

  async request(method: string, path: string, query?: Record<string, any> | null, body?: Record<string, any> | null): Promise<any> {
    const params: Record<string, any> = { token: this.token, ...(query || {}) };
    let url = 'https://' + this.endpoint + path + '?' + new URLSearchParams(filterNull(params) as any).toString();
    let payload: string | undefined;
    const headers: Record<string, string> = {};
    if (body && method !== 'GET') {
      payload = JSON.stringify({ ...filterNull(body), token: this.token });
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(url, { method, headers, body: payload });
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
    if (json && (json.message || json.error)) throw new BaiShanError(json.message || json.error);
    throw new BaiShanError('返回数据解析失败(http_code=' + res.status + ')');
  }
}