/**
 * 用户设置 API 的 Zod 契约。
 *
 * 架构位置：
 * - Settings 页提交的表单最终会通过该 schema 进入 `user_settings.settings` JSON 字段。
 * - 通知测试/手动运行也复用 partial schema，允许“未保存设置临时生效”。
 *
 * Caveat: 这里的字段必须与 `DEFAULT_SETTINGS` 保持同步；新增设置时若只改 UI，会在保存时被丢弃。
 */
import { z } from "zod";
import {
  CSS_SIZE_LIMIT,
  NOTIFICATION_CHANNELS,
  THEME_COUNT_LIMIT,
  THEME_NAME_LIMIT,
  type AppSettings,
} from "@/types/subscription";
import { exchangeRateProviderSchema } from "@/lib/api/schemas/exchange-rates";
import { THEME_MODES, THEME_VARIANTS } from "@/types/theme";
import { SUPPORTED_LOCALES } from "@/i18n/locales";
import { isValidLocalTime, type LocalTime } from "@/lib/time/local-time";
import { isValidTimeZone } from "@/lib/time/time-zone";

// 通知调度按“用户本地墙上时间”执行，因此保存 HH:mm 而不是 UTC instant。
const hhmmSchema = z.string().refine(isValidLocalTime, "时间格式必须为 HH:mm").transform((value) => value as LocalTime);

// 通知 Webhook 只允许 HTTPS,避免设置页成为明文凭据外泄入口。
const optionalHttpsUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    if (!value) return true;
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }, "必须为空或 https:// URL");

const optionalEmailSchema = z
  .string()
  .trim()
  .max(254)
  .refine((value) => !value || z.email().safeParse(value).success, "邮箱格式无效");

const optionalSmtpPortSchema = z
  .string()
  .trim()
  .max(5)
  .refine((value) => {
    if (!value) return true;
    const port = Number.parseInt(value, 10);
    return Number.isInteger(port) && port > 0 && port <= 65_535 && String(port) === value;
  }, "SMTP 端口无效");

// 使用 IANA timezone 而不是固定 offset；DST/地区政策变化由 Intl 负责解释。
const timezoneSchema = z.string().trim().min(1).max(80).refine(isValidTimeZone, "时区无效");

// ISO 8601 UTC 字符串（结尾必须为 `Z`），用于自定义主题的时间戳字段。
const isoUtcDateTimeSchema = z
  .string()
  .refine(
    (value) => /T.*Z$/.test(value) && !Number.isNaN(Date.parse(value)),
    "时间必须为 ISO 8601 UTC 字符串（以 Z 结尾）",
  );

/**
 * 单条自定义 CSS 主题 Zod 契约。
 *
 * 字段约束：
 * - `id`：非空字符串（≤ 64），客户端用 RFC 4122 v4 UUID 生成。
 * - `name`：长度 [1, THEME_NAME_LIMIT]，存储前已 trim()。
 * - `css`：先以字符长度粗筛（≤ CSS_SIZE_LIMIT * 4）防御对大字符串跑 TextEncoder 的攻击，
 *   再以 UTF-8 编码精确校验 ≤ CSS_SIZE_LIMIT 字节。
 * - `createdAt` / `updatedAt`：ISO 8601 UTC（结尾 `Z`）字符串。
 *
 * 不做任何消毒；自定义 CSS 视为与登录使用者同等可信（参见 Requirement 13）。
 */
export const customCssThemeSchema = z
  .object({
    id: z.string().min(1).max(64).describe("自定义主题 id（UUID）。"),
    name: z.string().min(1).max(THEME_NAME_LIMIT).describe("显示名称。"),
    css: z
      .string()
      .max(CSS_SIZE_LIMIT * 4, `CSS 字符长度过大`)
      .refine(
        (value) => new TextEncoder().encode(value).length <= CSS_SIZE_LIMIT,
        `CSS 字节长度不得超过 ${CSS_SIZE_LIMIT}`,
      )
      .describe("原始 CSS 文本。"),
    createdAt: isoUtcDateTimeSchema.describe("创建时间（ISO 8601 UTC）。"),
    updatedAt: isoUtcDateTimeSchema.describe("最后修改时间（ISO 8601 UTC）。"),
  })
  .strict();

/**
 * 用户设置基础对象（不含 superRefine）。
 *
 * 单独提取以便同时构建：
 * - `appSettingsSchema`：完整对象 + 引用完整性 superRefine。
 * - `settingsUpdateBodySchema`：partial 后再追加宽容版 superRefine（任一字段缺失则跳过）。
 *
 * Caveat: zod 4 中 `.partial()` 不允许作用在已带 refinements 的 schema 上，
 * 所以两条路径必须共享同一个未 refine 的基础对象。
 */
