import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Eye, Link2Off, RefreshCw } from 'lucide-react';
import type { SharedContent } from '../../../packages/shared/src/index';
import { Button } from './components/ui/button';
import { Card } from './components/ui/card';
import { ErrorBox, Spinner, formatTime } from './ui';
import './sharing.css';

const unavailable = '分享链接已失效或不可用，请向创作者获取新的链接。';

async function publicRequest(path: string, token: string, signal: AbortSignal) {
  const response = await fetch(`/api/public-shares${path}`, {
    signal,
    headers: { 'X-Share-Token': token },
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
  }).catch(() => {
    throw new Error('网络连接未完成，请检查连接后重试。');
  });
  if (!response.ok)
    throw new Error(response.status === 404 ? unavailable : '暂时无法读取分享，请稍后重试。');
  return response;
}

function SharedPreview({
  token,
  version,
}: {
  token: string;
  version: SharedContent['versions'][number];
}) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setUrl('');
    setError('');
    void publicRequest(
      `/versions/${encodeURIComponent(version.id)}/preview`,
      token,
      controller.signal,
    )
      .then((response) => response.blob())
      .then((blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : '预览加载失败，请稍后重试。');
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [token, version.id, retry]);

  return (
    <div className="share-preview">
      {error ? (
        <div className="share-empty">
          <ErrorBox>{error}</ErrorBox>
          <Button variant="outline" onClick={() => setRetry((value) => value + 1)}>
            <RefreshCw aria-hidden="true" />
            重新加载预览
          </Button>
        </div>
      ) : url ? (
        <img
          src={url}
          alt={version.label}
          width={version.width}
          height={version.height}
          onError={() => setError('预览无法显示，请重新加载。')}
        />
      ) : (
        <Spinner label="正在加载预览" />
      )}
    </div>
  );
}

function CopyPreview({ copy }: { copy: NonNullable<SharedContent['versions'][number]['copy']> }) {
  return (
    <div className="shared-copy">
      <section aria-label="标题">
        <h3>标题</h3>
        <ul>
          {copy.titles.map((title, index) => (
            <li key={index}>{title}</li>
          ))}
        </ul>
      </section>
      <section aria-label="正文">
        <h3>正文</h3>
        <p>{copy.body}</p>
      </section>
      {copy.tags.length > 0 && (
        <p className="share-tags" aria-label="话题标签">
          {copy.tags.map((tag) => `#${tag}`).join('  ')}
        </p>
      )}
      {copy.pages.map((page, index) => (
        <section key={index} aria-label={`第 ${index + 1} 页`}>
          <h3>{page.headline}</h3>
          <p>{page.body}</p>
        </section>
      ))}
    </div>
  );
}

export function PublicShare({ token }: { token: string }) {
  const [content, setContent] = useState<SharedContent>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [index, setIndex] = useState(0);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setContent(undefined);
    setError('');
    setLoading(true);
    setIndex(0);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      setError(unavailable);
      setLoading(false);
      return () => controller.abort();
    }
    void publicRequest('', token, controller.signal)
      .then((response) => response.json() as Promise<SharedContent>)
      .then((result) => {
        if (!controller.signal.aborted) setContent(result);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : '暂时无法读取分享，请稍后重试。');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [token, retry]);

  const version = content?.versions[index];
  return (
    <main className="public-share">
      <header className="public-share-brand">
        <span>织作 ZhiZuo</span>
        <span>
          <Eye aria-hidden="true" size={16} />
          只读分享
        </span>
      </header>
      {loading ? (
        <Card className="share-empty">
          <Spinner label="正在读取分享内容" />
        </Card>
      ) : error ? (
        <Card className="share-empty">
          <Link2Off size={32} aria-hidden="true" />
          <h1>暂时无法查看</h1>
          <ErrorBox>{error}</ErrorBox>
          <Button variant="outline" onClick={() => setRetry((value) => value + 1)}>
            <RefreshCw aria-hidden="true" />
            重新加载
          </Button>
        </Card>
      ) : content ? (
        <>
          <div className="public-share-heading">
            <h1>{content.title}</h1>
            <p>创作者选定的内容快照 · 有效期至 {formatTime(content.expiresAt)}</p>
          </div>
          {version ? (
            <Card className="shared-version">
              <div className="shared-version-heading">
                <div>
                  <h2>{version.label}</h2>
                  <p>
                    {version.kind === 'copy' ? '文案' : version.kind === 'poster' ? '海报' : '图片'}{' '}
                    · {formatTime(version.createdAt)}
                  </p>
                </div>
                <span className="share-counter" aria-live="polite">
                  {index + 1} / {content.versions.length}
                </span>
              </div>
              {version.kind === 'copy' && version.copy ? (
                <CopyPreview copy={version.copy} />
              ) : (
                <SharedPreview key={`${token}:${version.id}`} token={token} version={version} />
              )}
            </Card>
          ) : (
            <Card className="share-empty">
              <p>此分享中没有可查看的内容。</p>
            </Card>
          )}
          {content.versions.length > 1 && (
            <nav className="share-pagination" aria-label="切换分享内容">
              <Button
                variant="outline"
                disabled={index === 0}
                onClick={() => setIndex((value) => value - 1)}
              >
                <ArrowLeft aria-hidden="true" />
                上一份
              </Button>
              <label htmlFor="shared-version-select" className="sr-only">
                选择分享内容
              </label>
              <select
                id="shared-version-select"
                value={index}
                onChange={(event) => setIndex(Number(event.target.value))}
              >
                {content.versions.map((version, index) => (
                  <option key={version.id} value={index}>
                    {index + 1}. {version.label}
                  </option>
                ))}
              </select>
              <Button
                variant="outline"
                disabled={index === content.versions.length - 1}
                onClick={() => setIndex((value) => value + 1)}
              >
                下一份
                <ArrowRight aria-hidden="true" />
              </Button>
            </nav>
          )}
        </>
      ) : null}
      <footer>由织作呈现 · 内容由创作者选择分享</footer>
    </main>
  );
}
