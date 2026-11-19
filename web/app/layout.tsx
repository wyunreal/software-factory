import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Software Factory",
  description: "Start issue runs and follow the factory pipeline.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
