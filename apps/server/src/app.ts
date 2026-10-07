import Fastify, { type FastifyRequest } from 'fastify';
import { AccountService, AccountError, type PublicAccount } from './accounts';
import { createRuntime, type RuntimeOptions } from './runtime';
import multipart from '@fastify/multipart';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { zipSync, strToU8 } from 'fflate';
import type { Asset, ContentVersion, Project } from '../../../packages/shared/src/index';
import { EMPTY_BRIEF, makePoster, TEMPLATES } from '../../../packages/shared/src/index';
import { contentWarnings, layoutPoster } from '../../../packages/shared/src/poster-layout';
import { NotFound, now } from './repository';
import {
  listTaskEvents,
  publicTask,
  publicProvider,
  recordTaskEvent,
  type StoredProvider,
  type StoredTask,
} from './jobs';
import {
  validateProviderInput,
  encryptSecret,
  decryptSecret,
  testConnection,
  listModels,
} from './providers';
import { boardSchema, briefSchema, copySchema, posterSchema } from './validation';
import { backup, restore } from './backup';
import { BrandService, brandInputSchema } from './brands';
import { ShareService } from './shares';
import { deleteAccountData, exportAccountData } from './lifecycle';
import { mcpCheckLogin } from './mcp';
import { AssistantService, type AssistantOptions } from './assistant';

