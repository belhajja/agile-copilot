import type { ComponentProps, ReactNode } from 'react';

/**
 * A connection (AI model, Jira site, delivery channel) in a settings list: what it is on top, its
 * actions in one row below (the destructive one pushed right), then optional sections such as the
 * AI model prices. One column, so long labels never squeeze the fields or the buttons.
 */
export function ConnectionCard({
  icon,
  title,
  badges,
  details,
  error,
  actions,
  danger,
  children,
  ...props
}: Omit<ComponentProps<'li'>, 'title'> & {
  icon: ReactNode;
  title: ReactNode;
  badges?: ReactNode;
  details?: ReactNode;
  error?: ReactNode;
  actions?: ReactNode;
  /** Shown at the end of the actions row (Delete). */
  danger?: ReactNode;
  children?: ReactNode;
}) {
  return (
    // data-slot="item": how the e2e tests find a connection on a settings page.
    <li data-slot="item" className="rounded-lg border bg-card text-sm" {...props}>
      <div className="flex gap-3 p-4">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted [&_svg]:size-4">
          {icon}
        </div>
        <div className="grid min-w-0 flex-1 gap-1">
          <div className="flex flex-wrap items-center gap-2 font-medium">
            {title}
            {badges}
          </div>
          {details && (
            <div className="grid gap-0.5 wrap-anywhere text-muted-foreground">{details}</div>
          )}
          {error && <p className="text-destructive">{error}</p>}
        </div>
      </div>
      {(actions || danger) && (
        <div className="flex flex-wrap items-center gap-2 border-t px-4 py-3">
          {actions}
          {danger && <div className="ms-auto">{danger}</div>}
        </div>
      )}
      {children}
    </li>
  );
}

/** A titled part of a connection card, under a separator. */
export function ConnectionCardSection({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-3 border-t px-4 py-3">
      <div className="grid gap-0.5">
        <h3 className="font-medium">{title}</h3>
        {description && <p className="text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

/** The list around connection cards. */
export function ConnectionList({ children }: { children: ReactNode }) {
  return <ul className="grid gap-3">{children}</ul>;
}