const appSettingsBaseObject = z
  .object({
    adminUsername: z.string().trim().min(1).max(80).describe("管理员用户名。"),

    themeMode: z.enum(THEME_MODES).describe("明暗模式（light/dark/system，对应本地 ThemeProvider）。"),
    themeVariant: z.enum(THEME_VARIANTS).describe("主题风格（对应 html[data-theme]）。"),
    themeCustomColor: z
      .object({
        h: z.number().min(0).max(360).describe("Hue：色相（0-360）。"),
        s: z.number().min(0).max(100).describe("Saturation：饱和度（0-100）。"),
        l: z.number().min(0).max(100).describe("Lightness：亮度（0-100）。"),
      })
      .describe("自定义主题色（HSL，仅 themeVariant=custom 时用于覆盖主色系）。"),
    locale: z.enum(SUPPORTED_LOCALES).describe("界面、错误和通知语言。"),

    showExpired: z.boolean().describe("通知中是否包含已过期订阅。"),
    defaultCurrency: z.string().trim().regex(/^[A-Z]{3}$/).describe("默认货币代码（用于统计/展示换算）。"),
    exchangeRateProvider: exchangeRateProviderSchema.describe("首选汇率来源。"),

    monthlyBudget: z.number().finite().nonnegative().max(1_000_000_000).describe("月度预算（用于统计页预算占比）。"),

    timezone: timezoneSchema.describe("用户时区（如 Asia/Shanghai）。"),

    notificationTimeLocal: hhmmSchema.describe("通知时间（用户本地时间，格式 HH:mm）。"),
    enabledChannels: z
      .array(z.enum(NOTIFICATION_CHANNELS))
      .describe("启用的通知渠道列表。"),
    testPhone: z.string().trim().max(80).describe("第三方 API 测试号码。"),

    telegramBotToken: z.string().trim().max(256).describe("Telegram Bot Token。"),
    telegramChatId: z.string().trim().max(128).describe("Telegram Chat ID。"),

    notifyxApiKey: z.string().trim().max(256).describe("Notifyx API Key。"),

    webhookUrl: optionalHttpsUrlSchema.describe("Webhook URL。"),
    webhookMethod: z.enum(["GET", "POST"]).describe("Webhook 请求方法。"),
    webhookHeaders: z.string().max(20_000).describe("Webhook Headers（JSON 字符串）。"),
    webhookPayload: z.string().max(100_000).describe("Webhook Payload（模板/JSON 字符串）。"),

    wechatWebhookUrl: optionalHttpsUrlSchema.describe("企业微信机器人 Webhook URL。"),
    wechatMessageType: z.enum(["text", "markdown"]).describe("企业微信消息类型。"),
    wechatAddModeTag: z.boolean().describe("企业微信消息是否追加模式标签。"),
    wechatAtPhones: z.string().trim().max(1000).describe("企业微信 @ 手机号（逗号分隔）。"),
    wechatAtAll: z.boolean().describe("企业微信是否 @ 全体。"),

    smtpHost: z.string().trim().max(255).describe("SMTP 服务器地址。"),
    smtpPort: optionalSmtpPortSchema.describe("SMTP 端口。"),
    smtpSecure: z.boolean().describe("SMTP 是否使用 TLS 直连。"),
    smtpUser: z.string().trim().max(256).describe("SMTP 用户名。"),
    smtpPassword: z.string().trim().max(512).describe("SMTP 密码。"),
    smtpFrom: z.string().trim().max(320).describe("SMTP 发件人。"),
    smtpReplyTo: z.string().trim().max(320).describe("SMTP 回复地址。"),
    notifyMultipleAddresses: z.boolean().describe("是否支持多收件人。"),
    recipientEmail: z
      .string()
      .trim()
      .max(2000)
      .refine((value) => {
        if (!value) return true;
        return value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
          .every((item) => z.email().safeParse(item).success);
      }, "收件人邮箱格式无效")
      .describe("收件人邮箱。"),

    barkServerUrl: optionalHttpsUrlSchema.describe("Bark 服务器地址。"),
    barkDeviceKey: z.string().trim().max(256).describe("Bark 设备 Key。"),
    barkSilentPush: z.boolean().describe("Bark 是否静音推送。"),

    customThemes: z
      .array(customCssThemeSchema)
      .max(THEME_COUNT_LIMIT, `自定义主题数量不得超过 ${THEME_COUNT_LIMIT}`)
      .describe("自定义 CSS 主题集合。"),
    activeCustomThemeId: z
      .string()
      .min(1)
      .max(64)
      .nullable()
      .describe("当前激活自定义主题 id；null 表示未激活。"),
    customThemesEnabled: z.boolean().describe("自定义 CSS 总闸；false 时即使有激活主题也不注入。"),
  })
  .strict();

/**
 * 用户设置（保存到 `public.user_settings.settings`）。
 *
 * 说明：
 * - 后端会将该对象作为 JSONB 直接存储，便于后续灵活扩展
 * - PUT 支持部分字段更新，服务端会与默认值合并
 * - `superRefine`：当 `activeCustomThemeId !== null` 时，必须引用 `customThemes` 中已存在的主题 id。
 */
export const appSettingsSchema = appSettingsBaseObject.superRefine((value, ctx) => {
  if (value.activeCustomThemeId == null) return;
  const ids = new Set(value.customThemes.map((theme) => theme.id));
  if (!ids.has(value.activeCustomThemeId)) {
    ctx.addIssue({
      code: "custom",
      path: ["activeCustomThemeId"],
      message: "activeCustomThemeId 必须引用 customThemes 中已存在的主题 id",
    });
  }
}) satisfies z.ZodType<AppSettings>;

/** 设置读取响应结构。 */
export const settingsResponseSchema = z.object({
  settings: appSettingsSchema.describe("用户设置对象。"),
}).strict();

/**
 * 设置更新请求体：支持部分字段更新。
 *
 * `superRefine`：仅在 `customThemes` 与 `activeCustomThemeId` 两者都被显式提供时
 * 才做引用完整性校验，避免误拒只改其中一个字段的合法 PATCH。
 */
export const settingsUpdateBodySchema = appSettingsBaseObject
  .partial()
  .superRefine((value, ctx) => {
    if (value.activeCustomThemeId === undefined || value.customThemes === undefined) return;
    if (value.activeCustomThemeId === null) return;
    const ids = new Set(value.customThemes.map((theme) => theme.id));
    if (!ids.has(value.activeCustomThemeId)) {
      ctx.addIssue({
        code: "custom",
        path: ["activeCustomThemeId"],
        message: "activeCustomThemeId 必须引用 customThemes 中已存在的主题 id",
      });
    }
  })
  .describe("支持部分字段更新。");
