import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  AutomationImageItem,
  AutomationRun,
  Brief,
  ContentVersion,
} from '../../../packages/shared/src/index';
import { PROMPT_LIBRARY } from '../../../packages/shared/src/index';
import type { Database } from './db';
import type { Media } from './media';
import type { Repository } from './repository';
import type { QuotaService } from './quotas';
import type { StoredTask } from './jobs';
import { recordTaskEvent } from './jobs';
import {
  decryptSecret,
  encryptSecret,
  generateWithTools,
  type AssistantMessage,
  type AssistantTool,
  type AssistantToolCall,
} from './providers';
import { mcpPublishContent, type McpEndpointConfig } from './mcp';

const MAX_TOOL_ROUNDS = 8;

export interface AssistantOptions {
  dataDir: string;
  maxImageAttempts?: number;
  /** 测试注入：替换助手模型的单轮工具调用实现。 */
  generateWithTools?: typeof generateWithTools;
}

export class AssistantError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'AssistantError';
  }
}

export interface AssistantProviderRef {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  textModel: string;
  imageModel: string;
  assistantModel?: string;
  timeoutSeconds: number;
  secret: string;
}

interface ToolLoopContext {
  brief: Brief;
  imageCount: number;
  images: AutomationImageItem[];
  draft: { title: string; content: string; tags: string[] };
}

/** 自动化发布编排器：想法 → 助手模型草稿 → 生图任务 → 人工确认 → MCP 发布。 */
export class AssistantService {
  private readonly maxImageAttempts: number;
  constructor(
    private readonly db: Database,
    private readonly repo: Repository,
    private readonly media: Media,
    private readonly quotas: QuotaService,
    private readonly key: string,
    private readonly options: AssistantOptions,
  ) {
    this.maxImageAttempts = options.maxImageAttempts ?? 3;
  }

  private async saveRun(run: AutomationRun) {
    await this.db.put('automation_runs', run.id, { ...run, updatedAt: new Date().toISOString() });
  }

  async getRun(runId: string): Promise<AutomationRun> {
    const run = await this.db.get<AutomationRun>('automation_runs', runId);
    if (!run) throw new AssistantError('自动化流程不存在', 404);
    return run;
  }

  private async assertRunWorkspace(run: AutomationRun, workspaceId: string) {
    const project = await this.repo.project(run.projectId).catch(() => undefined);
    if (!project || (project.workspaceId ?? 'local') !== workspaceId)
      throw new AssistantError('自动化流程不存在', 404);
  }

  private runTaskId(runId: string, imageId: string, attempt: number): string {
    const hash = createHash('sha256').update(`${runId}:${imageId}:${attempt}`).digest('hex');
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  }

  private async createImageTask(input: {
    run: AutomationRun;
    workspaceId: string;
    brief: Brief;
    provider: AssistantProviderRef;
    encryptionKey: string;
    image: AutomationImageItem;
    attempt: number;
  }): Promise<StoredTask> {
    const id = this.runTaskId(input.run.id, input.image.id, input.attempt);
    const existing = await this.db.get<StoredTask>('tasks', id);
    if (existing) return existing;
    const stored: StoredTask = {
      id,
      projectId: input.run.projectId,
      providerId: input.provider.id,
      kind: 'image',
      prompt: input.image.prompt.slice(0, 4000),
      attempts: 0,
      status: 'queued',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      brief: input.brief,
      config: {
        name: input.provider.name,
        kind: input.provider.kind as StoredTask['config']['kind'],
        baseUrl: input.provider.baseUrl,
        textModel: input.provider.textModel,
        imageModel: input.provider.imageModel,
        timeoutSeconds: input.provider.timeoutSeconds,
      },
      secret: encryptSecret(input.provider.secret, input.encryptionKey),
    };
    await this.quotas.reserve(id, input.workspaceId);
    await this.db.put('tasks', id, stored);
    await recordTaskEvent(this.db, { taskId: id, projectId: input.run.projectId, kind: 'queued' });
    return stored;
  }

