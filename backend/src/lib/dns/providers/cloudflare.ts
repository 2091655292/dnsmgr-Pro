import { Cloudflare } from '../../clients/Cloudflare.js';
import type { DnsProvider, DomainListResult, RecordListResult, RecordInfo } from '../types.js';

export class CloudflareDns implements DnsProvider {
  private client: Cloudflare;
  private error = '';
  private domain: string;

  constructor(private config: Record<string, any>) {
    const auth = config.auth !== undefined ? Number(config.auth) : /^[0-9a-f]+$/i.test(config.apikey) ? 0 : 1;
    this.client = new Cloudflare(config.email, config.apikey, auth);
    this.domain = config.domain || '';
  }

  getError() {
    return this.error;
  }

  private async send(method: Parameters<Cloudflare['request']>[0], path: string, params?: Record<string, any>, body?: Record<string, any>): Promise<any> {
    try {
      return await this.client.request(method, path, params, body);
    } catch (e: any) {
      this.error = e.message || String(e);
      return false;
    }
  }

  async check() {
    return (await this.getDomainList(null, 1, 20)) !== false;
  }

  async getDomainList(KeyWord: string | null = null, PageNumber = 1, PageSize = 20): Promise<DomainListResult | false> {
    const params: Record<string, any> = { page: PageNumber, per_page: PageSize };
    if (KeyWord) params.name = KeyWord;
    const data = await this.send('GET', '/zones', params);
    if (!data) return false;
    const list = (data.result || []).map((row: any) => ({ DomainId: row.id, Domain: row.name, RecordCount: 0 }));
    return { total: data.result_info?.total_count || 0, list };
  }

  async getDomainRecords(
    PageNumber = 1,
    PageSize = 20,
    KeyWord: string | null = null,
    SubDomain: string | null = null,
    Value: string | null = null,
    Type: string | null = null,
    Line: string | null = null,
    _Status: string | null = null,
  ): Promise<RecordListResult | false> {
    if (Value) KeyWord = Value;
    const params: Record<string, any> = { type: Type ?? undefined, search: KeyWord ?? undefined, page: PageNumber, per_page: PageSize };
    if (SubDomain) {
      const ascii = this.domain;
      params.name = SubDomain === '@' ? ascii : SubDomain + '.' + ascii;
    }
    const data = await this.send('GET', '/zones/' + this.config.domainid + '/dns_records', params);
    if (!data) return false;
    const list = (data.result || []).map((row: any) => {
      let name = this.extractName(row.name);
      let status = '1';
      if (row.type === 'MX') row.content = String(row.priority) + ' ' + row.content;
      return {
        RecordId: row.id,
        Domain: this.domain,
        Name: name,
        Type: row.type,
        Value: row.content,
        Line: row.proxied ? '1' : '0',
        TTL: row.ttl,
        MX: row.priority ?? null,
        Status: '1',
        Weight: null,
        Remark: row.comment ?? null,
        UpdateTime: row.modified_on ?? null,
      };
    });
    return { total: data.result_info?.total_count || 0, list };
  }

  async getDomainRecordInfo(RecordId: string): Promise<RecordInfo | false> {
    const data = await this.send('GET', '/zones/' + this.config.domainid + '/dns_records/' + RecordId);
    if (!data) return false;
    const r = data.result || {};
    // 移除返回的 type/name/content 前缀
    let value = r.content || '';
    if (r.type === 'MX') value = value.replace(/^\d+\s+/, '');
    return {
      RecordId: r.id,
      Domain: this.domain,
      Name: this.extractName(r.name),
      Type: r.type,
      Value: value,
      Line: r.proxied ? '1' : '0',
      TTL: r.ttl,
      MX: r.priority ?? null,
      Status: '1',
      Weight: null,
      Remark: r.comment ?? null,
      UpdateTime: r.modified_on ?? null,
    };
  }

  async addDomainRecord(Name: string, Type: string, Value: string, Line = '0', TTL = 600, MX = 1, _Weight: number | null = null, Remark: string | null = null) {
    const ascii = this.domain;
    const name = Name === '@' ? ascii : Name + '.' + ascii;
    const body: Record<string, any> = { type: Type, name, content: Value, ttl: Number(TTL) };
    if (Type === 'MX') body.priority = Number(MX);
    if (Remark) body.comment = Remark;
    if (Line === '1') body.proxied = true;
    const data = await this.send('POST', '/zones/' + this.config.domainid + '/dns_records', undefined, body);
    return data && data.result?.id ? String(data.result.id) : false;
  }

  async updateDomainRecord(RecordId: string, Name: string, Type: string, Value: string, Line = '0', TTL = 600, MX = 1, _Weight: number | null = null, Remark: string | null = null) {
    const ascii = this.domain;
    const name = Name === '@' ? ascii : Name + '.' + ascii;
    const body: Record<string, any> = { type: Type, name, content: Value, ttl: Number(TTL) };
    if (Type === 'MX') body.priority = Number(MX);
    if (Remark) body.comment = Remark;
    if (Line === '1') body.proxied = true;
    return (await this.send('PATCH', '/zones/' + this.config.domainid + '/dns_records/' + RecordId, undefined, body)) !== false;
  }

  async deleteDomainRecord(RecordId: string) {
    return (await this.send('DELETE', '/zones/' + this.config.domainid + '/dns_records/' + RecordId)) !== false;
  }

  async updateDomainRecordRemark(RecordId: string, Remark: string | null): Promise<boolean> {
    const body: Record<string, any> = { comment: Remark ?? '' };
    return (await this.send('PATCH', '/zones/' + this.config.domainid + '/dns_records/' + RecordId, undefined, body)) !== false;
  }

  async setDomainRecordStatus(RecordId: string, _Status: string) {
    this.error = 'Cloudflare 不支持启用/暂停记录，可通过代理开关控制';
    return false;
  }

  async getRecordLine() {
    return { default: '0', proxied: '1' };
  }

  async addDomain(Domain: string) {
    const data = await this.send('POST', '/zones', undefined, { name: Domain, jump_start: false });
    return data !== false;
  }

  private extractName(fullName: string): string {
    if (fullName === this.domain) return '@';
    if (fullName.endsWith('.' + this.domain)) return fullName.slice(0, -(this.domain.length + 1));
    return fullName;
  }
}