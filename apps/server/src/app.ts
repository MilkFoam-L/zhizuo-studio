import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { zipSync, strToU8 } from 'fflate';
import type { Asset, ContentVersion, Project } from '../../../packages/shared/src/index';
import { EMPTY_BRIEF, makePoster, TEMPLATES } from '../../../packages/shared/src/index';
import { contentWarnings, layoutPoster } from '../../../packages/shared/src/poster-layout';
import { openDatabase } from './db';
import { Repository, NotFound, now } from './repository';
import { Media } from './media';
import {
  JobRunner,
  publicTask,
  publicProvider,
  type StoredProvider,
  type StoredTask,
} from './jobs';
import { validateProviderInput, encryptSecret, decryptSecret, testConnection } from './providers';
import { boardSchema, briefSchema, copySchema, posterSchema } from './validation';
import { backup, restore } from './backup';

export interface AppOptions {
  dataDir: string;
  databaseUrl?: string;
  encryptionKey?: string;
  password?: string;
  origin?: string;
  worker?: boolean;
  staticRoot?: string;
}
const idSchema = z.string().uuid();
const hash = (v: string) => createHash('sha256').update(v).digest();
const plainProvider = (p: StoredProvider) => {
  const { secret, id, createdAt, ...config } = p;
  return config;
};
export async function createApp(options: AppOptions) {
  await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
  let key = options.encryptionKey;
  if (!key) {
    const f = path.join(options.dataDir, 'encryption.key');
    try {
      key = await readFile(f, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      key = randomBytes(32).toString('hex');
      await writeFile(f, key, { mode: 0o600, flag: 'wx' });
    }
  }
  if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error('ENCRYPTION_KEY 必须为 64 位十六进制字符串');
  const db = await openDatabase(options.dataDir, options.databaseUrl);
  const repo = new Repository(db);
  const media = new Media(db, options.dataDir);
  const runner = new JobRunner(db, repo, media, key);
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024, files: 1, fields: 5 } });
  const loginAttempts = new Map<string, { count: number; until: number }>();
  const maxDaily = Number(process.env.MAX_DAILY_TASKS || 100);
  if (!Number.isSafeInteger(maxDaily) || maxDaily < 1)
    throw new Error('MAX_DAILY_TASKS 必须是正整数');
  let taskCreationTail: Promise<unknown> = Promise.resolve();
  function serializeTaskCreation<T>(fn: () => Promise<T>): Promise<T> {
    const next = taskCreationTail.then(fn, fn);
    taskCreationTail = next.catch(() => {});
    return next;
  }
  const day = (iso: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(iso));
  const getId = (req: { params: unknown }, name = 'id') =>
    idSchema.parse((req.params as Record<string, unknown>)[name]);
  const isAuthenticated = async (token?: string) => {
    if (!options.password) return true;
    if (!token) return false;
    const session = await db.get<{ expiresAt: number }>('sessions', hash(token).toString('hex'));
    return !!session && session.expiresAt > Date.now();
  };
  app.addHook('onRequest', async (req, reply) => {
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'same-origin')
      .header('X-Frame-Options', 'DENY');
    if (req.url.startsWith('/api')) reply.header('Cache-Control', 'no-store');
    const host = req.headers.host?.split(':')[0];
    if (!options.password && !['127.0.0.1', 'localhost', '[::1]'].includes(host || ''))
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
      if (
        !['/api/session', '/api/health'].includes(route) &&
        !(await isAuthenticated(req.cookies.zhizuo_session))
      )
        return reply.code(401).send({ error: '请先登录工作台' });
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
    mode: options.password ? 'private-hosted' : 'local',
  }));
  app.get('/api/session', async (req) => ({
    authenticated: await isAuthenticated(req.cookies.zhizuo_session),
    requiresPassword: !!options.password,
  }));
  app.post('/api/session', async (req, reply) => {
    const b = z.object({ password: z.string().max(1024) }).parse(req.body);
    const rate = loginAttempts.get(req.ip);
    if (rate && rate.until > Date.now() && rate.count >= 5)
      return reply.code(429).send({ error: '尝试次数过多，请 15 分钟后再试' });
    if (options.password && !timingSafeEqual(hash(b.password), hash(options.password))) {
      loginAttempts.set(req.ip, {
        count: (rate && rate.until > Date.now() ? rate.count : 0) + 1,
        until: Date.now() + 15 * 60_000,
      });
      return reply.code(401).send({ error: '访问密码不正确' });
    }
    loginAttempts.delete(req.ip);
    const token = randomBytes(32).toString('hex');
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
    return { authenticated: true };
  });
  app.delete('/api/session', async (req, reply) => {
    if (req.cookies.zhizuo_session)
      await db.remove('sessions', hash(req.cookies.zhizuo_session).toString('hex'));
    reply.clearCookie('zhizuo_session', { path: '/' });
    return { ok: true };
  });
  app.get('/api/templates', async () => TEMPLATES);
  app.get('/api/projects', async () => db.list<Project>('projects'));
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
    const p = await repo.create(b.title, { ...EMPTY_BRIEF, ...b.brief });
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
    }
    const { revision, ...patch } = b;
    return repo.update(getId(req), revision, patch);
  });
  app.get('/api/providers', async () =>
    (await db.list<StoredProvider>('providers')).map(publicProvider),
  );
  app.post('/api/providers', async (req) => {
    const b = validateProviderInput(req.body);
    const { apiKey, ...config } = b;
    if (!apiKey?.trim()) throw new Error('请填写 API Key');
    const p: StoredProvider = {
      ...config,
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
  app.get('/api/assets/:id/content', async (req, reply) => {
    const id = getId(req);
    if (!(await db.get('assets', id))) throw new NotFound('素材不存在');
    return reply.type('image/png').send(await media.bytes(id));
  });
  app.get('/api/assets/:id/thumbnail', async (req, reply) => {
    const id = getId(req);
    if (!(await db.get('assets', id))) throw new NotFound('素材不存在');
    return reply.type('image/webp').send(await readFile(media.filename(id, true)));
  });
  app.post('/api/projects/:id/tasks', async (req, reply) =>
    serializeTaskCreation(async () => {
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
      const tasks = await db.list<StoredTask>('tasks');
      if (tasks.filter((t) => day(t.createdAt) === day(now())).length >= maxDaily)
        return reply
          .code(429)
          .send({ error: '今日任务数量已达上限，请明天再试或由管理员调整限额' });
      const provider = await db.get<StoredProvider>('providers', b.providerId);
      if (!provider) throw new Error('请先配置并选择服务商');
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
        attempts: 0,
        createdAt: now(),
        updatedAt: now(),
        brief: structuredClone(project.brief),
        config: plainProvider(provider),
        secret: provider.secret,
      };
      const inserted = await db.query(
        `INSERT INTO documents(scope,id,body) VALUES('tasks',$1,$2::jsonb) ON CONFLICT DO NOTHING RETURNING id`,
        [t.id, JSON.stringify(t)],
      );
      return publicTask(inserted.length ? t : (await db.get<StoredTask>('tasks', t.id))!);
    }),
  );
  app.get('/api/projects/:id/tasks', async (req) => {
    await repo.project(getId(req));
    return (await db.list<StoredTask>('tasks', getId(req))).map(publicTask);
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
  app.post('/api/exports', async (req, reply) => {
    const b = z
      .object({
        projectId: z.string().uuid(),
        versionIds: z.array(z.string().uuid()).min(1).max(20),
        acknowledged: z.literal(true),
      })
      .parse(req.body);
    await repo.project(b.projectId);
    const files: Record<string, Uint8Array> = {};
    const manifest: { id: string; label: string; warnings: string[] }[] = [];
    let total = 0;
    for (const [i, id] of b.versionIds.entries()) {
      const v = await db.get<ContentVersion>('versions', id);
      if (!v || v.projectId !== b.projectId) throw new Error('导出版本不属于当前项目');
      const prefix = `${String(i + 1).padStart(2, '0')}-${v.kind}`;
      const warnings = contentWarnings(JSON.stringify(v.copy ?? v.poster ?? ''));
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
    return restore(repo, media, await file.toBuffer());
  });
  app.get('/api/usage', async () => ({ dailyLimit: maxDaily, records: await db.list('usage') }));
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
  app.addHook('onClose', async () => {
    await runner.stop();
    await db.close();
  });
  if (options.worker !== false) await runner.start();
  return { app, db, repo, media, runner };
}
