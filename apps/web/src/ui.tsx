import { useRef, type ReactNode } from 'react';
import { Button } from './components/ui/button';
import { Badge } from './components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './components/ui/dialog';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from './components/ui/alert-dialog';
import { AlertCircle, ArrowUpRight, Check, LoaderCircle, X } from 'lucide-react';
export type Notify = (text: string, tone?: 'success' | 'error') => void;
export function Spinner({ label = '正在加载' }: { label?: string }) {
  return (
    <span className="spinner" role="status">
      <LoaderCircle size={17} className="spin" />
      {label}
    </span>
  );
}
export function ErrorBox({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="error-box">
      <AlertCircle size={17} />
      <span>{children}</span>
    </div>
  );
}
export function Modal({
  title,
  description,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const opener = useRef(document.activeElement as HTMLElement | null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className={`modal shadcn-modal ${wide ? 'modal-wide' : ''}`}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          opener.current?.focus();
        }}
      >
        <div className="modal-heading">
          <div>
            <DialogTitle asChild>
              <h2>{title}</h2>
            </DialogTitle>
            <DialogDescription className={description ? undefined : 'sr-only'}>
              {description || `${title}操作面板`}
            </DialogDescription>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="icon-button"
            aria-label="关闭弹窗"
            onClick={onClose}
          >
            <X size={20} />
          </Button>
        </div>
        {children}
      </DialogContent>
    </Dialog>
  );
}
export function ConfirmModal({
  title,
  description,
  children,
  onClose,
}: {
  title: string;
  description: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const opener = useRef(document.activeElement as HTMLElement | null);
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AlertDialogContent
        className="modal shadcn-modal"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          opener.current?.focus();
        }}
      >
        <div className="modal-heading">
          <div>
            <AlertDialogTitle asChild>
              <h2>{title}</h2>
            </AlertDialogTitle>
            <AlertDialogDescription>{description}</AlertDialogDescription>
          </div>
        </div>
        {children}
      </AlertDialogContent>
    </AlertDialog>
  );
}
export function Tag({ children, tone = '' }: { children: ReactNode; tone?: string }) {
  return (
    <Badge variant="outline" className={`tag ${tone}`}>
      {children}
    </Badge>
  );
}
export function TemplateArt({ kind, compact = false }: { kind: string; compact?: boolean }) {
  const campaign = kind === 'campaign-poster',
    commerce = kind === 'commerce-product';
  return (
    <div
      className={`template-art ${campaign ? 'art-purple' : commerce ? 'art-peach' : 'art-sage'} ${compact ? 'art-compact' : ''}`}
      aria-hidden="true"
    >
      <div className="art-topline">
        {campaign ? 'THE NEXT CHAPTER' : commerce ? 'EVERYDAY ESSENTIALS' : 'SLOW LIVING / VOL. 01'}
        <ArrowUpRight size={14} />
      </div>
      <div className="art-title">
        {campaign ? (
          <>
            好事，
            <br />
            即将发生。
          </>
        ) : commerce ? (
          <>
            认真挑选
            <br />
            生活的每一件
          </>
        ) : (
          <>
            把日常
            <br />
            过成喜欢的样子
          </>
        )}
      </div>
      <div className="art-stilllife">
        <div className="art-ellipse" />
        <div className="art-vase">
          <div />
        </div>
        <div className="art-stem stem-one" />
        <div className="art-stem stem-two" />
        <div className="art-circle" />
      </div>
      <div className="art-footer">
        {campaign ? 'NEW IDEAS, NEW POSSIBILITIES' : 'LITTLE THINGS. BIG JOY.'}
        <span>织作</span>
      </div>
    </div>
  );
}
export function Toast({ text, tone }: { text: string; tone: string }) {
  return (
    <div className={`toast ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {tone === 'error' ? <AlertCircle size={18} /> : <Check size={18} />}
      {text}
    </div>
  );
}
export function formatTime(value: string) {
  const date = new Date(value);
  return date.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
