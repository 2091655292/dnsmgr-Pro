import { createRouter, createWebHistory } from 'vue-router';
import { getToken } from './api';

const routes = [
  { path: '/setup', component: () => import('./views/Setup.vue'), meta: { public: true } },
  { path: '/login', component: () => import('./views/Login.vue'), meta: { public: true } },
  { path: '/register', component: () => import('./views/Register.vue'), meta: { public: true } },
  {
    path: '/',
    component: () => import('./layouts/MainLayout.vue'),
    children: [
      { path: '', redirect: '/domains' },
      { path: 'dashboard', component: () => import('./views/Dashboard.vue'), meta: { title: '仪表盘' } },
      { path: 'domains', component: () => import('./views/DomainList.vue'), meta: { title: '域名管理' } },
      { path: 'domains/:id/records', component: () => import('./views/RecordList.vue'), meta: { title: '解析记录' } },
      { path: 'dns-accounts', component: () => import('./views/DnsAccount.vue'), meta: { title: 'DNS 账户' } },
      { path: 'cdn-accounts', component: () => import('./views/CdnAccount.vue'), meta: { title: 'CDN 账户' } },
      { path: 'cdn-domains', component: () => import('./views/CdnDomain.vue'), meta: { title: 'CDN 域名' } },
      { path: 'statistics', component: () => import('./views/Statistics.vue'), meta: { title: '数据统计' } },
      { path: 'cache-refresh', component: () => import('./views/CachePurge.vue'), meta: { title: '缓存刷新' } },
      { path: 'preheat-tasks', component: () => import('./views/PreheatTask.vue'), meta: { title: '自动预热' } },
      { path: 'cdn-zones', component: () => import('./views/CdnZone.vue'), meta: { title: 'CDN 站点设置' } },
      { path: 'cdn-domains/:id/setting', component: () => import('./views/CdnDomainSetting.vue'), meta: { title: 'CDN 配置' } },
      { path: 'cloudflare/domains/:id/hostnames', component: () => import('./views/CfHostnames.vue'), meta: { title: 'Cloudflare 自定义主机名' } },
      { path: 'cloudflare/accounts/:id/tunnels', component: () => import('./views/CfTunnels.vue'), meta: { title: 'Cloudflare Tunnel' } },
      { path: 'expire-notice', component: () => import('./views/ExpireNotice.vue'), meta: { title: '域名到期提醒设置' } },
      { path: 'totp', component: () => import('./views/TotpSet.vue'), meta: { title: '安全设置' } },
      { path: 'cert-accounts', component: () => import('./views/CertAccount.vue'), meta: { title: '证书账户' } },
      { path: 'cert-orders', component: () => import('./views/CertOrder.vue'), meta: { title: '证书订单' } },
      { path: 'cert-settings', component: () => import('./views/CertSet.vue'), meta: { title: '证书计划任务设置' } },
      { path: 'deploy-accounts', component: () => import('./views/DeployAccount.vue'), meta: { title: '部署账户' } },
      { path: 'deploy-tasks', component: () => import('./views/DeployTask.vue'), meta: { title: '部署任务' } },
      { path: 'dm-overview', component: () => import('./views/DmOverview.vue'), meta: { title: '容灾监控' } },
      { path: 'dm-tasks', component: () => import('./views/DmTask.vue'), meta: { title: '切换策略' } },
      { path: 'dm-tasks/add', component: () => import('./views/DmTaskForm.vue'), meta: { title: '添加切换策略' } },
      { path: 'dm-tasks/:id/edit', component: () => import('./views/DmTaskForm.vue'), meta: { title: '编辑切换策略' } },
      { path: 'dm-tasks/:id', component: () => import('./views/DmTaskInfo.vue'), meta: { title: '切换记录' } },
      { path: 'optimize-tasks', component: () => import('./views/OptimizeList.vue'), meta: { title: '优选IP任务' } },
      { path: 'optimize-tasks/add', component: () => import('./views/OptimizeForm.vue'), meta: { title: '添加优选IP任务' } },
      { path: 'optimize-tasks/:id/edit', component: () => import('./views/OptimizeForm.vue'), meta: { title: '编辑优选IP任务' } },
      { path: 'optimize-settings', component: () => import('./views/OptimizeSet.vue'), meta: { title: '优选IP设置' } },
      { path: 'schedule-tasks', component: () => import('./views/ScheduleList.vue'), meta: { title: '定时切换策略' } },
      { path: 'schedule-tasks/add', component: () => import('./views/ScheduleForm.vue'), meta: { title: '添加定时切换策略' } },
      { path: 'schedule-tasks/:id/edit', component: () => import('./views/ScheduleForm.vue'), meta: { title: '编辑定时切换策略' } },
      { path: 'system-settings', component: () => import('./views/SystemSet.vue'), meta: { title: '系统设置' } },
      { path: 'users', component: () => import('./views/UserList.vue'), meta: { title: '用户管理' } },
      { path: 'logs', component: () => import('./views/UserLog.vue'), meta: { title: '操作日志' } },
    ],
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

let setupChecked = false;
let setupInstalled = true;

router.beforeEach(async (to, from, next) => {
  if (to.path === '/setup') return next();
  if (!setupChecked) {
    try {
      const res = await fetch('/api/setup/status');
      const json = await res.json();
      setupInstalled = json?.data?.installed ?? true;
    } catch {
      setupInstalled = true;
    }
    setupChecked = true;
  }
  if (!setupInstalled) return next('/setup');
  if (to.meta.public) return next();
  if (!getToken()) return next('/login');
  next();
});

export default router;