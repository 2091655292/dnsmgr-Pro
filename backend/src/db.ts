import mysql from 'mysql2/promise';
import { loadDbConfig, type DbConfig } from './config-loader.js';

let currentPrefix = 'dnsmgr_';
let pool: mysql.Pool;

function buildPool(cfg: DbConfig): mysql.Pool {
  currentPrefix = cfg.db_prefix || 'dnsmgr_';
  return mysql.createPool({
    host: cfg.db_host,
    port: Number(cfg.db_port || 3306),
    user: cfg.db_user,
    password: cfg.db_password,
    database: cfg.db_name,
    waitForConnections: true,
    connectionLimit: 10,
    charset: 'utf8mb4',
    dateStrings: true,
  });
}

// 启动时用当前配置初始化连接池
pool = buildPool(loadDbConfig());

export function table(name: string): string {
  return currentPrefix + name;
}

export function currentPrefixValue(): string {
  return currentPrefix;
}

// 安装向导保存配置后调用，用新数据库参数重建连接池（无需重启进程）
export function reinitPool(cfg: DbConfig): void {
  pool = buildPool(cfg);
}

export function getDbConfig(): DbConfig {
  return loadDbConfig();
}

export async function query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  const [rows] = await pool.query(sql, params);
  return rows as T[];
}

export async function queryOne<T = any>(sql: string, params: any[] = []): Promise<T | undefined> {
  const rows = await query<T>(sql, params);
  return rows[0];
}