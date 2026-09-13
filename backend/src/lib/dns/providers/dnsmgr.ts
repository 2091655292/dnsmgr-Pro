import { createHash } from 'node:crypto';
import type { DnsProvider, DomainListResult, RecordListResult, RecordInfo } from '../types.js';

export class DnsmgrDns implements DnsProvider {
  private uid: string;
  private key: string;
  private baseUrl: string;
  private error = '';
  private domain: string;
  private domainid: string;
  private domainInfo: any = null;

  constructor(config: Record<string, any>) {
    this.uid = config.uid || '';
    this.key = config.key || '';
    this.baseUrl = String(config.base_url || '').replace(/\/+$/, '');
    this.domain = config.domain || '';
    this.domainid = config.domainid || '';
  }

  getError() {
    return this.error;
  }

  private async sendRequest(path: string, param: Record<string, any> = {}): Promise<any> {
    try {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const sign = createHash('md5').update(this.uid + timestamp + this.key).digest('hex');
      const body = new URLSearchParams();
      const all = { ...param, uid: this.uid, timestamp, sign };
      for (const [k, v] of Object.entries(all)) {
        if (v !== null && v !== undefined) body.append(k, String(v));
      }
      const res = await fetch(this.baseUrl + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      const text = await res.text();
      let result: any;
      try {
        result = JSON.parse(text);
      } catch {
        this.error = text;
        return false;
      }
      if (result?.code !== undefined && result.code === 0) {
        return result.data !== undefined ? result.data : null;
      }
      if (result?.rows !== undefined && result?.total !== undefined) {
        return result;
      }
      if (result?.msg) {
        this.error = result.msg;
      } else {
        this.error = text;
      }
      return false;
    } catch (e: any) {
      this.error = e.message || String(e);
      return false;
    }
  }

  async check() {
    if (!this.baseUrl || !this.uid || !this.key) {
      this.error = '站点地址、用户 ID、API 密钥均不能为空';
      return false;
    }
    if (this.baseUrl === 'http://' || this.baseUrl === 'https://') {
      this.error = '站点地址不能仅填写协议，请填写完整地址如 https://dns.example.com';
      return false;
    }
    if (!/^\d+$/.test(String(this.uid))) {
      this.error = '用户 ID 必须为数字（目标站点用户列表中的 ID，而非用户名），请到目标站点用户管理查看数字 ID';
      return false;
    }
    return (await this.getDomainList()) !== false;
  }

  async getDomainList(KeyWord: string | null = null, PageNumber = 1, PageSize = 20): Promise<DomainListResult | false> {
    const param: Record<string, any> = { offset: (PageNumber - 1) * PageSize, limit: PageSize };
    if (KeyWord) param.kw = KeyWord;
    const data = await this.sendRequest('/api/domain', param);
    if (data?.rows) {
      const list = data.rows.map((row: any) => ({
        DomainId: row.id,
        Domain: row.name,
        RecordCount: row.recordcount,
      }));
      return { total: data.total || 0, list };
    }
    return false;
  }

  async getDomainRecords(
    PageNumber = 1,
    PageSize = 20,
    KeyWord: string | null = null,
    SubDomain: string | null = null,
    Value: string | null = null,
    Type: string | null = null,
    Line: string | null = null,
    Status: string | null = null,
  ): Promise<RecordListResult | false> {
    const param: Record<string, any> = { offset: (PageNumber - 1) * PageSize, limit: PageSize };
    if (KeyWord) param.keyword = KeyWord;
    if (SubDomain) param.subdomain = SubDomain;
    if (Value) param.value = Value;
    if (Type) param.type = Type;
    if (Line) param.line = Line;
    if (Status) param.status = Status;
    const data = await this.sendRequest('/api/record/data/' + this.domainid, param);
    if (data?.rows) {
      const list: RecordInfo[] = data.rows.map((row: any) => ({
        RecordId: row.RecordId,
        Domain: row.Domain,
        Name: row.Name,
        Type: row.Type,
        Value: row.Value,
        Line: row.Line,
        TTL: row.TTL,
        MX: row.MX,
        Status: row.Status,
        Weight: row.Weight,
        Remark: row.Remark,
        UpdateTime: row.UpdateTime,
      }));
      return { total: data.total || 0, list };
    }
    return false;
  }

  async getDomainRecordInfo(_RecordId: string) {
    return false;
  }

  async addDomainRecord(Name: string, Type: string, Value: string, Line = 'default', TTL = 600, MX = 1, Weight: number | null = null, Remark: string | null = null) {
    const param: Record<string, any> = { name: Name, type: Type, value: Value, line: Line, ttl: Number(TTL) };
    if (Type === 'MX' && MX) param.mx = Number(MX);
    if (Weight) param.weight = Number(Weight);
    if (Remark) param.remark = Remark;
    return (await this.sendRequest('/api/record/add/' + this.domainid, param)) !== false;
  }

  async updateDomainRecord(RecordId: string, Name: string, Type: string, Value: string, Line = 'default', TTL = 600, MX = 1, Weight: number | null = null, Remark: string | null = null) {
    const param: Record<string, any> = { recordid: RecordId, name: Name, type: Type, value: Value, line: Line, ttl: Number(TTL) };
    if (Type === 'MX' && MX) param.mx = Number(MX);
    if (Weight) param.weight = Number(Weight);
    if (Remark) param.remark = Remark;
    return (await this.sendRequest('/api/record/update/' + this.domainid, param)) !== false;
  }

  async deleteDomainRecord(RecordId: string) {
    return (await this.sendRequest('/api/record/delete/' + this.domainid, { recordid: RecordId })) !== false;
  }

  async updateDomainRecordRemark(RecordId: string, Remark: string | null): Promise<boolean> {
    return (await this.sendRequest('/api/record/remark/' + this.domainid, { recordid: RecordId, remark: Remark ?? '' })) !== false;
  }

  async setDomainRecordStatus(RecordId: string, Status: string) {
    return (await this.sendRequest('/api/record/status/' + this.domainid, { recordid: RecordId, status: Status })) !== false;
  }

  async getRecordLine(): Promise<Record<string, string> | false> {
    const data = await this.getDomainInfo();
    if (data?.recordLine) {
      const list: Record<string, string> = {};
      for (const row of data.recordLine) {
        list[row.name] = String(row.id);
      }
      return list;
    }
    return false;
  }

  async getDomainInfo() {
    if (this.domainInfo) return this.domainInfo;
    const data = await this.sendRequest('/api/domain/' + this.domainid, { loginurl: 0 });
    if (data) {
      this.domainInfo = data;
      return data;
    }
    return false;
  }

  async addDomain(_Domain: string) {
    return false;
  }
}