import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Steyoyoke CMS",
  description: "Publishing control room for Steyoyoke content.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
