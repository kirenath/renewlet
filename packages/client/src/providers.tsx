/**
 * 全局 Providers（只在客户端运行）。
 *
 * 这里集中放：
 * - React Query：请求缓存/并发/重试
 * - 本地 ThemeProvider：主题切换（dark/light + 主题色）
 * - CustomConfigProvider：自定义配置（分类/状态/支付方式/货币）
 * - Toast/Tooltip：全局交互反馈
 * - AuthSync：保持本地认证会话与路由状态一致
 */

import { useState } from "react";
import { Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "@/lib/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { CustomConfigProvider } from "@/contexts/CustomConfigContext";
import { AuthSync } from "@/components/auth-sync";
import { AppearanceSync } from "@/components/appearance-sync";
import CustomCssInjector from "@/components/custom-css-injector";
import { I18nProvider } from "@/i18n/I18nProvider";

/** 应用级 Provider 组合（请将所有页面都包在里面）。 */
export default function Providers({ children }: { children: React.ReactNode }) {
  // QueryClient 需要在整个应用生命周期内保持单例（避免缓存丢失）
  const [queryClient] = useState(() => new QueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      {/* 路由同步组件只做客户端副作用，包在 Suspense 内保持渲染边界稳定。 */}
      <I18nProvider>
        <Suspense fallback={null}>
          <AuthSync />
        </Suspense>
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
          <AppearanceSync />
          <CustomCssInjector />
          <CustomConfigProvider>
            <TooltipProvider>
              <Sonner />
              {children}
            </TooltipProvider>
          </CustomConfigProvider>
        </ThemeProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}
