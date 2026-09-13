import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { getSysKey } from './config.js';
import { isInstalled } from './installer.js';
import { migrate } from './migrate.js';
import authRoutes from './routes/auth.js';
import accountRoutes from './routes/account.js';
import domainRoutes from './routes/domain.js';
import cdnRoutes from './routes/cdn.js';
import certRoutes from './routes/cert.js';
import dmonitorRoutes from './routes/dmonitor.js';
import optimizeRoutes from './routes/optimizeip.js';
import scheduleRoutes from './routes/schedule.js';
import systemRoutes from './routes/system.js';
import userRoutes from './routes/user.js';
import cloudflareRoutes from './routes/cloudflare.js';
import expireRoutes from './routes/expire.js';
import registerRoutes from './routes/register.js';
import setupRoutes from './routes/setup.js';
import preheatRoutes from './routes/preheat.js';
import dnsCheckRoutes from './routes/dnscheck.js';
import { startMonitorScheduler } from './lib/monitor/scheduler.js';
import { executeAll as runOptimizeAll } from './lib/optimize/optimizeService.js';
import { executeAll as runScheduleAll } from './lib/schedule/scheduleService.js';
import { expireNoticeTask } from './lib/expire/expireNoticeService.js';
import { executePreheatTasks } from './lib/cdn/preheatService.js';
import { executeCheckTasks } from './lib/dns/checkService.js';

process.on('unhandledRejection', (reason: any) => {
  console.error('[backend] 未捕获的异步异常:', reason?.message || reason);
});
process.on('uncaughtException', (err: any) => {
  console.error('[backend] 未捕获异常:', err?.message || err);
});

function resolveWebDir(): string {
  if (process.env.DNSMGR_WEB_DIR) return process.env.DNSMGR_WEB_DIR;
  const candidates = [
    path.join(process.cwd(), 'dist'),
    path.resolve(process.cwd(), '../frontend/dist'),
    path.resolve(process.cwd(), 'web'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'index.html'))) return c;
  }
  return '';
}

const app = Fastify({ logger: false });

await app.register(cors, { origin: true });

// JWT 密钥取自数据库 sys_key；未安装时使用临时密钥（仅 setup 阶段使用）
let sysKey = 'dnsmgr-setup-default-key';
try {
  sysKey = await getSysKey();
} catch {
  // 未安装，忽略
}
await app.register(jwt, { secret: sysKey });

(app as any).decorate('authenticate', async function (req: any, reply: any) {
  try {
    await req.jwtVerify();
  } catch (e) {
    return reply.code(401).send({ code: -1, msg: '未登录或登录已过期' });
  }
});

app.get('/api/health', async () => ({ code: 0, data: 'ok' }));

// 安装向导路由始终注册
await app.register(setupRoutes);

// 检测安装状态：已安装才加载业务路由与迁移、调度器
const installed = await isInstalled();

if (installed) {
  try {
    await migrate();
  } catch (e: any) {
    console.error('[dnsmgr-backend] 迁移失败:', e?.message);
  }
  await app.register(authRoutes);
  await app.register(accountRoutes);
  await app.register(domainRoutes);
  await app.register(cdnRoutes);
  await app.register(certRoutes);
  await app.register(dmonitorRoutes);
  await app.register(optimizeRoutes);
  await app.register(scheduleRoutes);
  await app.register(systemRoutes);
  await app.register(userRoutes);
  await app.register(cloudflareRoutes);
  await app.register(expireRoutes);
  await app.register(registerRoutes);
  await app.register(preheatRoutes);
  await app.register(dnsCheckRoutes);
}

// 静态资源与 SPA 回退（容器内 serve 前端构建产物；本地未构建则不注册）
const webDir = resolveWebDir();
if (webDir) {
  await app.register(fastifyStatic, { root: webDir, prefix: '/' });
  app.setNotFoundHandler((req: any, reply: any) => {
    if (req.raw.url && req.raw.url.startsWith('/api/')) {
      return reply.code(404).send({ code: -1, msg: '接口不存在', path: req.raw.url });
    }
    return reply.type('text/html').send(fs.readFileSync(path.join(webDir, 'index.html')));
  });
}

const port = Number(process.env.PORT || 8082);
try {
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`[dnsmgr-backend] 已启动，端口 ${port}${installed ? '' : '（未安装，等待初始化）'}`);

  if (installed) {
    startMonitorScheduler();
    console.log('[dnsmgr-backend] 容灾监控调度器已启动');
    setInterval(() => {
      runOptimizeAll().catch((e: any) => console.error('[optimize] 优选IP调度异常:', e.message));
      runScheduleAll().catch((e: any) => console.error('[schedule] 定时切换解析异常:', e.message));
    }, 60 * 1000);
    console.log('[dnsmgr-backend] 优选IP调度器已启动');
    console.log('[dnsmgr-backend] 定时切换解析调度器已启动');
    setInterval(() => {
      expireNoticeTask().catch((e: any) => console.error('[expire] 到期提醒调度异常:', e.message));
    }, 60 * 60 * 1000);
    console.log('[dnsmgr-backend] 域名到期提醒调度器已启动');
    setInterval(() => {
      executePreheatTasks().catch((e: any) => console.error('[preheat] 自动预热调度异常:', e.message));
    }, 60 * 1000);
    console.log('[dnsmgr-backend] CDN 自动预热调度器已启动');
    setInterval(() => {
      executeCheckTasks().catch((e: any) => console.error('[dnscheck] 自动检测调度异常:', e.message));
    }, 60 * 1000);
    console.log('[dnsmgr-backend] DNS 劫持检测调度器已启动');
  }
} catch (e) {
  console.error(e);
  process.exit(1);
}