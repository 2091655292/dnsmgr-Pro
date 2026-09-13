export interface DomainInfo {
  DomainId: string;
  Domain: string;
  RecordCount: number;
}

export interface RecordInfo {
  RecordId: string;
  Domain: string;
  Name: string;
  Type: string;
  Value: string;
  Line: string;
  TTL: number;
  MX: number | null;
  Status: string;
  Weight: number | null;
  Remark: string | null;
  UpdateTime: string | null;
}

export interface DomainListResult {
  total: number;
  list: DomainInfo[];
}

export interface RecordListResult {
  total: number;
  list: RecordInfo[];
}

export interface DnsProvider {
  getError(): string;
  check(): Promise<boolean>;
  getDomainList(KeyWord?: string | null, PageNumber?: number, PageSize?: number): Promise<DomainListResult | false>;
  getDomainRecords(
    PageNumber?: number,
    PageSize?: number,
    KeyWord?: string | null,
    SubDomain?: string | null,
    Value?: string | null,
    Type?: string | null,
    Line?: string | null,
    Status?: string | null,
  ): Promise<RecordListResult | false>;
  getDomainRecordInfo(RecordId: string): Promise<RecordInfo | false>;
  addDomainRecord(
    Name: string,
    Type: string,
    Value: string,
    Line?: string,
    TTL?: number,
    MX?: number,
    Weight?: number | null,
    Remark?: string | null,
  ): Promise<string | false>;
  updateDomainRecord(
    RecordId: string,
    Name: string,
    Type: string,
    Value: string,
    Line?: string,
    TTL?: number,
    MX?: number,
    Weight?: number | null,
    Remark?: string | null,
  ): Promise<boolean>;
  deleteDomainRecord(RecordId: string): Promise<boolean>;
  setDomainRecordStatus(RecordId: string, Status: string): Promise<boolean>;
  updateDomainRecordRemark?(RecordId: string, Remark: string | null): Promise<boolean>;
  getRecordLine(): Promise<Record<string, string> | false>;
  addDomain(Domain: string): Promise<boolean>;
}