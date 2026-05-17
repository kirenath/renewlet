/**
 * Settings React Query 数据层。
 *
 * 架构位置：
 * - PocketBase collection 负责持久化，hook 负责当前用户记录的 upsert。
 * - hook 负责缓存键、401 降级和前端类型归一。
 *
 * Caveat: 未登录返回 DEFAULT_SETTINGS 是为了让公共页面/登录前 Provider 能安全渲染；
 * 受保护页面仍由 AuthSync 控制访问。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DEFAULT_SETTINGS,
  WEBHOOK_HEADERS_PLACEHOLDER,
  WEBHOOK_PAYLOAD_PLACEHOLDER,
  type AppSettings,
} from "@/types/subscription";
import { settingsUpdateBodySchema } from "@/lib/api/schemas/settings";
import { getSystemTimeZone } from "@/lib/time/time-zone";
import { getCurrentUserId, pb, type RecordModel } from "@/lib/pocketbase";
import { getApiLocale } from "@/i18n/api-locale";
import { translate } from "@/i18n/messages";

/**
 * 将后端返回的 settings 进行校验，并与默认值合并。
 *
 * 说明：
 * - 兼容历史数据：数据库里可能只存了部分字段（JSONB），因此前端要补齐默认值
 * - 兼容扩展字段：未知字段会被 Zod 自动剔除，避免污染 UI 状态
 * - 兼容浏览器环境：timezone 默认值来自 Intl，避免新用户通知时间落到固定 UTC 口径
 *
 * Caveat: 这是 Settings JSON 进入前端 domain 的唯一入口。新增字段必须同步
 * `DEFAULT_SETTINGS`、`settingsUpdateBodySchema`、后端 `appSettings` 和保存表单。
 */
function clearLegacyWebhookExample(value: string, legacyExample: string) {
  return value.trim() === legacyExample ? "" : value;
}

export function normalizeSettings(value: unknown): AppSettings {
  const parsed = settingsUpdateBodySchema.safeParse(value);
  const defaults = { ...DEFAULT_SETTINGS, timezone: getSystemTimeZone("UTC") };
  if (!parsed.success) return defaults;
  // partial schema 会保留 undefined，直接 spread 会把默认值覆盖成 undefined；
  // 先过滤才能保证新增字段和历史半量 JSON 都能得到完整 AppSettings。
  const patch = Object.fromEntries(
    Object.entries(parsed.data).filter(([, item]) => item !== undefined),
  ) as Partial<AppSettings>;
  const settings: AppSettings = { ...defaults, ...patch };
  // 自定义主题悬空指针修正：partial schema 的引用完整性校验仅在 customThemes
  // 与 activeCustomThemeId 同时提供时生效（避免误拒 PATCH）。当 patch 只提供
  // activeCustomThemeId、与默认空 customThemes 合并后会出现指向不存在主题的
  // 悬空 id；这里收敛为 null，使输出始终通过完整 appSettingsSchema 校验。
  const ids = new Set(settings.customThemes.map((theme) => theme.id));
  const activeCustomThemeId =
    settings.activeCustomThemeId !== null && !ids.has(settings.activeCustomThemeId)
      ? null
      : settings.activeCustomThemeId;
  return {
    ...settings,
    activeCustomThemeId,
    webhookHeaders: clearLegacyWebhookExample(settings.webhookHeaders, WEBHOOK_HEADERS_PLACEHOLDER),
    webhookPayload: clearLegacyWebhookExample(settings.webhookPayload, WEBHOOK_PAYLOAD_PLACEHOLDER),
  };
}

/** 读取当前用户设置（未登录时返回默认设置）。 */
export function useSettings() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const userId = getCurrentUserId();
      if (!userId) return DEFAULT_SETTINGS;
      const rows = await pb.collection("settings").getFullList<RecordModel>({
        filter: `user = "${userId}"`,
        perPage: 1,
      });
      // PocketBase JSON 字段没有静态保证，读取后必须先 normalize 再进 React Query 缓存。
      return normalizeSettings(rows[0]?.["settings"]);
    },
  });
}

/** 更新当前用户设置（PocketBase settings collection upsert）。 */
export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Partial<AppSettings>) => {
      const userId = getCurrentUserId();
      if (!userId) throw new Error(translate(getApiLocale(), "auth.loginRequired"));
      const current = queryClient.getQueryData<AppSettings>(["settings"]) ?? DEFAULT_SETTINGS;
      const next = normalizeSettings({ ...current, ...patch });
      // 保存前再次 normalize，确保 UI 临时状态、历史占位示例和 partial patch 都不会绕过 schema。
      const rows = await pb.collection("settings").getFullList<RecordModel>({
        filter: `user = "${userId}"`,
        perPage: 1,
      });
      if (rows[0]) {
        await pb.collection("settings").update(rows[0].id, { settings: next });
      } else {
        await pb.collection("settings").create({ user: userId, settings: next });
      }
      return next;
    },
    onSuccess: (settings) => {
      queryClient.setQueryData(["settings"], settings);
    },
  });
}