  /**
   * 创建自动化流程：跑助手模型工具循环（读简报 → 查提示词库 → 逐张添加配图 → 提交草稿）。
   * 图片任务在此过程中直接创建（复用任务管线：额度预占、事件记录）。
   */
  async startRun(input: {
    projectId: string;
    workspaceId: string;
    provider: AssistantProviderRef;
    encryptionKey: string;
    idea: string;
    imageCount: number;
  }): Promise<AutomationRun> {
    const project = await this.repo.project(input.projectId);
    if ((project.workspaceId ?? 'local') !== input.workspaceId)
      throw new AssistantError('项目不存在', 404);
    if (!project.brief.confirmed)
      throw new AssistantError('请先确认简报中的商品事实，再启动自动化');
    const imageCount = Math.min(Math.max(1, Math.floor(input.imageCount)), 4);
    const now = new Date().toISOString();
    const run: AutomationRun = {
      id: randomUUID(),
      projectId: input.projectId,
      providerId: input.provider.id,
      status: 'reviewing',
      idea: input.idea.slice(0, 2000),
      imageCount,
      draft: { title: '', content: '', tags: [], images: [] },
      imageTaskIds: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.saveRun(run);

    const context: ToolLoopContext = {
      brief: project.brief,
      imageCount,
      images: run.draft.images,
      draft: run.draft,
    };
    const tools: AssistantTool[] = [
      {
        name: 'read_brief',
        description: '读取当前项目的商品事实简报（名称、卖点、受众、价格、品牌）',
        parameters: { type: 'object' },
      },
      {
        name: 'search_prompt_library',
        description: '按关键词查询提示词库，返回适合小红书生图的提示词模板',
        parameters: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: '关键词，如 陶瓷、封面、生活方式' },
          },
          required: ['keyword'],
        },
      },
      {
        name: 'add_image_prompt',
        description:
          '为笔记添加一张配图的生图提示词（可多次调用，直到凑齐张数），调用即创建生图任务',
        parameters: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: '完整的图片生成提示词，[变量] 已替换为商品信息，含画幅比例',
            },
          },
          required: ['prompt'],
        },
      },
      {
        name: 'finish_draft',
        description: '文案与配图提示词齐备后调用，提交最终草稿',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '笔记标题（≤20 字）' },
            content: { type: 'string', description: '笔记正文（300–800 字，含 emoji 与分段）' },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: '3–6 个话题标签（不带 #）',
            },
          },
          required: ['title', 'content', 'tags'],
        },
      },
    ];
    const messages: AssistantMessage[] = [
      {
        role: 'user',
        content: [
          '你是小红书内容运营助手。项目商品事实必须用 read_brief 工具读取，不要臆测。',
          `创作者的想法：${input.idea}`,
          `请产出一份小红书图文笔记草稿，配图 ${imageCount} 张。`,
          '步骤：read_brief 了解商品 →（可选）search_prompt_library 参考提示词模板 → add_image_prompt 逐张给出配图提示词（会自动创建生图任务）→ finish_draft 提交标题、正文与话题标签。',
          '配图提示词必须把商品信息代入 [变量]，风格贴合小红书：明亮、真实、有分享感。正文不得编造销量、评价或认证。',
        ].join('\n'),
      },
    ];
    try {
      const secret = decryptSecret(input.provider.secret, input.encryptionKey);
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const generate = this.options.generateWithTools ?? generateWithTools;
        const turn = await generate(
          {
            name: input.provider.name,
            kind: input.provider.kind as 'openai' | 'gemini',
            baseUrl: input.provider.baseUrl,
            textModel: input.provider.textModel,
            imageModel: input.provider.imageModel,
            assistantModel: input.provider.assistantModel,
            timeoutSeconds: input.provider.timeoutSeconds,
          },
          secret,
          messages,
          tools,
          AbortSignal.timeout(input.provider.timeoutSeconds * 1000),
        );
        messages.push({
          role: 'assistant',
          content: turn.content,
          toolCalls: turn.toolCalls.length ? turn.toolCalls : undefined,
        });
        if (!turn.toolCalls.length)
          throw new AssistantError('助手模型未调用工具即结束，请重试或更换助手模型');
        let finished = false;
        for (const call of turn.toolCalls) {
          const result = await this.executeTool(call, context, {
            run,
            workspaceId: input.workspaceId,
            brief: project.brief,
            provider: input.provider,
            encryptionKey: input.encryptionKey,
          });
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            toolName: call.name,
            content: result,
          });
          if (call.name === 'finish_draft') finished = true;
        }
        if (finished) break;
      }
    } catch (error) {
      run.status = 'failed';
      run.error = error instanceof Error ? error.message.slice(0, 300) : '助手模型编排失败';
      await this.saveRun(run);
      throw error;
    }
    run.imageTaskIds = run.draft.images.map((image) => image.taskId!).filter(Boolean);
    if (!run.draft.title || !run.draft.content)
      throw new AssistantError('助手模型未产出完整文案草稿，请重试或更换助手模型');
    if (!run.draft.images.length) throw new AssistantError('助手模型未产出任何配图提示词');
    // 草稿完成后生图任务在途，等待全部落定后由 refreshRun 提升为 ready。
    run.status = 'generating';
    await this.saveRun(run);
    return run;
  }

  private async executeTool(
    call: AssistantToolCall,
    context: ToolLoopContext,
    taskContext: {
      run: AutomationRun;
      workspaceId: string;
      brief: Brief;
      provider: AssistantProviderRef;
      encryptionKey: string;
    },
  ): Promise<string> {
    switch (call.name) {
      case 'read_brief':
        return JSON.stringify(context.brief);
      case 'search_prompt_library': {
        const keyword = String((call.arguments as { keyword?: unknown })?.keyword ?? '');
        const hits = PROMPT_LIBRARY.filter(
          (entry) => entry.title.includes(keyword) || entry.prompt.includes(keyword),
        ).slice(0, 5);
        return JSON.stringify(hits.map((entry) => ({ title: entry.title, prompt: entry.prompt })));
      }
      case 'add_image_prompt': {
        const prompt = String((call.arguments as { prompt?: unknown })?.prompt ?? '').trim();
        if (!prompt) return '提示词为空，已忽略';
        if (context.images.length >= context.imageCount)
          return `已达到 ${context.imageCount} 张配图上限，请调用 finish_draft 提交草稿`;
        const image: AutomationImageItem = {
          id: randomUUID(),
          prompt,
          attempts: 1,
          status: 'generating',
        };
        const task = await this.createImageTask({
          run: taskContext.run,
          workspaceId: taskContext.workspaceId,
          brief: taskContext.brief,
          provider: taskContext.provider,
          encryptionKey: taskContext.encryptionKey,
          image,
          attempt: 1,
        });
        image.taskId = task.id;
        context.images.push(image);
        taskContext.run.imageTaskIds.push(task.id);
        return `已创建生图任务 ${task.id}`;
      }
      case 'finish_draft': {
        const args = call.arguments as { title?: unknown; content?: unknown; tags?: unknown };
        context.draft.title = String(args.title ?? '').slice(0, 100);
        context.draft.content = String(args.content ?? '').slice(0, 4000);
        context.draft.tags = Array.isArray(args.tags)
          ? (args.tags as unknown[])
              .map((tag) => String(tag).slice(0, 30))
              .filter(Boolean)
              .slice(0, 6)
          : [];
        return '草稿已提交';
      }
      default:
        return `未知工具 ${call.name}`;
    }
  }

  /** 依据生图任务进度刷新运行状态；图片全部落定后进入 ready。 */
  async refreshRun(runId: string, workspaceId: string): Promise<AutomationRun> {
    const run = await this.getRun(runId);
    await this.assertRunWorkspace(run, workspaceId);
    if (run.status !== 'generating') return run;
    let allDone = true;
    for (const image of run.draft.images) {
      if (!image.taskId || image.status === 'done') continue;
      const task = await this.db.get<StoredTask>('tasks', image.taskId);
      if (!task) {
        image.status = 'failed';
        continue;
      }
      if (task.status === 'succeeded' && task.resultVersionId) {
        image.status = 'done';
        image.versionId = task.resultVersionId;
      } else if (['failed', 'cancelled'].includes(task.status)) {
        image.status = 'failed';
      } else {
        allDone = false;
      }
    }
    if (allDone)
      run.status = run.draft.images.some((image) => image.status === 'done') ? 'ready' : 'failed';
    await this.saveRun(run);
    return run;
  }

  /** 单图重新生成（保留反馈），消耗新的任务额度。 */
  async regenerateImage(
    runId: string,
    workspaceId: string,
    imageId: string,
    provider: AssistantProviderRef,
    encryptionKey: string,
    feedback?: string,
  ): Promise<AutomationRun> {
    const run = await this.getRun(runId);
    await this.assertRunWorkspace(run, workspaceId);
    if (run.status !== 'ready' && run.status !== 'reviewing')
      throw new AssistantError('当前状态不允许重新生成图片', 409);
    const image = run.draft.images.find((item) => item.id === imageId);
    if (!image) throw new AssistantError('配图不存在', 404);
    if (image.attempts >= this.maxImageAttempts)
      throw new AssistantError(`该配图已重试 ${this.maxImageAttempts} 次，达到上限`, 409);
    if (feedback) image.feedback = feedback.slice(0, 500);
    image.attempts += 1;
    image.status = 'generating';
    image.versionId = undefined;
    const prompt = image.feedback ? `${image.prompt}\n调整要求：${image.feedback}` : image.prompt;
    const task = await this.createImageTask({
      run,
      workspaceId,
      brief: (await this.repo.project(run.projectId)).brief,
      provider,
      encryptionKey,
      image,
      attempt: image.attempts,
    });
    image.taskId = task.id;
    run.status = 'generating';
    await this.saveRun(run);
    return run;
  }

  /** 发布前把选中配图导出为 PNG 到本地 staging 目录，返回文件路径列表。 */
  private async stagePublishImages(run: AutomationRun): Promise<string[]> {
    const dir = path.join(this.options.dataDir, 'publish-staging', run.id);
    await mkdir(dir, { recursive: true });
    const paths: string[] = [];
    for (const [index, image] of run.draft.images.entries()) {
      if (image.status !== 'done' || !image.versionId) continue;
      const version = await this.db.get<ContentVersion>('versions', image.versionId);
      if (!version) continue;
      const bytes = version.assetId
        ? await this.media.bytes(version.assetId)
        : version.poster
          ? await this.media.render(version.poster, run.projectId)
          : undefined;
      if (!bytes) continue;
      const file = path.join(dir, `${index + 1}.png`);
      await writeFile(file, bytes);
      paths.push(file);
    }
    if (!paths.length) throw new AssistantError('没有可发布的图片，请先生成配图');
    return paths;
  }

  /** 用户显式确认后发布到小红书（MCP publish_content）。 */
  async publish(
    runId: string,
    workspaceId: string,
    input: {
      server: { id: string; name: string; endpoint: string; token: string | undefined };
      visibility?: string;
    },
  ): Promise<AutomationRun> {
    const run = await this.getRun(runId);
    await this.assertRunWorkspace(run, workspaceId);
    if (run.status !== 'ready') throw new AssistantError('自动化流程尚未就绪，不能发布', 409);
    run.status = 'publishing';
    await this.saveRun(run);
    try {
      const images = await this.stagePublishImages(run);
      const tags = run.draft.tags.length ? run.draft.tags : undefined;
      const mcpConfig: McpEndpointConfig = {
        endpoint: input.server.endpoint,
        token: input.server.token,
      };
      const result = await mcpPublishContent(mcpConfig, {
        title: run.draft.title,
        content: run.draft.content,
        images,
        ...(tags ? { tags } : {}),
        ...(input.visibility ? { visibility: input.visibility } : {}),
      });
      run.status = 'published';
      run.publish = {
        serverId: input.server.id,
        serverName: input.server.name,
        visibility: input.visibility ?? '公开可见',
        response: result.raw || '发布完成',
        at: new Date().toISOString(),
      };
      await this.saveRun(run);
      return run;
    } catch (error) {
      run.status = 'ready';
      run.error = error instanceof Error ? error.message.slice(0, 300) : '发布失败';
      await this.saveRun(run);
      throw error;
    }
  }

  async cancel(runId: string, workspaceId: string): Promise<AutomationRun> {
    const run = await this.getRun(runId);
    await this.assertRunWorkspace(run, workspaceId);
    if (!['reviewing', 'ready', 'generating', 'failed'].includes(run.status))
      throw new AssistantError('当前状态不可取消', 409);
    run.status = 'cancelled';
    await this.saveRun(run);
    return run;
  }
}
