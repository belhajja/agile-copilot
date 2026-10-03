import type { Metadata } from 'next';
import localFont from 'next/font/local';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale } from 'next-intl/server';
import type { ReactNode } from 'react';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import './globals.css';

// The radix-nova preset's Geist font, self-hosted from the `geist` package (no build-time download, so
// offline/air-gapped builds work) and exposed as `--font-sans`, which the generated globals.css expects.
const fontSans = localFont({
  src: '../../node_modules/geist/dist/fonts/geist-sans/Geist-Variable.woff2',
  variable: '--font-sans',
  weight: '100 900',
});

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
