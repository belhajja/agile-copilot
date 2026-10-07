import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** The frame of a settings page: the same width, title and intro on every page. */
export function SettingsPage({
  title,
  description,
  actions,
  className,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Beside the title (wraps under it on small screens). */
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('mx-auto grid w-full max-w-4xl gap-6', className)}>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="grid min-w-0 gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="text-muted-foreground">{description}</p>}
        </div>
        {actions}
      </header>
      {children}
    </div>
  );
}
