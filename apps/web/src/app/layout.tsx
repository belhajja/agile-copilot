import type { Metadata } from 'next';
import { Geist } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale } from 'next-intl/server';
import type { ReactNode } from 'react';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import './globals.css';

// The radix-nova preset's font, wired the way `shadcn init` does for Next (it found no layout to edit).
const fontSans = Geist({ subsets: ['latin'], variable: '--font-sans' });

export const metadata: Metadata = { title: 'Agile Copilot' };

export default async function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang={await getLocale()} className={fontSans.variable}>
      <body className="min-h-svh bg-background text-foreground antialiased">
        <NextIntlClientProvider>
          {/* shadcn 4.21's sidebar no longer mounts its own TooltipProvider (see `shadcn add tooltip`). */}
          <TooltipProvider>{children}</TooltipProvider>
          <Toaster />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
