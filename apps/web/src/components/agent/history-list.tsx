'use client';

import { GROUP_NAME_MAX_LENGTH, TITLE_MAX_LENGTH } from '@agile/agent/limits';
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  Folder,
  FolderInput,
  FolderMinus,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  archiveConversationAction,
  type ConversationActionResult,
  createGroupAction,
  deleteConversationAction,
  deleteGroupAction,
  moveConversationAction,
  renameConversationAction,
  renameGroupAction,
} from '@/app/(app)/agent/actions';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { HistoryGroup } from './group-conversations';
import { NameDialog } from './name-dialog';

export interface HistoryItem {
  id: string;
  title: string;
  /** Formatted on the server (no time zone mismatch on hydration). */
  when: string;
  groupId: string | null;
  archived: boolean;
}

export interface HistoryFolder {
  id: string;
  name: string;
  items: HistoryItem[];
}

export interface SidebarHistory {
  folders: HistoryFolder[];
  dated: { key: HistoryGroup; items: HistoryItem[] }[];
  archived: HistoryItem[];
}

const COLLAPSED_KEY = 'agent-collapsed-groups';

/** The ids of the groups this browser keeps closed (storage can be missing: none then). */
function useCollapsedGroups() {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]');
      if (Array.isArray(stored)) setCollapsed(new Set(stored.filter((x) => typeof x === 'string')));
    } catch {}
  }, []);
  const toggle = (id: string, open: boolean) =>
    setCollapsed((was) => {
      const next = new Set(was);
      if (open) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {}
      return next;
    });
  return { collapsed, toggle };
}

/** Shows a refused change as a toast; true when it went through. */
function useOutcome() {
  const t = useTranslations('agent.manage');
  return (result: ConversationActionResult) => {
    if (!result.ok) toast.error(t(`errors.${result.code}`));
    return result.ok;
  };
}

export function HistoryList({
  history,
  currentId,
  onNavigate,
}: {
  history: SidebarHistory;
  currentId: string;
  onNavigate: () => void;
}) {
  const t = useTranslations('agent');
  const { collapsed, toggle } = useCollapsedGroups();
  const [creating, setCreating] = useState(false);
  const row = (c: HistoryItem) => (
    <ConversationRow
      key={c.id}
      item={c}
      current={c.id === currentId}
      folders={history.folders}
      onNavigate={onNavigate}
    />
  );

  return (
    <nav
      aria-label={t('history')}
      className="-mr-2 grid min-h-0 content-start gap-4 overflow-y-auto pr-2"
    >
      <section className="grid gap-0.5">
        <div className="flex items-center justify-between pb-1 pl-2">
          <h2 className="font-medium text-muted-foreground text-xs">{t('manage.groups')}</h2>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-6"
            onClick={() => setCreating(true)}
            aria-label={t('manage.newGroup')}
            title={t('manage.newGroup')}
          >
            <FolderPlus />
          </Button>
        </div>
        {history.folders.map((f) => (
          <FolderSection
            key={f.id}
            folder={f}
            open={!collapsed.has(f.id)}
            onOpenChange={(open) => toggle(f.id, open)}
          >
            {f.items.length === 0 ? (
              <p className="px-2 py-1 text-muted-foreground text-xs">{t('manage.emptyGroup')}</p>
            ) : (
              f.items.map(row)
            )}
          </FolderSection>
        ))}
      </section>
      {history.dated.map((g) => (
        <section key={g.key} className="grid gap-0.5">
          <h2 className="px-2 pb-1 font-medium text-muted-foreground text-xs">
            {t(`historyGroups.${g.key}`)}
          </h2>
          {g.items.map(row)}
        </section>
      ))}
      {history.archived.length > 0 && (
        <Collapsible className="grid gap-0.5">
          <CollapsibleTrigger className="group flex items-center gap-1 rounded-md px-2 py-1 text-left font-medium text-muted-foreground text-xs hover:bg-muted">
            <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
            <Archive className="size-3.5" aria-hidden />
            {t('manage.archived', { count: history.archived.length })}
          </CollapsibleTrigger>
          <CollapsibleContent className="grid gap-0.5">
            {history.archived.map(row)}
          </CollapsibleContent>
        </Collapsible>
      )}
      <NameDialog
        open={creating}
        onOpenChange={setCreating}
        title={t('manage.newGroupTitle')}
        label={t('manage.groupName')}
        maxLength={GROUP_NAME_MAX_LENGTH}
        submitLabel={t('manage.create')}
        onSubmit={(name) => createGroupAction(name)}
      />
    </nav>
  );
}

