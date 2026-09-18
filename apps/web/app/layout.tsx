import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Polyglot — Multi-Provider AI Workbench',
  description: 'One interface, several providers, several tenants.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
