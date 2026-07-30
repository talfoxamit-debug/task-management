import './globals.css';
import type { ReactNode } from 'react';

export const metadata = {
  title: 'TaskOS',
  description: 'Given real milestones and real hours, what is going to slip?',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