function FolderSection({
  folder,
  open,
  onOpenChange,
  children,
}: {
  folder: HistoryFolder;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  const t = useTranslations('agent.manage');
  const outcome = useOutcome();
  const [renaming, setRenamingState] = useState(false);
  const [deleting, setDeletingState] = useState(false);
  const opening = useRef(false);
  const setRenaming = (open: boolean) => {
    opening.current = open;
    setRenamingState(open);
  };
  const setDeleting = (open: boolean) => {
    opening.current = open;
    setDeletingState(open);
  };
  const [pending, startTransition] = useTransition();

  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="grid gap-0.5">
      <div className="group/row flex items-center rounded-md hover:bg-muted">
        <CollapsibleTrigger className="group flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left text-sm">
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
          <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate">{folder.name}</span>
          <span className="ml-auto text-muted-foreground text-xs">{folder.items.length}</span>
        </CollapsibleTrigger>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <RowMenuButton label={t('groupActions', { name: folder.name })} />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            onCloseAutoFocus={(e) => {
              if (opening.current) e.preventDefault();
              opening.current = false;
            }}
          >
            <DropdownMenuItem onSelect={() => setRenaming(true)}>
              <Pencil />
              {t('rename')}
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
              <Trash2 />
              {t('deleteGroup')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <CollapsibleContent className="grid gap-0.5 pl-4">{children}</CollapsibleContent>
      <NameDialog
        open={renaming}
        onOpenChange={setRenaming}
        title={t('renameGroupTitle')}
        label={t('groupName')}
        initial={folder.name}
        maxLength={GROUP_NAME_MAX_LENGTH}
        submitLabel={t('save')}
        onSubmit={(name) => renameGroupAction(folder.id, name)}
      />
      <Confirm
        open={deleting}
        onOpenChange={setDeleting}
        title={t('deleteGroupTitle', { name: folder.name })}
        description={t('deleteGroupHint')}
        action={t('deleteGroup')}
        pending={pending}
        onConfirm={() =>
          startTransition(async () => {
            if (outcome(await deleteGroupAction(folder.id))) setDeleting(false);
          })
        }
      />
    </Collapsible>
  );
}

function ConversationRow({
  item,
  current,
  folders,
  onNavigate,
}: {
  item: HistoryItem;
  current: boolean;
  folders: HistoryFolder[];
  onNavigate: () => void;
}) {
  const t = useTranslations('agent.manage');
  const outcome = useOutcome();
  const [dialog, setDialogState] = useState<'rename' | 'group' | 'delete' | null>(null);
  const opening = useRef(false);
  const setDialog = (next: 'rename' | 'group' | 'delete' | null) => {
    opening.current = next !== null;
    setDialogState(next);
  };
  const [pending, startTransition] = useTransition();
  const run = (action: () => Promise<ConversationActionResult>) =>
    startTransition(async () => {
      outcome(await action());
    });
  const close = (open: boolean) => {
    if (!open) setDialog(null);
  };

  return (
    <div
      className={cn(
        'group/row flex items-center rounded-md hover:bg-muted',
        current && 'bg-muted',
        pending && 'opacity-60',
      )}
    >
      <Link
        href={`/agent/${item.id}`}
        title={`${item.title} · ${item.when}`}
        aria-current={current ? 'page' : undefined}
        onClick={onNavigate}
        className={cn('min-w-0 flex-1 truncate px-2 py-1.5 text-sm', current && 'font-medium')}
      >
        {item.title}
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <RowMenuButton label={t('actions', { title: item.title })} visible={current} />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-56"
          onCloseAutoFocus={(e) => {
            // A dialog opened from the menu keeps the focus (on its field).
            if (opening.current) e.preventDefault();
            opening.current = false;
          }}
        >
          <DropdownMenuItem onSelect={() => setDialog('rename')}>
            <Pencil />
            {t('rename')}
          </DropdownMenuItem>
          {!item.archived && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <FolderInput />
                {t('moveTo')}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-72 w-52 overflow-y-auto">
                {folders.map((f) => (
                  <DropdownMenuCheckboxItem
                    key={f.id}
                    checked={item.groupId === f.id}
                    onSelect={() => {
                      if (item.groupId !== f.id) run(() => moveConversationAction(item.id, f.id));
                    }}
                  >
                    <span className="truncate">{f.name}</span>
                  </DropdownMenuCheckboxItem>
                ))}
                {folders.length > 0 && <DropdownMenuSeparator />}
                <DropdownMenuItem onSelect={() => setDialog('group')}>
                  <FolderPlus />
                  {t('newGroup')}
                </DropdownMenuItem>
                {item.groupId && (
                  <DropdownMenuItem
                    onSelect={() => run(() => moveConversationAction(item.id, null))}
                  >
                    <FolderMinus />
                    {t('removeFromGroup')}
                  </DropdownMenuItem>
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          <DropdownMenuItem
            onSelect={() => run(() => archiveConversationAction(item.id, !item.archived))}
          >
            {item.archived ? <ArchiveRestore /> : <Archive />}
            {item.archived ? t('unarchive') : t('archive')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setDialog('delete')}>
            <Trash2 />
            {t('delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <NameDialog
        open={dialog === 'rename'}
        onOpenChange={close}
        title={t('renameTitle')}
        label={t('titleLabel')}
        initial={item.title}
        maxLength={TITLE_MAX_LENGTH}
        submitLabel={t('save')}
        onSubmit={(title) => renameConversationAction(item.id, title)}
      />
      <NameDialog
        open={dialog === 'group'}
        onOpenChange={close}
        title={t('newGroupTitle')}
        label={t('groupName')}
        maxLength={GROUP_NAME_MAX_LENGTH}
        submitLabel={t('create')}
        onSubmit={(name) => createGroupAction(name, item.id)}
      />
      <Confirm
        open={dialog === 'delete'}
        onOpenChange={close}
        title={t('deleteTitle')}
        description={t('deleteHint', { title: item.title })}
        action={t('delete')}
        pending={pending}
        onConfirm={() =>
          startTransition(async () => {
            if (current) onNavigate();
            // The open conversation: the action redirects to a new chat when it succeeds.
            const result = await deleteConversationAction(item.id, current);
            // No result: the action redirected away.
            if (result && outcome(result)) setDialog(null);
          })
        }
      />
    </div>
  );
}

/** The "…" button of a sidebar row: shown on hover or focus (always on touch screens). */
function RowMenuButton({
  label,
  visible = false,
  ...props
}: { label: string; visible?: boolean } & React.ComponentProps<typeof Button>) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className={cn(
        'size-7 shrink-0 opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100',
        visible && 'opacity-100',
      )}
      aria-label={label}
      title={label}
      {...props}
    >
      <MoreHorizontal />
    </Button>
  );
}

function Confirm({
  open,
  onOpenChange,
  title,
  description,
  action,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  action: string;
  pending: boolean;
  onConfirm: () => void;
}) {
  const t = useTranslations('agent.manage');
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={(e) => {
              // Closed by the outcome, not by the click: a refusal keeps it open.
              e.preventDefault();
              onConfirm();
            }}
          >
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
