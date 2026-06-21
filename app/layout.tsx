import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ChargeBI 智能充电运营问数助手",
  description: "面向城市充电网络运营的 AI 问数 Copilot Demo"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}