export interface AppOptions extends RuntimeOptions {
  origin?: string;
  worker?: boolean;
  staticRoot?: string;
  /** 测试注入：替换自动化编排的助手模型调用。 */
  assistantGenerateWithTools?: AssistantOptions['generateWithTools'];
}
const idSchema = z.string().uuid();
const hash = (v: string) => createHash('sha256').update(v).digest();
const plainProvider = (p: StoredProvider) => {
  const { secret, id, workspaceId, createdAt, ...config } = p;
  return config;
};
export async function createApp(options: AppOptions) {
  const runtime = await createRuntime(options);
  const { db, repo, media, runner, accounts, quotas, mode, key, canRunProject } = runtime;
  const brands = new BrandService(db, media, repo);
  const shares = new ShareService(db, media, key!, canRunProject);
  const assistant = new AssistantService(db, repo, media, quotas, key!, {
    dataDir: options.dataDir,
    ...(options.assistantGenerateWithTools
      ? { generateWithTools: options.assistantGenerateWithTools }
      : {}),
  });
  const identities = new WeakMap<FastifyRequest, PublicAccount>();
  const activeWorkspaces = new WeakMap<FastifyRequest, string>();
  const workspace = (req: FastifyRequest) =>
    (accounts ? activeWorkspaces.get(req) : undefined) ??
    identities.get(req)?.workspace.id ??
    'local';
  const ownedProject = async (req: FastifyRequest, id: string) => {
    const project = await repo.project(id);
    if ((project.workspaceId ?? 'local') !== workspace(req)) throw new NotFound('项目不存在');
    return project;
  };
  const ownedProvider = async (req: FastifyRequest, id: string) => {
    const provider = await db.get<StoredProvider>('providers', id);
    if (!provider || (provider.workspaceId ?? 'local') !== workspace(req))
      throw new NotFound('服务商不存在');
    return provider;
  };
  const projectsFor = (req: FastifyRequest) =>
    db
      .query<{ body: Project }>(
        "SELECT body FROM documents WHERE scope='projects' AND COALESCE(body->>'workspaceId', 'local')=$1 ORDER BY body->>'updatedAt' DESC",
        [workspace(req)],
      )
      .then((rows) => rows.map((row) => row.body));
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024, files: 1, fields: 5 } });
  const loginAttempts = new Map<string, { count: number; until: number }>();
  const loginLocks = new Map<string, Promise<unknown>>();
  const loginGate = async <T>(ip: string, fn: () => Promise<T>) => {
    const previous = loginLocks.get(ip) ?? Promise.resolve();
    const pending = previous.then(fn, fn);
    loginLocks.set(ip, pending);
    try {
      return await pending;
    } finally {
      if (loginLocks.get(ip) === pending) loginLocks.delete(ip);
    }
  };
  let taskCreationTail: Promise<unknown> = Promise.resolve();
  function serializeTaskCreation<T>(fn: () => Promise<T>): Promise<T> {
    const next = taskCreationTail.then(fn, fn);
    taskCreationTail = next.catch(() => {});
    return next;
  }
  // Per-user sliding-window rate limit on task submission (in-process; multi-API
  // deployments need a shared limiter before relying on this as the only guard).
  const taskRateLimit = Number(process.env.USER_TASK_RATE_PER_MINUTE || 20);
  const taskRateWindows = new Map<string, number[]>();
  const enforceTaskRate = (userId: string) => {
    if (!Number.isFinite(taskRateLimit) || taskRateLimit <= 0) return;
    const nowMs = Date.now();
    const hits = (taskRateWindows.get(userId) ?? []).filter((t) => nowMs - t < 60_000);
    if (hits.length >= taskRateLimit) {
      const error = new Error('任务提交过于频繁，请稍后再试') as Error & { statusCode: number };
      error.statusCode = 429;
      throw error;
    }
    hits.push(nowMs);
    taskRateWindows.set(userId, hits);
  };
  const getId = (req: { params: unknown }, name = 'id') =>
    idSchema.parse((req.params as Record<string, unknown>)[name]);
  const isAuthenticated = async (token?: string) => {
    if (accounts) return !!(token && (await accounts.session(token)));
    if (!options.password) return true;
    if (!token) return false;
    const session = await db.get<{ expiresAt: number }>('sessions', hash(token).toString('hex'));
    return !!session && session.expiresAt > Date.now();
  };
  const revalidateActor = async (req: FastifyRequest, admin = false) => {
    if (accounts) {
      const user = req.cookies.zhizuo_session
        ? await accounts.session(req.cookies.zhizuo_session)
        : undefined;
      if (!user) {
        const error = new Error('登录状态已失效，请重新登录') as Error & { statusCode: number };
        error.statusCode = 401;
        throw error;
      }
      if (admin && user.role !== 'admin') {
        const error = new Error('需要管理员权限') as Error & { statusCode: number };
        error.statusCode = 403;
        throw error;
      }
      identities.set(req, user);
    } else if (!(await isAuthenticated(req.cookies.zhizuo_session))) {
      const error = new Error('登录状态已失效，请重新登录') as Error & { statusCode: number };
      error.statusCode = 401;
      throw error;
    }
  };
  app.addHook('onRequest', async (req, reply) => {
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'same-origin')
      .header('X-Frame-Options', 'DENY');
    if (req.url.startsWith('/api')) reply.header('Cache-Control', 'no-store');
    const host = (() => {
      try {
        return new URL(`http://${req.headers.host}`).hostname;
      } catch {
        return '';
      }
    })();
    if (mode === 'local' && !['127.0.0.1', 'localhost', '[::1]'].includes(host))
      return reply
        .code(403)
        .send({ error: '本地模式只接受 loopback 主机，请为托管模式配置访问密码' });
    const origin = req.headers.origin;
    const allowed = options.origin
      ? [options.origin]
      : [
          'http://127.0.0.1:5173',
          'http://localhost:5173',
          'http://127.0.0.1:4317',
          'http://localhost:4317',
        ];
    if ((origin && !allowed.includes(origin)) || req.headers['sec-fetch-site'] === 'cross-site')
      return reply.code(403).send({ error: '请求来源不受信任' });
  });
  app.addHook('preHandler', async (req, reply) => {
    // Match the router's resolved route, not the raw URL (which may be percent-encoded).
    const route = req.routeOptions.url;
    if (route?.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store');
      if (accounts && req.cookies.zhizuo_session) {
        const user = await accounts.session(req.cookies.zhizuo_session);
        if (user) {
          identities.set(req, user);
          // Active workspace switches only through a verified membership cookie.
          const cookieWs = req.cookies.zhizuo_workspace;
          if (cookieWs && cookieWs !== user.workspace.id) {
            const role = await accounts.roleIn(user.id, cookieWs);
            if (role) activeWorkspaces.set(req, cookieWs);
          }
        }
      }
      if (
        ![
          '/api/session',
          '/api/health',
          '/api/public-shares',
          '/api/public-shares/versions/:id/preview',
        ].includes(route)
      ) {
        if (accounts ? !identities.has(req) : !(await isAuthenticated(req.cookies.zhizuo_session)))
          return reply.code(401).send({ error: '请先登录工作台' });
        if (
          route.startsWith('/api/admin/') &&
          identities.get(req)?.role !== 'admin' &&
          !(mode !== 'accounts' && route.startsWith('/api/admin/quota'))
        )
          return reply.code(403).send({ error: '需要管理员权限' });
        if (route.startsWith('/api/projects/:id')) await ownedProject(req, getId(req));
        else if (route.startsWith('/api/providers/:id')) await ownedProvider(req, getId(req));
        else
          for (const scope of ['assets', 'versions', 'tasks'] as const) {
            if (route.startsWith(`/api/${scope}/:id`)) {
              const record = await db.get<{ projectId: string }>(scope, getId(req));
              if (!record) throw new NotFound('资源不存在');
              await ownedProject(req, record.projectId);
            }
          }
      }
    }
  });
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof z.ZodError)
      return reply.code(400).send({
        error: `输入不符合要求：${err.issues
          .map((i) => i.path.join('.') + ' ' + i.message)
          .join('；')
          .slice(0, 500)}`,
      });
    const e = err as Error & { statusCode?: number; code?: string };
    const status = e.statusCode && e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 400;
    if (e.code === 'FST_REQ_FILE_TOO_LARGE')
      return reply.code(413).send({ error: '文件超过上传大小限制' });
    return reply.code(status).send({ error: e.message?.slice(0, 500) || '请求失败，请稍后重试' });
  });
  app.get('/api/health', async () => ({
    ok: true,
    version: '0.1.0',
    storage: options.databaseUrl ? 'postgresql' : 'pglite',
    mode: accounts ? 'accounts' : options.password ? 'private-hosted' : 'local',
    mediaStorage: options.storage ? 's3' : 'local',
    workerMode: options.worker === false ? 'external-or-disabled' : 'inline',
  }));
  app.get('/api/session', async (req) => ({
    authenticated: accounts
      ? identities.has(req)
      : await isAuthenticated(req.cookies.zhizuo_session),
    requiresPassword: mode !== 'local',
    mode,
    ...(identities.has(req)
      ? {
          user: identities.get(req),
          ...(accounts
            ? {
                workspaces: await accounts.memberships(identities.get(req)!.id),
                activeWorkspaceId: workspace(req),
              }
            : {}),
        }
      : {}),
  }));
  app.post('/api/session', async (req, reply) =>
    loginGate(req.ip, async () => {
      const b = z
        .object({ password: z.string().max(1024), email: z.string().max(254).optional() })
        .parse(req.body);
      const rate = loginAttempts.get(req.ip);
      if (rate && rate.until > Date.now() && rate.count >= 5)
        return reply.code(429).send({ error: '尝试次数过多，请 15 分钟后再试' });
      let accountSession: Awaited<ReturnType<AccountService['login']>> | undefined;
      let invalid = false;
      if (accounts) {
        try {
          accountSession = await accounts.login(b.email ?? '', b.password);
        } catch (error) {
          if ((error as { statusCode?: number }).statusCode !== 401) throw error;
          invalid = true;
        }
      } else
        invalid = !!options.password && !timingSafeEqual(hash(b.password), hash(options.password));
      if (invalid) {
        loginAttempts.set(req.ip, {
          count: (rate && rate.until > Date.now() ? rate.count : 0) + 1,
          until: Date.now() + 15 * 60_000,
        });
        return reply.code(401).send({ error: '访问密码不正确' });
      }
      loginAttempts.delete(req.ip);
      const token = accountSession?.token ?? randomBytes(32).toString('hex');
      if (!accounts)
        await db.put('sessions', hash(token).toString('hex'), {
          expiresAt: Date.now() + 7 * 86400_000,
        });
      reply.setCookie('zhizuo_session', token, {
        httpOnly: true,
        secure: options.origin?.startsWith('https:'),
        sameSite: 'strict',
        path: '/',
        maxAge: 7 * 86400,
      });
      return {
        authenticated: true,
        requiresPassword: mode !== 'local',
        mode,
        ...(accountSession
          ? {
              user: accountSession.user,
              workspaces: await accounts!.memberships(accountSession.user.id),
              activeWorkspaceId: accountSession.user.workspace.id,
            }
          : {}),
      };
    }),
  );
  app.delete('/api/session', async (req, reply) => {
    if (req.cookies.zhizuo_session) {
      if (accounts) await accounts.logout(req.cookies.zhizuo_session);
      else await db.remove('sessions', hash(req.cookies.zhizuo_session).toString('hex'));
    }
    reply.clearCookie('zhizuo_session', { path: '/' });
    reply.clearCookie('zhizuo_workspace', { path: '/' });
    return { ok: true };
  });
  const teamUser = (req: FastifyRequest) => {
    const user = identities.get(req);
    if (!user) {
      const error = new Error('登录状态已失效，请重新登录') as Error & { statusCode: number };
      error.statusCode = 401;
      throw error;
    }
    return user;
  };
  const lastAdminAlive = async () =>
    Number(
      (
        await db.query<{ count: string }>(
          "SELECT count(*) AS count FROM auth_users WHERE role='admin' AND NOT disabled",
        )
      )[0]?.count ?? 0,
    );
  const accountPasswordSchema = z.object({
    currentPassword: z.string().min(1).max(256),
    newPassword: z.string().min(12).max(256),
  });
  app.post('/api/account/password', async (req) => {
    const user = teamUser(req);
    const b = accountPasswordSchema.parse(req.body);
    await accounts!.changePassword(user.id, b.currentPassword, b.newPassword);
    return { ok: true };
  });
  app.get('/api/account/export', async (req, reply) => {
    const user = teamUser(req);
    const exported = await exportAccountData(db, repo, media, user.workspace.id, {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
    });
    return reply
      .header('Content-Disposition', 'attachment; filename="zhizuo-account.zip"')
      .type('application/zip')
      .send(exported.buffer);
  });
  app.delete('/api/account', async (req, reply) => {
    const user = teamUser(req);
    const b = z.object({ password: z.string().min(1).max(256) }).parse(req.body);
    if (!(await accounts!.verifyPassword(user.id, b.password)))
      throw new AccountError('密码不正确', 401, 'INVALID_CREDENTIALS');
    if (user.role === 'admin' && (await lastAdminAlive()) <= 1) {
      const error = new Error('至少保留一个可用的管理员账号') as Error & { statusCode: number };
      error.statusCode = 409;
      throw error;
    }
    const summary = await deleteAccountData(db, media, user.id, user.workspace.id);
    reply.clearCookie('zhizuo_session', { path: '/' });
    reply.clearCookie('zhizuo_workspace', { path: '/' });
    return { ok: true, ...summary };
  });
  app.get('/api/admin/accounts/:id/export', async (req, reply) => {
    const target = await accounts!
      .listAccounts()
      .then((rows) => rows.find((u) => u.id === getId(req)));
    if (!target) throw new NotFound('账号不存在');
    const exported = await exportAccountData(db, repo, media, target.workspace.id, {
      id: target.id,
      email: target.email,
      displayName: target.displayName,
    });
    return reply
      .header('Content-Disposition', `attachment; filename="zhizuo-account-${target.id}.zip"`)
      .type('application/zip')
      .send(exported.buffer);
  });
  app.post('/api/admin/accounts/:id/reset-password', async (req) => {
    await revalidateActor(req, true);
    const b = z.object({ newPassword: z.string().min(12).max(256) }).parse(req.body);
    await accounts!.resetPassword(getId(req), b.newPassword);
    return { ok: true };
  });
  app.delete('/api/admin/accounts/:id', async (req) => {
    const operator = teamUser(req);
    const b = z.object({ password: z.string().min(1).max(256) }).parse(req.body);
    await revalidateActor(req, true);
    const target = await accounts!
      .listAccounts()
      .then((rows) => rows.find((u) => u.id === getId(req)));
    if (!target) throw new NotFound('账号不存在');
    // 删除他人账号需操作者密码确认；最后一位管理员不可删除。
    if (!(await accounts!.verifyPassword(operator.id, b.password)))
      throw new AccountError('操作者密码不正确', 401, 'INVALID_CREDENTIALS');
    if (target.role === 'admin' && (await lastAdminAlive()) <= 1) {
      const error = new Error('至少保留一个可用的管理员账号') as Error & { statusCode: number };
      error.statusCode = 409;
      throw error;
    }
    // Revoke sessions before removing data so nothing new can be created mid-deletion.
    await accounts!.setDisabled(target.id, true);
    const summary = await deleteAccountData(db, media, target.id, target.workspace.id);
    return { ok: true, ...summary };
  });
  if (accounts) {
    app.get('/api/workspaces', async (req) => accounts!.memberships(teamUser(req).id));
    app.post('/api/workspaces/switch', async (req, reply) => {
      const user = teamUser(req);
      const b = z.object({ workspaceId: z.string().uuid() }).parse(req.body);
      const role = await accounts!.roleIn(user.id, b.workspaceId);
      if (!role) throw new NotFound('工作空间不存在');
      reply.setCookie('zhizuo_workspace', b.workspaceId, {
        httpOnly: true,
        secure: options.origin?.startsWith('https:'),
        sameSite: 'strict',
        path: '/',
        maxAge: 7 * 86400,
      });
      return { activeWorkspaceId: b.workspaceId, role };
    });
    app.post('/api/invites/accept', async (req) => {
      const user = teamUser(req);
      const b = z.object({ token: z.string().max(64) }).parse(req.body);
      return accounts!.acceptInvite(user.id, b.token);
    });
    app.get('/api/workspaces/:id/members', async (req) =>
      accounts!.listMembers(getId(req), teamUser(req).id),
    );
    app.delete('/api/workspaces/:id/members/:userId', async (req) => {
      await accounts!.removeMember(getId(req), teamUser(req).id, getId(req, 'userId'));
      return { ok: true };
    });
    app.post('/api/workspaces/:id/invites', async (req) => {
      const b = z.object({ expiresHours: z.number().int().min(1).max(168) }).parse(req.body);
      return accounts!.createInvite(getId(req), teamUser(req).id, b.expiresHours);
    });
    app.get('/api/workspaces/:id/invites', async (req) =>
      accounts!.listInvites(getId(req), teamUser(req).id),
    );
    app.post('/api/workspaces/:id/invites/:inviteId/revoke', async (req) => {
      await accounts!.revokeInvite(getId(req), teamUser(req).id, getId(req, 'inviteId'));
      return { ok: true };
    });
  }
  app.get('/api/admin/accounts', async () => accounts!.listAccounts());
  app.post('/api/admin/accounts', async (req) => {
    await revalidateActor(req, true);
    return accounts!.createAccount(
      z
        .object({
          email: z.string().email().max(254),
          password: z.string().min(12).max(256),
          displayName: z.string().min(1).max(80),
        })
        .parse(req.body),
    );
  });
  app.patch('/api/admin/accounts/:id', async (req) =>
    serializeTaskCreation(async () => {
      await revalidateActor(req, true);
      const { disabled } = z.object({ disabled: z.boolean() }).parse(req.body);
      if (disabled && identities.get(req)?.id === getId(req)) {
        const error = new Error('不能停用当前登录的管理员账号') as Error & { statusCode: number };
        error.statusCode = 409;
        throw error;
      }
      const user = await accounts!.setDisabled(getId(req), disabled);
      if (disabled) {
        const allProjects = await db.list<Project>('projects');
        const owned = new Set(
          allProjects.filter((p) => p.workspaceId === user.workspace.id).map((p) => p.id),
        );
        for (const task of await db.list<StoredTask>('tasks'))
          if (
            owned.has(task.projectId) &&
            ['queued', 'running', 'reconciling'].includes(task.status)
          )
            await runner.cancel(task.id);
      }
      return user;
    }),
  );
  app.get('/api/templates', async () => TEMPLATES);
  app.get('/api/projects', async (req) => projectsFor(req));
  const publicDetail = async (id: string) => {
    const d = await repo.detail(id);
    return { ...d, tasks: d.tasks.map((t) => publicTask(t as StoredTask)) };
  };
  app.post('/api/projects', async (req) => {
    const b = z
      .object({
        title: z.string().min(1).max(200),
        brief: briefSchema.partial().optional(),
        templateId: z.enum(['xhs-editorial', 'commerce-product', 'campaign-poster']).optional(),
      })
      .parse(req.body);
    const p = await repo.create(b.title, { ...EMPTY_BRIEF, ...b.brief }, workspace(req));
    if (b.templateId)
      await repo.version({
        projectId: p.id,
        kind: 'poster',
        label: TEMPLATES.find((t) => t.id === b.templateId)!.name,
        poster: makePoster(b.templateId, p.brief),
      });
    return publicDetail(p.id);
  });
  app.get('/api/projects/:id', async (req) => publicDetail(getId(req)));
  app.patch('/api/projects/:id', async (req) => {
    const b = z
      .object({
        revision: z.number().int().positive(),
        title: z.string().min(1).max(200).optional(),
        brief: briefSchema.optional(),
        board: boardSchema.optional(),
      })
      .parse(req.body);
    if (b.board) {
      const ids = new Set(b.board.nodes.map((n) => n.id));
      if (ids.size !== b.board.nodes.length) throw new Error('画布节点 ID 重复');
      if (b.board.edges.some((e) => !ids.has(e.source) || !ids.has(e.target)))
        throw new Error('连接引用了不存在的节点');
      const projectId = getId(req);
      const assetIds = new Set((await db.list<Asset>('assets', projectId)).map((a) => a.id));
      const versionIds = new Set(
        (await db.list<ContentVersion>('versions', projectId)).map((v) => v.id),
      );
      if (
        b.board.nodes.some(
          (n) =>
            (n.data.assetId && !assetIds.has(n.data.assetId)) ||
            (n.data.versionId && !versionIds.has(n.data.versionId)),
        )
      )
        throw new Error('画布引用了不属于当前项目的素材或版本');
      const taskIds = new Set((await db.list<StoredTask>('tasks', projectId)).map((t) => t.id));
      for (const n of b.board.nodes) {
        if (n.data.kind === 'generation' && n.data.taskId && !taskIds.has(n.data.taskId))
          throw new Error('画布引用了不属于当前项目的生成任务');
        if (
          n.data.taskSnapshot?.resultVersionId &&
          !versionIds.has(n.data.taskSnapshot.resultVersionId)
        )
          throw new Error('画布任务快照引用了不属于当前项目的版本');
      }
    }
    const { revision, ...patch } = b;
    return repo.update(getId(req), revision, patch);
  });
  app.get('/api/providers', async (req) =>
    (await db.list<StoredProvider>('providers'))
      .filter((p) => (p.workspaceId ?? 'local') === workspace(req))
      .map(publicProvider),
  );
  app.post('/api/providers', async (req) => {
    const b = validateProviderInput(req.body);
    const { apiKey, ...config } = b;
    if (!apiKey?.trim()) throw new Error('请填写 API Key');
    const p: StoredProvider = {
      ...config,
      workspaceId: workspace(req),
      id: randomUUID(),
      secret: encryptSecret(apiKey, key!),
      createdAt: now(),
    };
    await db.put('providers', p.id, p);
    return publicProvider(p);
  });
  app.put('/api/providers/:id', async (req) => {
    const id = getId(req);
    const old = await db.get<StoredProvider>('providers', id);
    if (!old) throw new NotFound('服务商不存在');
    const { apiKey, ...config } = validateProviderInput(req.body);
    const p = {
      ...old,
      ...config,
      secret: apiKey?.trim() ? encryptSecret(apiKey, key!) : old.secret,
    };
    await db.put('providers', id, p);
    return publicProvider(p);
  });
  app.delete('/api/providers/:id', async (req) => {
    await db.remove('providers', getId(req));
    return { ok: true };
  });
  app.post('/api/providers/:id/test', async (req) => {
    const p = await db.get<StoredProvider>('providers', getId(req));
    if (!p) throw new NotFound('服务商不存在');
    return testConnection(
      plainProvider(p),
      decryptSecret(p.secret, key!),
      AbortSignal.timeout(15_000),
    );
  });
  // 读取服务商模型目录供配置时选择；密钥仅用于本次请求，不落库。
  app.post('/api/providers/models', async (req) => {
    const b = z.object({ input: z.unknown(), apiKey: z.string().min(1).max(4096) }).parse(req.body);
    return listModels(validateProviderInput(b.input), b.apiKey, AbortSignal.timeout(15_000));
  });
  const brandUpdateSchema = brandInputSchema.extend({ revision: z.number().int().positive() });
  app.get('/api/brands', async (req) => {
    const archived = z
      .object({ archived: z.enum(['true', 'false']).optional() })
      .parse(req.query ?? {});
    return brands.list(workspace(req), archived.archived === 'true');
  });
  app.post('/api/brands', async (req) =>
    brands.create(workspace(req), brandInputSchema.parse(req.body)),
  );
  app.get('/api/brands/:id', async (req) => brands.get(getId(req), workspace(req)));
  app.put('/api/brands/:id', async (req) => {
    const { revision, ...input } = brandUpdateSchema.parse(req.body);
    return brands.update(getId(req), workspace(req), revision, input);
  });
  app.patch('/api/brands/:id/archive', async (req) => {
    const b = z.object({ archived: z.boolean() }).parse(req.body);
    return brands.setArchived(getId(req), workspace(req), b.archived);
  });
  app.post('/api/brands/:id/logo', async (req) => {
    const f = await req.file();
    if (!f) throw new Error('请选择 Logo 图片');
    return brands.uploadLogo(getId(req), workspace(req), await f.toBuffer(), f.filename);
  });
  app.get('/api/brands/:id/logo', async (req, reply) =>
    reply.type('image/png').send(await brands.logo(getId(req), workspace(req))),
  );
  app.post('/api/projects/:id/apply-brand', async (req) => {
    const b = z
      .object({ brandId: z.string().uuid(), revision: z.number().int().positive() })
      .parse(req.body);
    return brands.apply(b.brandId, workspace(req), getId(req), b.revision);
  });
  interface StoredMcpServer {
    id: string;
    workspaceId: string;
    name: string;
    endpoint: string;
    token: string;
    enabled: boolean;
    createdAt: string;
  }
  const publicMcp = (server: StoredMcpServer) => {
    const { token, ...rest } = server;
    return { ...rest, hasToken: !!token };
  };
  const ownedMcp = async (req: FastifyRequest, id: string) => {
    const server = await db.get<StoredMcpServer>('mcp_servers', id);
    if (!server || (server.workspaceId ?? 'local') !== workspace(req))
      throw new NotFound('发布通道不存在');
    return server;
  };
  app.get('/api/mcp-servers', async (req) =>
    (await db.list<StoredMcpServer>('mcp_servers'))
      .filter((server) => (server.workspaceId ?? 'local') === workspace(req))
      .map(publicMcp),
  );
  app.post('/api/mcp-servers', async (req) => {
    const b = z
      .object({
        name: z.string().trim().min(1).max(80),
        endpoint: z.string().url().max(2000),
        token: z.string().max(4096).optional(),
        enabled: z.boolean().optional(),
      })
      .parse(req.body);
    const server: StoredMcpServer = {
      id: randomUUID(),
      workspaceId: workspace(req),
      name: b.name,
      endpoint: b.endpoint.replace(/\/+$/, ''),
      token: b.token ? encryptSecret(b.token, key!) : '',
      enabled: b.enabled ?? true,
      createdAt: now(),
    };
    await db.put('mcp_servers', server.id, server);
    return publicMcp(server);
  });
  app.put('/api/mcp-servers/:id', async (req) => {
    const old = await ownedMcp(req, getId(req));
    const b = z
      .object({
        name: z.string().trim().min(1).max(80),
        endpoint: z.string().url().max(2000),
        token: z.string().max(4096).optional(),
        enabled: z.boolean().optional(),
      })
      .parse(req.body);
    const next: StoredMcpServer = {
      ...old,
      name: b.name,
      endpoint: b.endpoint.replace(/\/+$/, ''),
      enabled: b.enabled ?? old.enabled,
      token: b.token ? encryptSecret(b.token, key!) : old.token,
    };
    await db.put('mcp_servers', next.id, next);
    return publicMcp(next);
  });
  app.delete('/api/mcp-servers/:id', async (req) => {
    await ownedMcp(req, getId(req));
    await db.remove('mcp_servers', getId(req));
    return { ok: true };
  });
  app.post('/api/mcp-servers/:id/check', async (req, reply) => {
    const server = await ownedMcp(req, getId(req));
    if (!server.enabled) return reply.code(409).send({ error: '发布通道已停用' });
    const token = server.token ? decryptSecret(server.token, key!) : undefined;
    const result = await mcpCheckLogin({ endpoint: server.endpoint, token });
    return {
      loggedIn: result.loggedIn,
      raw: result.raw,
      tools: result.tools.map((tool) => tool.name),
    };
  });
  const assistantProvider = async (req: FastifyRequest, providerId: string) => {
    const provider = await ownedProvider(req, providerId);
    if (!provider.assistantModel) throw new NotFound('该服务商未配置助手模型，无法启动自动化');
    return {
      id: provider.id,
      name: provider.name,
      kind: provider.kind,
      baseUrl: provider.baseUrl,
      textModel: provider.textModel,
      imageModel: provider.imageModel,
      assistantModel: provider.assistantModel,
      timeoutSeconds: provider.timeoutSeconds,
      secret: provider.secret,
    };
  };
  app.post('/api/projects/:id/automation', async (req) =>
    serializeTaskCreation(() =>
      revalidateActor(req).then(async () => {
        const id = getId(req);
        const b = z
          .object({
            idea: z.string().trim().min(2).max(2000),
            imageCount: z.number().int().min(1).max(4).default(1),
            providerId: z.string().uuid(),
          })
          .parse(req.body);
        const provider = await assistantProvider(req, b.providerId);
        return assistant.startRun({
          projectId: id,
          workspaceId: workspace(req),
          provider,
          encryptionKey: key!,
          idea: b.idea,
          imageCount: b.imageCount,
        });
      }),
    ),
  );
  app.get('/api/projects/:id/automation', async (req) => {
    const id = getId(req);
    await repo.project(id);
    const runs = await db.query<{ id: string }>(
      "SELECT id FROM documents WHERE scope='automation_runs' AND body->>'projectId'=$1 ORDER BY body->>'createdAt' DESC",
      [id],
    );
    const result = [];
    for (const row of runs) result.push(await assistant.refreshRun(row.id, workspace(req)));
    return result;
  });
  app.get('/api/projects/:id/automation/:runId', async (req) => {
    await repo.project(getId(req));
    return assistant.refreshRun(getId(req, 'runId'), workspace(req));
  });
  app.post('/api/projects/:id/automation/:runId/regenerate', async (req) => {
    const b = z
      .object({
        imageId: z.string().uuid(),
        feedback: z.string().trim().max(500).optional(),
        providerId: z.string().uuid(),
      })
      .parse(req.body);
    const provider = await assistantProvider(req, b.providerId);
    return assistant.regenerateImage(
      getId(req, 'runId'),
      workspace(req),
      b.imageId,
      provider,
      key!,
      b.feedback,
    );
  });
  app.post('/api/projects/:id/automation/:runId/publish', async (req) => {
    const b = z
      .object({
        mcpServerId: z.string().uuid(),
        visibility: z.enum(['公开可见', '仅自己可见', '仅互关好友可见']).optional(),
      })
      .parse(req.body);
    const server = await ownedMcp(req, b.mcpServerId);
    if (!server.enabled) throw new NotFound('发布通道已停用');
    return assistant.publish(getId(req, 'runId'), workspace(req), {
      server: {
        id: server.id,
        name: server.name,
        endpoint: server.endpoint,
        token: server.token ? decryptSecret(server.token, key!) : undefined,
      },
      ...(b.visibility ? { visibility: b.visibility } : {}),
    });
  });
  app.delete('/api/projects/:id/automation/:runId', async (req) =>
    assistant.cancel(getId(req, 'runId'), workspace(req)),
  );
  app.post('/api/projects/:id/assets', async (req) => {
    const id = getId(req);
    await repo.project(id);
    const f = await req.file();
    if (!f) throw new Error('请选择图片');
    const bytes = await f.toBuffer();
    const a = await media.ingest(id, bytes, f.filename);
    await repo.append(id, {
      id: a.id,
      type: 'content',
      position: { x: 0, y: 0 },
      data: { kind: 'asset', label: a.name, assetId: a.id },
    });
    return a;
  });
  app.post('/api/projects/:id/uploads/presign', async (req) => {
    const id = getId(req);
    await repo.project(id);
    const b = z.object({ name: z.string().min(1).max(200) }).parse(req.body);
    return media.createPresignedUpload(id, b.name);
  });
  app.post('/api/projects/:id/uploads/presign/:uploadId/complete', async (req) => {
    const id = getId(req);
    await repo.project(id);
    const b = z
      .object({ token: z.string().uuid(), name: z.string().min(1).max(200) })
      .parse(req.body);
    const asset = await media.completePresignedUpload(id, getId(req, 'uploadId'), b.token, b.name);
    await repo.append(id, {
      id: asset.id,
      type: 'content',
      position: { x: 0, y: 0 },
      data: { kind: 'asset', label: asset.name, assetId: asset.id },
    });
    return asset;
  });
  app.get('/api/assets/:id/download-url', async (req) => {
    const id = getId(req);
    const asset = await db.get<Asset>('assets', id);
    if (!asset) throw new NotFound('素材不存在');
    return media.presignedDownload(id, asset.projectId);
  });
  app.get('/api/assets/:id/content', async (req, reply) => {
    const id = getId(req);
    if (!(await db.get('assets', id))) throw new NotFound('素材不存在');
    return reply.type('image/png').send(await media.bytes(id));
  });
  app.get('/api/assets/:id/thumbnail', async (req, reply) => {
    const id = getId(req);
    if (!(await db.get('assets', id))) throw new NotFound('素材不存在');
    return reply.type('image/webp').send(await media.thumbnail(id));
  });
  app.post('/api/projects/:id/tasks', async (req, reply) =>
    serializeTaskCreation(() =>
      db.transaction(async () => {
        await revalidateActor(req);
        enforceTaskRate(identities.get(req)?.id ?? 'local-operator');
        const id = getId(req);
        const project = await repo.project(id);
        const b = z
          .object({
            kind: z.enum(['copy', 'image']),
            providerId: z.string().uuid(),
            prompt: z.string().max(12000),
            referenceAssetId: z.string().uuid().optional(),
            parentVersionId: z.string().uuid().optional(),
            idempotencyKey: z.string().min(8).max(128),
          })
          .parse(req.body);
        if (!project.brief.confirmed || !project.brief.productName.trim())
          throw new Error('请先填写商品名称，并确认简报中的商品事实');
        if (b.kind === 'image' && !b.prompt.trim()) throw new Error('请填写图片生成需求');
        const taskId = createHash('sha256')
          .update(id + ':' + b.idempotencyKey)
          .digest('hex');
        // UUID-shaped stable key, scoped to project. Duplicate requests return the original task.
        const idStable = `${taskId.slice(0, 8)}-${taskId.slice(8, 12)}-4${taskId.slice(13, 16)}-a${taskId.slice(17, 20)}-${taskId.slice(20, 32)}`;
        const old = await db.get<StoredTask>('tasks', idStable);
        if (old) return publicTask(old);
        const provider = await ownedProvider(req, b.providerId);
        if (
          (b.kind === 'copy' && !provider.textModel) ||
          (b.kind === 'image' && !provider.imageModel)
        )
          throw new Error('服务商没有配置对应模型');
        if (b.referenceAssetId) await media.owned(b.referenceAssetId, id);
        if (
          b.parentVersionId &&
          (await db.get<ContentVersion>('versions', b.parentVersionId))?.projectId !== id
        )
          throw new Error('父版本不存在于当前项目');
        const t: StoredTask = {
          id: idStable,
          projectId: id,
          providerId: provider.id,
          kind: b.kind,
          prompt: b.prompt,
          referenceAssetId: b.referenceAssetId,
          parentVersionId: b.parentVersionId,
          status: 'queued',
          submissionStarted: false,
          attempts: 0,
          createdAt: now(),
          updatedAt: now(),
          brief: structuredClone(project.brief),
          config: plainProvider(provider),
          secret: provider.secret,
        };
        await quotas.reserve(t.id, workspace(req));
        const inserted = await db.query(
          `INSERT INTO documents(scope,id,body) VALUES('tasks',$1,$2::jsonb) ON CONFLICT DO NOTHING RETURNING id`,
          [t.id, JSON.stringify(t)],
        );
        if (inserted.length) {
          // Generation node is created in the same transaction as the task and its quota
          // reservation, so the board never references a task that failed to enqueue.
          await repo.append(
            id,
            {
              id: `task-${t.id}`,
              type: 'content',
              position: { x: 0, y: 0 },
              data: {
                kind: 'generation',
                label: b.kind === 'copy' ? '文案生成任务' : '图片生成任务',
                taskId: t.id,
              },
            },
            'brief',
          );
          await recordTaskEvent(db, {
            taskId: t.id,
            projectId: id,
            kind: 'queued',
          });
        }
        return publicTask(inserted.length ? t : (await db.get<StoredTask>('tasks', t.id))!);
      }),
    ),
  );
  app.get('/api/projects/:id/tasks', async (req) => {
    await repo.project(getId(req));
    return (await db.list<StoredTask>('tasks', getId(req))).map(publicTask);
  });
  app.get('/api/projects/:id/tasks/:taskId/events', async (req) => {
    const id = getId(req);
    const taskId = getId(req, 'taskId');
    const task = await db.get<StoredTask>('tasks', taskId);
    if (!task || task.projectId !== id) throw new NotFound('任务不存在');
    return listTaskEvents(db, taskId);
  });
  app.post('/api/tasks/:id/cancel', async (req) => runner.cancel(getId(req)));
  app.post('/api/projects/:id/versions', async (req) => {
    const projectId = getId(req);
    await repo.project(projectId);
    const b = z
      .object({
        kind: z.enum(['copy', 'poster']),
        label: z.string().min(1).max(200),
        parentVersionId: z.string().uuid().optional(),
        copy: copySchema.optional(),
        poster: posterSchema.optional(),
      })
      .parse(req.body);
    if ((b.kind === 'copy' && !b.copy) || (b.kind === 'poster' && !b.poster))
      throw new Error('版本缺少对应内容');
    if (b.poster?.assetId) await media.owned(b.poster.assetId, projectId);
    if (b.poster?.logoAssetId) await media.owned(b.poster.logoAssetId, projectId);
    if (
      b.parentVersionId &&
      (await db.get<ContentVersion>('versions', b.parentVersionId))?.projectId !== projectId
    )
      throw new Error('父版本不存在于当前项目');
    return repo.version({ ...b, projectId });
  });
  app.post('/api/projects/:id/posters', async (req) => {
    const projectId = getId(req);
    const project = await repo.project(projectId);
    const b = z
      .object({
        templateId: z.enum(['xhs-editorial', 'commerce-product', 'campaign-poster']),
        assetId: z.string().uuid().optional(),
      })
      .parse(req.body);
    if (b.assetId) await media.owned(b.assetId, projectId);
    return repo.version({
      projectId,
      kind: 'poster',
      label: TEMPLATES.find((t) => t.id === b.templateId)!.name,
      poster: makePoster(b.templateId, project.brief, b.assetId),
    });
  });
  app.post('/api/projects/:id/storyboards', async (req) => {
    const projectId = getId(req);
    const project = await repo.project(projectId);
    const b = z
      .object({
        copyVersionId: z.string().uuid(),
        templateId: z.enum(['xhs-editorial', 'commerce-product', 'campaign-poster']),
        assetId: z.string().uuid().optional(),
      })
      .parse(req.body);
    const source = await db.get<ContentVersion>('versions', b.copyVersionId);
    if (source?.projectId !== projectId || !source.copy?.pages.length)
      throw new Error('请选择有分页大纲的文案版本');
    if (b.assetId) await media.owned(b.assetId, projectId);
    const result: ContentVersion[] = [];
    for (const [i, page] of source.copy.pages.entries()) {
      const poster = makePoster(b.templateId, project.brief, b.assetId);
      poster.texts.find((t) => t.id === 'headline')!.text = page.headline;
      const body = poster.texts.find((t) => t.id === 'subline')!;
      body.text = page.body;
      body.fontSize = 28;
      // Place long page copy below the image, with explicit layout warnings if it will not fit.
      poster.imageBox = { x: 90, y: 360, width: 900, height: Math.round(poster.height * 0.34) };
      body.y = poster.imageBox.y + poster.imageBox.height + 45;
      const footer = poster.texts.find((t) => t.id === 'footer')!;
      footer.text = `${i + 1} / ${source.copy.pages.length} · ${project.brief.brand || '织作'}`;
      footer.fontSize = 26;
      result.push(
        await repo.version({
          projectId,
          kind: 'poster',
          label: `${i + 1}. ${page.headline}`.slice(0, 200),
          parentVersionId: source.id,
          poster,
          inputSnapshot: { copyVersionId: source.id, pageIndex: i, templateId: b.templateId },
        }),
      );
    }
    return result;
  });
  app.get('/api/versions/:id/preview', async (req, reply) => {
    const v = await db.get<ContentVersion>('versions', getId(req));
    if (!v?.poster) throw new NotFound('海报版本不存在');
    return reply.type('image/png').send(await media.render(v.poster, v.projectId));
  });
  const shareToken = (req: FastifyRequest) => {
    const token = req.headers['x-share-token'];
    return Array.isArray(token) ? token[0] : token;
  };
  const publicShareHeaders = (reply: {
    header: (
      name: string,
      value: string,
    ) => {
      header: (name: string, value: string) => unknown;
    };
  }) => {
    reply.header('Referrer-Policy', 'no-referrer').header('X-Robots-Tag', 'noindex,nofollow');
    return reply;
  };
  app.get('/api/projects/:id/shares', async (req) => shares.list(getId(req), workspace(req)));
  app.post('/api/projects/:id/shares', async (req) =>
    shares.create(getId(req), workspace(req), req.body),
  );
  app.post('/api/projects/:id/shares/:shareId/revoke', async (req) =>
    shares.revoke(getId(req), workspace(req), getId(req, 'shareId')),
  );
  app.get('/api/public-shares', async (req, reply) => {
    publicShareHeaders(reply);
    return shares.read(shareToken(req) ?? '');
  });
  app.get('/api/public-shares/versions/:id/preview', async (req, reply) => {
    publicShareHeaders(reply);
    return reply.type('image/png').send(await shares.preview(shareToken(req) ?? '', getId(req)));
  });
  app.post('/api/exports', async (req, reply) => {
    const b = z
      .object({
        projectId: z.string().uuid(),
        versionIds: z.array(z.string().uuid()).min(1).max(20),
        acknowledged: z.literal(true),
      })
      .parse(req.body);
    await ownedProject(req, b.projectId);
    const exportProject = await repo.project(b.projectId);
    const exportBanned = exportProject.brief.bannedTerms;
    const files: Record<string, Uint8Array> = {};
    const manifest: { id: string; label: string; warnings: string[] }[] = [];
    let total = 0;
    for (const [i, id] of b.versionIds.entries()) {
      const v = await db.get<ContentVersion>('versions', id);
      if (!v || v.projectId !== b.projectId) throw new Error('导出版本不属于当前项目');
      const prefix = `${String(i + 1).padStart(2, '0')}-${v.kind}`;
      const warnings = contentWarnings(JSON.stringify(v.copy ?? v.poster ?? ''), exportBanned);
      if (v.poster) {
        warnings.push(...layoutPoster(v.poster).warnings);
        files[`${prefix}.png`] = await media.render(v.poster, v.projectId);
      }
      if (v.assetId) {
        await media.owned(v.assetId, b.projectId);
        files[`${prefix}.png`] = await media.bytes(v.assetId);
      }
      if (v.copy) {
        files[`${prefix}.md`] = strToU8(
          `# ${v.copy.titles[0]}\n\n${v.copy.body}\n\n${v.copy.tags.map((t) => (t.startsWith('#') ? t : '#' + t)).join(' ')}\n\n${v.copy.pages.map((p, n) => `## ${n + 1}. ${p.headline}\n${p.body}`).join('\n\n')}`,
        );
        files[`${prefix}.json`] = strToU8(JSON.stringify(v.copy, null, 2));
      }
      manifest.push({ id, label: v.label, warnings });
      total = Object.values(files).reduce((n, f) => n + f.length, 0);
      if (total > 100 * 1024 * 1024) throw new Error('单次导出超过100 MB，请分批导出');
    }
    files['说明.json'] = strToU8(
      JSON.stringify(
        {
          createdAt: now(),
          note: '内容为草稿，请确认商品事实、价格、授权与目标平台要求后发布。AI生成素材可能改变商品外观，请人工核对。',
          versions: manifest,
        },
        null,
        2,
      ),
    );
    return reply
      .header('Content-Disposition', 'attachment; filename="zhizuo-content.zip"')
      .type('application/zip')
      .send(Buffer.from(zipSync(files, { level: 1 })));
  });
  app.get('/api/projects/:id/backup', async (req, reply) =>
    reply
      .header('Content-Disposition', 'attachment; filename="zhizuo-project.zip"')
      .type('application/zip')
      .send(await backup(repo, media, getId(req))),
  );
  app.post('/api/import', async (req) => {
    const file = await req.file();
    if (!file) throw new Error('请选择织作项目 ZIP 备份');
    return restore(repo, media, await file.toBuffer(), workspace(req));
  });
  const quotaWorkspace = async (req: FastifyRequest) => {
    const id = z
      .union([z.literal('local'), z.string().uuid()])
      .parse((req.params as { id: string }).id);
    if (mode !== 'accounts') {
      if (id !== 'local') throw new NotFound('工作空间不存在');
      return id;
    }
    if (!(await db.query('SELECT id FROM auth_workspaces WHERE id=$1', [id])).length)
      throw new NotFound('工作空间不存在');
    return id;
  };
  const operator = (req: FastifyRequest) => identities.get(req)?.id ?? 'local-operator';
  app.get('/api/admin/quota-workspaces', async () =>
    accounts
      ? (await accounts.listAccounts()).map((u) => ({
          id: u.workspace.id,
          name: u.workspace.name + (u.disabled ? '（已停用）' : ''),
          email: u.email,
        }))
      : [{ id: 'local', name: '本地工作空间' }],
  );
  app.get('/api/admin/quotas/:id', async (req) => quotas.summary(await quotaWorkspace(req)));
  app.patch('/api/admin/quotas/:id', async (req) => {
    await revalidateActor(req, mode === 'accounts');
    const b = z
      .object({
        limit: z.number().int().min(0).max(1_000_000),
        reason: z.string().trim().min(1).max(500),
      })
      .parse(req.body);
    return quotas.setLimit(await quotaWorkspace(req), b.limit, b.reason, operator(req));
  });
  app.get('/api/admin/quotas/:id/reviews', async (req) => {
    const b = z
      .object({
        cursor: z.string().max(2000).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      })
      .parse(req.query);
    return quotas.reviewRecords(await quotaWorkspace(req), b);
  });
  app.post('/api/admin/quotas/:id/resolve', async (req) => {
    await revalidateActor(req, mode === 'accounts');
    const workspaceId = await quotaWorkspace(req);
    const b = z
      .object({
        taskId: z.string().uuid(),
        action: z.enum(['consume', 'release']),
        reason: z.string().trim().min(1).max(500),
      })
      .parse(req.body);
    await db.transaction(async () => {
      const [row] = await db.query<{ body: StoredTask; active: boolean }>(
        `SELECT body,
        COALESCE((body->>'leaseExpiresAt')::timestamptz > clock_timestamp(),false) AS active
        FROM documents WHERE scope='tasks' AND id=$1 FOR UPDATE`,
        [b.taskId],
      );
      if (!row) throw new NotFound('任务不存在');
      const project = await repo.project(row.body.projectId);
      if ((project.workspaceId ?? 'local') !== workspaceId) throw new NotFound('任务不存在');
      if (['queued', 'running'].includes(row.body.status) || row.active) {
        const e = new Error('任务仍在排队、运行或占用执行租约，请先停止任务后刷新核对') as Error & {
          statusCode: number;
        };
        e.statusCode = 409;
        throw e;
      }
      if (row.body.status === 'succeeded' && b.action === 'release') {
        const e = new Error('任务已成功完成，请结算该任务或单独调整空间额度') as Error & {
          statusCode: number;
        };
        e.statusCode = 409;
        throw e;
      }
      await quotas.settle(row.body);
      await quotas.resolve(b.taskId, b.action, b.reason, operator(req));
      if (row.body.status === 'reconciling')
        await db.put('tasks', b.taskId, {
          ...row.body,
          status: 'cancelled',
          recoveryStopped: true,
          error: '已人工核对任务额度，自动查询已停止；供应商实际结果与费用以其记录为准。',
          updatedAt: now(),
        });
    });
    return quotas.summary(workspaceId);
  });
  app.get('/api/usage', async (req) => {
    const ids = new Set((await projectsFor(req)).map((p) => p.id));
    const quota = await quotas.summary(workspace(req));
    return {
      dailyLimit: quota.limit,
      records: (await db.list<{ projectId: string }>('usage')).filter((r) => ids.has(r.projectId)),
      quota,
    };
  });
  if (options.staticRoot) {
    try {
      await stat(path.join(options.staticRoot, 'index.html'));
      await app.register(staticFiles, { root: options.staticRoot });
      app.setNotFoundHandler((req, reply) =>
        req.url.startsWith('/api/')
          ? reply.code(404).send({ error: '接口不存在' })
          : reply.sendFile('index.html'),
      );
    } catch {
      /* Development server serves the web app. */
    }
  }
  app.addHook('onClose', runtime.close);
  runtime.startMaintenance();
  if (options.worker !== false) await runner.start();
  return { app, db, repo, media, runner, accounts, quotas };
}
