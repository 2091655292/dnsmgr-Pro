import { query, table } from './db.js';

// 启动时幂等迁移：为多用户注册系统补齐表结构与字段，已存在则跳过。
export async function migrate(): Promise<void> {
  await ensureColumn('user', 'email', 'varchar(128) DEFAULT NULL');
  await ensureColumn('user', 'check_whole', "tinyint(1) NOT NULL DEFAULT '0'");
  await ensureColumn('permission', 'readonly', "tinyint(1) NOT NULL DEFAULT '0'");
  await ensureColumn('permission', 'expiretime', 'datetime DEFAULT NULL');

  await query(
    `CREATE TABLE IF NOT EXISTS ${table('reg_code')} (
      id int(11) unsigned NOT NULL AUTO_INCREMENT,
      code varchar(32) NOT NULL,
      expiretime datetime DEFAULT NULL,
      max_use int(11) NOT NULL DEFAULT '0',
      used int(11) NOT NULL DEFAULT '0',
      status tinyint(1) NOT NULL DEFAULT '1',
      remark varchar(100) DEFAULT NULL,
      addtime datetime NOT NULL,
      PRIMARY KEY (id),
      UNIQUE KEY code (code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );

  await query(
    `CREATE TABLE IF NOT EXISTS ${table('reg_verify')} (
      id int(11) unsigned NOT NULL AUTO_INCREMENT,
      email varchar(128) NOT NULL,
      code varchar(8) NOT NULL,
      type varchar(20) NOT NULL DEFAULT 'register',
      used tinyint(1) NOT NULL DEFAULT '0',
      expiretime datetime NOT NULL,
      addtime datetime NOT NULL,
      PRIMARY KEY (id),
      KEY email (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );

  await query(
    `CREATE TABLE IF NOT EXISTS ${table('cdn_cache_task')} (
      id int(11) unsigned NOT NULL AUTO_INCREMENT,
      url varchar(500) NOT NULL,
      type varchar(20) NOT NULL,
      provider varchar(20) NOT NULL,
      task_id varchar(255) DEFAULT NULL,
      status tinyint(1) NOT NULL DEFAULT '0',
      msg varchar(255) DEFAULT NULL,
      addtime datetime NOT NULL,
      PRIMARY KEY (id),
      KEY addtime (addtime)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );

  await query(
    `CREATE TABLE IF NOT EXISTS ${table('cdn_preheat_task')} (
      id int(11) unsigned NOT NULL AUTO_INCREMENT,
      name varchar(100) DEFAULT NULL,
      urls text NOT NULL,
      op varchar(20) NOT NULL DEFAULT 'preheat',
      cycle varchar(20) NOT NULL DEFAULT 'daily',
      interval_min int(11) NOT NULL DEFAULT '0',
      run_time varchar(5) DEFAULT NULL,
      active tinyint(1) NOT NULL DEFAULT '1',
      last_run datetime DEFAULT NULL,
      next_run datetime DEFAULT NULL,
      addtime datetime NOT NULL,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  await ensureColumn('cdn_preheat_task', 'op', "varchar(20) NOT NULL DEFAULT 'preheat'");

  await query(
    `CREATE TABLE IF NOT EXISTS ${table('dns_check_task')} (
      id int(11) unsigned NOT NULL AUTO_INCREMENT,
      name varchar(100) DEFAULT NULL,
      did int(11) unsigned NOT NULL,
      uid int(11) unsigned NOT NULL DEFAULT '0',
      sub varchar(255) DEFAULT NULL,
      types varchar(255) DEFAULT NULL,
      cycle varchar(20) NOT NULL DEFAULT 'daily',
      interval_min int(11) NOT NULL DEFAULT '0',
      run_time varchar(5) DEFAULT NULL,
      notice_email varchar(255) DEFAULT NULL,
      active tinyint(1) NOT NULL DEFAULT '1',
      last_run datetime DEFAULT NULL,
      next_run datetime DEFAULT NULL,
      addtime datetime NOT NULL,
      PRIMARY KEY (id),
      KEY did (did),
      KEY uid (uid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  await ensureColumn('dns_check_task', 'uid', "int(11) unsigned NOT NULL DEFAULT '0'");
  await ensureColumn('dns_check_task', 'sub', 'varchar(255) DEFAULT NULL');
}

async function ensureColumn(tableName: string, column: string, definition: string): Promise<void> {
  const rows = await query<any>(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table(tableName), column]
  );
  if (rows.length === 0) {
    await query(`ALTER TABLE ${table(tableName)} ADD COLUMN ${column} ${definition}`);
  }
}