import type { ReactNode } from 'react';
import { AppSidebar } from '@/components/app-sidebar';
import { PageBreadcrumb } from '@/components/page-breadcrumb';
import { Separator } from '@/components/ui/separator';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { billingEnabled } from '@/server/billing';
import { signedInActor } from '@/server/context';

/**
 * Every page here calls `requireActor()` itself (to onboarding without a workspace), except the
 * Account page, which anyone signed in may open (M3: their data, with or without a workspace).
 * So the layout only needs a session; without a workspace it renders the page alone.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const actor = await signedInActor();
  if (!actor) {
    return (
      <div className="flex min-h-svh flex-col bg-muted p-6 md:p-10">
        <div className="mx-auto w-full max-w-4xl">{children}</div>
      </div>
    );
  }
  return (
    <SidebarProvider>
      <AppSidebar user={actor.user} billing={billingEnabled()} />
      <SidebarInset>
        <header className="flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
          <div className="flex items-center gap-2 px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator
              orientation="vertical"
              className="mr-2 data-vertical:h-4 data-vertical:self-auto"
            />
            <PageBreadcrumb />
          </div>
        </header>
        <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
          {/* @container/main: the dashboard grids (dashboard-01) respond to this container's width. */}
          <div className="@container/main mx-auto w-full max-w-6xl">{children}</div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
