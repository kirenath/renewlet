import type { CustomThemeColor, ThemeMode, ThemeVariant } from './theme';
import { DEFAULT_CUSTOM_THEME_COLOR } from './theme';
import { getInitialLocale, labels, type Locale, type LocalizedLabels } from '@/i18n/locales';
import type { ExchangeRateProvider } from '@/lib/api/schemas/exchange-rates';
import type { DateOnly } from '@/lib/time/date-only';
import type { LocalTime } from '@/lib/time/local-time';

/**
 * 订阅与设置领域模型。
 *
 * 架构位置：
 * - 这里定义前端 domain 层的稳定类型，API/PocketBase 响应必须先经过 schema/hook 边界再转换进来。
 * - 页面、统计、日历、通知配置和表单都依赖这些联合类型与品牌类型表达业务不变量。
 *
 * Caveat: 不要把 API row 类型直接导出给 UI 使用；否则 date-only、本地时间和 custom 周期约束会被绕过。
 */

export const SUBSCRIPTION_STATUSES = ['trial', 'active', 'paused', 'cancelled'] as const;
/** 订阅状态（影响展示、统计与提醒逻辑）。 */
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const BILLING_CYCLES = ['weekly', 'monthly', 'quarterly', 'semi-annual', 'annual', 'custom'] as const;
/** 扣费周期（用于计算月度/年度支出与续费日期）。 */
export type BillingCycle = (typeof BILLING_CYCLES)[number];

export const CATEGORIES = [
  'productivity',
  'entertainment',
  'lifestyle',
  'finance',
  'streaming',
  'music',
  'gaming',
  'utilities',
  'cloud_storage',
  'education',
  'health_fitness',
  'food_dining',
  'shopping',
  'travel',
  'business',
  'communication',
  'developer_tools',
  'design',
  'ai_tools',
  'security_vpn',
  'hosting_domains',
  'news_media',
  'other',
] as const;
/** 内置订阅分类（用于默认选项 + 视觉 token）。 */
export type BuiltInCategory = (typeof CATEGORIES)[number];
/**
 * 订阅分类值。
 *
 * 说明：
 * - `BuiltInCategory`：内置分类（有默认颜色 token）
 * - `(string & {})`：用户自定义分类（来自「设置 → 分类管理」）
 */
export type Category = BuiltInCategory | (string & {});

export const PAYMENT_METHODS = [
  'alipay',
  'wechat',
  'credit_card',
  'debit_card',
  'paypal',
  'apple_pay',
  'google_pay',
  'bank_transfer',
  'crypto',
  'other',
] as const;
/** 内置支付方式（默认 10 个，图标固定）。 */
export type BuiltInPaymentMethod = (typeof PAYMENT_METHODS)[number];
/**
 * 支付方式值。
 *
 * 说明：
 * - `BuiltInPaymentMethod`：内置支付方式（图标固定）
 * - `(string & {})`：用户自定义支付方式（来自「设置 → 支付方式管理」）
 */
export type PaymentMethod = BuiltInPaymentMethod | (string & {});

export const NOTIFICATION_CHANNELS = ['telegram', 'notifyx', 'webhook', 'wechat', 'email', 'bark'] as const;
/** 通知渠道（用于配置页选择 + 后续通知任务）。 */
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const WEBHOOK_HEADERS_PLACEHOLDER = '{"Authorization": "Bearer your-token", "Content-Type": "application/json"}';
export const WEBHOOK_PAYLOAD_PLACEHOLDER = '{"title": "{title}", "content": "{content}", "timestamp": "{timestamp}"}';

interface SubscriptionBase {
  /** 订阅 ID（客户端使用字符串；数据库中为 UUID）。 */
  id: string;
  /** 订阅名称。 */
  name: string;
  /** Logo（可选）。 */
  logo: string | undefined;
  /** 单次扣费金额。 */
  price: number;
  /** 货币代码（如：CNY、USD）。 */
  currency: string;
  /** 分类。 */
  category: Category;
  /** 状态。 */
  status: SubscriptionStatus;
  /** 支付方式（可选）。 */
  paymentMethod: PaymentMethod | undefined;
  /** 下次扣费日期（用于提醒与日历）。 */
  nextBillingDate: DateOnly;
  /** 是否自动根据开始日期和扣费周期计算下次扣费日期。 */
  autoCalculateNextBillingDate: boolean;
  /** 开始日期。 */
  startDate: DateOnly;
  /** 试用结束日期（仅试用状态可选）。 */
  trialEndDate: DateOnly | undefined;
  /** 官网地址（可选）。 */
  website: string | undefined;
  /** 备注（可选）。 */
  notes: string | undefined;
  /** 标签。 */
  tags: string[];
  /** 提前多少天提醒（整数，>=0）。 */
  reminderDays: number;
}

export interface CustomCycleSubscription extends SubscriptionBase {
  /** 自定义周期必须携带自定义天数；统计折算和自动续费日期计算都依赖这个不变量。 */
  billingCycle: "custom";
  customDays: number;
}

export interface FixedCycleSubscription extends SubscriptionBase {
  /** 固定周期不携带自定义天数，避免历史 customDays 脏值影响金额折算。 */
  billingCycle: Exclude<BillingCycle, "custom">;
  customDays: undefined;
}

export type Subscription = CustomCycleSubscription | FixedCycleSubscription;
export type SubscriptionDraft = Omit<CustomCycleSubscription, "id"> | Omit<FixedCycleSubscription, "id">;

export interface SubscriptionStats {
  /** 按月折算的总支出（基于订阅周期换算）。 */
  totalMonthly: number;
  /** 按年折算的总支出（基于订阅周期换算）。 */
  totalAnnual: number;
  /** 当前处于活跃状态的订阅数量。 */
  activeCount: number;
  /** 即将续费的订阅数量（时间窗口由 UI 逻辑决定）。 */
  upcomingRenewals: number;
  /** 试用即将结束的订阅数量（时间窗口由 UI 逻辑决定）。 */
  trialEndingSoon: number;
}

/**
 * 自定义 CSS 主题记录。
 *
 * 来源：自定义 CSS 主题特性（custom-css-themes spec）。一条主题等价于一段用户保存的 CSS 文本，
 * 由客户端注入到 `<head>` 内的 `<style data-renewlet-custom-theme>` 标签生效。
 *
 * 字段约束（Settings_Schema 与 domain 层会进一步收紧）：
 * - `id`：非空字符串（生成时使用 RFC 4122 v4 UUID）。
 * - `name`：trim 后长度在 [1, THEME_NAME_LIMIT] 之间。
 * - `css`：UTF-8 编码后字节长度不超过 CSS_SIZE_LIMIT；不做任何消毒。
 * - `createdAt` / `updatedAt`：ISO 8601 UTC 时间字符串（结尾 `Z`）。
 */
export interface CustomCssTheme {
  id: string;
  name: string;
  css: string;
  createdAt: string;
  updatedAt: string;
}

/** 单条主题 `css` 字段的最大字节长度（UTF-8 编码后），即 100 KiB。 */
export const CSS_SIZE_LIMIT = 102_400;
/** Custom_Theme_Collection 中主题条目的最大数量。 */
export const THEME_COUNT_LIMIT = 20;
/** 单条主题 `name` 字段在 trim() 后的最大长度。 */
export const THEME_NAME_LIMIT = 80;
/** 主题导出 / 导入 JSON 文档的协议版本号。 */
export const THEME_EXPORT_VERSION = 1;

export interface AppSettings {
  // Admin
  /** 管理员用户名（用于界面展示/未来扩展）。 */
  adminUsername: string;
  
  // Display
  /** 明暗模式（light/dark/system，对应本地 ThemeProvider）。 */
  themeMode: ThemeMode;
  /** 主题风格（emerald/ocean/...，对应 html[data-theme]）。 */
  themeVariant: ThemeVariant;
  /** 自定义主题色（仅 themeVariant=custom 时生效）。 */
  themeCustomColor: CustomThemeColor;
  /** 界面、错误和通知使用的语言。 */
  locale: Locale;
  /** 通知内容中是否包含已过期订阅。 */
  showExpired: boolean;
  /** 默认货币（用于统计/展示换算）。 */
  defaultCurrency: string;
  /** 首选汇率来源；另一个远端来源仍作为兜底。 */
  exchangeRateProvider: ExchangeRateProvider;
  
  // Budget
  /** 月度预算（用于统计页预算占比）。 */
  monthlyBudget: number;
  
  // Timezone
  /** 用户时区（用于后续定时任务/通知展示）。 */
  timezone: string;
  
  // Notification
  /** 每天发送通知的本地墙上时间（格式 HH:mm，需结合 timezone 解释）。 */
  notificationTimeLocal: LocalTime;
  /** 启用的通知渠道（可多选）。 */
  enabledChannels: NotificationChannel[];
  /** 第三方 API 测试号码（部分渠道测试用）。 */
  testPhone: string;
  
  // Telegram
  /** Telegram Bot Token。 */
  telegramBotToken: string;
  /** Telegram Chat ID。 */
  telegramChatId: string;
  
  // Notifyx
  /** Notifyx API Key。 */
  notifyxApiKey: string;
  
  // Webhook
  /** Webhook URL。 */
  webhookUrl: string;
  /** Webhook 请求方法。 */
  webhookMethod: 'GET' | 'POST';
  /** Webhook Headers（JSON 字符串）。 */
  webhookHeaders: string;
  /** Webhook Payload（模板字符串/JSON 字符串）。 */
  webhookPayload: string;
  
  // WeChat Work
  /** 企业微信机器人 Webhook URL。 */
  wechatWebhookUrl: string;
  /** 企业微信消息类型。 */
  wechatMessageType: 'text' | 'markdown';
  /** 企业微信消息是否追加模式标签。 */
  wechatAddModeTag: boolean;
  /** 企业微信 @ 手机号（逗号分隔）。 */
  wechatAtPhones: string;
  /** 企业微信是否 @ 全体。 */
  wechatAtAll: boolean;
  
  // Email (SMTP)
  /** SMTP 服务器地址。 */
  smtpHost: string;
  /** SMTP 端口。 */
  smtpPort: string;
  /** SMTP 是否使用 TLS 直连。 */
  smtpSecure: boolean;
  /** SMTP 用户名。 */
  smtpUser: string;
  /** SMTP 密码。 */
  smtpPassword: string;
  /** SMTP 发件人。 */
  smtpFrom: string;
  /** SMTP 回复地址。 */
  smtpReplyTo: string;
  /** 是否支持多收件人。 */
  notifyMultipleAddresses: boolean;
  /** 收件人邮箱。 */
  recipientEmail: string;
  
  // Bark
  /** Bark 服务器地址。 */
  barkServerUrl: string;
  /** Bark 设备 Key。 */
  barkDeviceKey: string;
  /** Bark 是否静音推送。 */
  barkSilentPush: boolean;

  // Custom CSS Themes
  /** 用户保存的自定义 CSS 主题列表。数量上限由 THEME_COUNT_LIMIT 控制。 */
  customThemes: CustomCssTheme[];
  /** 当前激活的主题 id，必须等于 customThemes 中某条记录的 id；为 null 表示未激活任何自定义主题。 */
  activeCustomThemeId: string | null;
  /** 自定义 CSS 主题的全局总闸；为 false 时即使 activeCustomThemeId 非空也不注入。 */
  customThemesEnabled: boolean;
}

export const CATEGORY_LABELS: Record<BuiltInCategory, LocalizedLabels> = {
  productivity: labels('生产力', 'Productivity'),
  entertainment: labels('娱乐', 'Entertainment'),
  lifestyle: labels('生活', 'Lifestyle'),
  finance: labels('理财', 'Finance'),
  streaming: labels('影音流媒体', 'Streaming'),
  music: labels('音乐', 'Music'),
  gaming: labels('游戏', 'Gaming'),
  utilities: labels('公用事业', 'Utilities'),
  cloud_storage: labels('云存储', 'Cloud Storage'),
  education: labels('教育', 'Education'),
  health_fitness: labels('健康健身', 'Health & Fitness'),
  food_dining: labels('餐饮', 'Food & Dining'),
  shopping: labels('购物', 'Shopping'),
  travel: labels('旅行出行', 'Travel'),
  business: labels('商务', 'Business'),
  communication: labels('通讯与邮件', 'Communication & Email'),
  developer_tools: labels('开发工具', 'Developer Tools'),
  design: labels('设计创意', 'Design'),
  ai_tools: labels('AI 工具', 'AI Tools'),
  security_vpn: labels('安全与 VPN', 'Security & VPN'),
  hosting_domains: labels('域名与托管', 'Domains & Hosting'),
  news_media: labels('新闻媒体', 'News & Media'),
  other: labels('其他', 'Other'),
};

export const STATUS_LABELS: Record<SubscriptionStatus, LocalizedLabels> = {
  trial: labels('试用中', 'Trial'),
  active: labels('活跃', 'Active'),
  paused: labels('已暂停', 'Paused'),
  cancelled: labels('已取消', 'Cancelled'),
};

export const CYCLE_LABELS: Record<BillingCycle, LocalizedLabels> = {
  weekly: labels('每周', 'Weekly'),
  monthly: labels('每月', 'Monthly'),
  quarterly: labels('每季', 'Quarterly'),
  'semi-annual': labels('每半年', 'Semiannual'),
  annual: labels('每年', 'Annual'),
  custom: labels('自定义', 'Custom'),
};

export const CHANNEL_LABELS: Record<NotificationChannel, LocalizedLabels> = {
  telegram: labels('Telegram', 'Telegram'),
  notifyx: labels('Notifyx', 'Notifyx'),
  webhook: labels('Webhook 通知', 'Webhook'),
  wechat: labels('企业微信机器人', 'WeCom Bot'),
  email: labels('邮件通知', 'Email'),
  bark: labels('Bark', 'Bark'),
};

export const PAYMENT_METHOD_LABELS: Record<BuiltInPaymentMethod, LocalizedLabels> = {
  alipay: labels('支付宝', 'Alipay'),
  wechat: labels('微信支付', 'WeChat Pay'),
  credit_card: labels('信用卡', 'Credit card'),
  debit_card: labels('借记卡', 'Debit card'),
  paypal: labels('PayPal', 'PayPal'),
  apple_pay: labels('Apple Pay', 'Apple Pay'),
  google_pay: labels('Google Pay', 'Google Pay'),
  bank_transfer: labels('银行转账', 'Bank transfer'),
  crypto: labels('加密货币', 'Crypto'),
  other: labels('其他', 'Other'),
};

/** 货币选项所属地区（仅用于 UI 分组展示）。 */
export type CurrencyRegion = 'asia' | 'europe' | 'americas' | 'oceania' | 'africa';

/** 货币下拉选项（用于新增/编辑订阅，以及自定义货币配置）。 */
export interface CurrencyOption {
  /** 货币代码（ISO 4217），例如：CNY、USD。 */
  value: string;
  /** UI 展示文案（可包含货币符号）。 */
  labels: LocalizedLabels;
  /** 地区分组（用于 UI 分组/排序展示）。 */
  region: CurrencyRegion;
}

/** 时区下拉选项（用于设置页选择）。 */
export interface TimezoneOption {
  /** IANA 时区名，例如：Asia/Shanghai。 */
  value: string;
  /** UI 展示文案（通常包含 UTC 偏移）。 */
  label: string;
}

/** 提醒天数下拉选项（用于新增/编辑订阅）。 */
export interface ReminderDaysOption {
  /** 提前多少天提醒（整数）。 */
  value: number;
  /** UI 展示文案。 */
  labels: LocalizedLabels;
}

/** 汇率来源共同支持的 30 种货币（用于默认列表与下拉选项）。 */
export const CURRENCY_OPTIONS = [
  // 🌏 亚洲 (10个)
  { value: 'CNY', labels: labels('人民币 (¥)', 'Chinese yuan (¥)'), region: 'asia' },
  { value: 'HKD', labels: labels('港币 (HK$)', 'Hong Kong dollar (HK$)'), region: 'asia' },
  { value: 'JPY', labels: labels('日元 (¥)', 'Japanese yen (¥)'), region: 'asia' },
  { value: 'KRW', labels: labels('韩元 (₩)', 'South Korean won (₩)'), region: 'asia' },
  { value: 'SGD', labels: labels('新加坡元 (S$)', 'Singapore dollar (S$)'), region: 'asia' },
  { value: 'INR', labels: labels('印度卢比 (₹)', 'Indian rupee (₹)'), region: 'asia' },
  { value: 'IDR', labels: labels('印尼卢比 (Rp)', 'Indonesian rupiah (Rp)'), region: 'asia' },
  { value: 'MYR', labels: labels('马来西亚林吉特 (RM)', 'Malaysian ringgit (RM)'), region: 'asia' },
  { value: 'THB', labels: labels('泰铢 (฿)', 'Thai baht (฿)'), region: 'asia' },
  { value: 'PHP', labels: labels('菲律宾比索 (₱)', 'Philippine peso (₱)'), region: 'asia' },
  // 🇪🇺 欧洲 (13个)
  { value: 'EUR', labels: labels('欧元 (€)', 'Euro (€)'), region: 'europe' },
  { value: 'GBP', labels: labels('英镑 (£)', 'British pound (£)'), region: 'europe' },
  { value: 'CHF', labels: labels('瑞士法郎 (CHF)', 'Swiss franc (CHF)'), region: 'europe' },
  { value: 'SEK', labels: labels('瑞典克朗 (kr)', 'Swedish krona (kr)'), region: 'europe' },
  { value: 'NOK', labels: labels('挪威克朗 (kr)', 'Norwegian krone (kr)'), region: 'europe' },
  { value: 'DKK', labels: labels('丹麦克朗 (kr)', 'Danish krone (kr)'), region: 'europe' },
  { value: 'PLN', labels: labels('波兰兹罗提 (zł)', 'Polish zloty (zł)'), region: 'europe' },
  { value: 'CZK', labels: labels('捷克克朗 (Kč)', 'Czech koruna (Kč)'), region: 'europe' },
  { value: 'HUF', labels: labels('匈牙利福林 (Ft)', 'Hungarian forint (Ft)'), region: 'europe' },
  { value: 'RON', labels: labels('罗马尼亚列伊 (lei)', 'Romanian leu (lei)'), region: 'europe' },
  { value: 'ISK', labels: labels('冰岛克朗 (kr)', 'Icelandic krona (kr)'), region: 'europe' },
  { value: 'TRY', labels: labels('土耳其里拉 (₺)', 'Turkish lira (₺)'), region: 'europe' },
  { value: 'ILS', labels: labels('以色列谢克尔 (₪)', 'Israeli new shekel (₪)'), region: 'europe' },
  // 🌎 美洲 (4个)
  { value: 'USD', labels: labels('美元 ($)', 'US dollar ($)'), region: 'americas' },
  { value: 'CAD', labels: labels('加元 (C$)', 'Canadian dollar (C$)'), region: 'americas' },
  { value: 'MXN', labels: labels('墨西哥比索 (MX$)', 'Mexican peso (MX$)'), region: 'americas' },
  { value: 'BRL', labels: labels('巴西雷亚尔 (R$)', 'Brazilian real (R$)'), region: 'americas' },
  // 🇦🇺 大洋洲 (2个)
  { value: 'AUD', labels: labels('澳元 (A$)', 'Australian dollar (A$)'), region: 'oceania' },
  { value: 'NZD', labels: labels('新西兰元 (NZ$)', 'New Zealand dollar (NZ$)'), region: 'oceania' },
  // 🌍 非洲 (1个)
  { value: 'ZAR', labels: labels('南非兰特 (R)', 'South African rand (R)'), region: 'africa' },
] as const satisfies readonly CurrencyOption[];

export const TIMEZONE_OPTIONS = [
  { value: 'UTC', label: 'UTC' },
  { value: 'Asia/Shanghai', label: 'Asia/Shanghai' },
  { value: 'Asia/Tokyo', label: 'Asia/Tokyo' },
  { value: 'Asia/Singapore', label: 'Asia/Singapore' },
  { value: 'Asia/Kolkata', label: 'Asia/Kolkata' },
  { value: 'America/New_York', label: 'America/New_York' },
  { value: 'America/Chicago', label: 'America/Chicago' },
  { value: 'America/Denver', label: 'America/Denver' },
  { value: 'America/Los_Angeles', label: 'America/Los_Angeles' },
  { value: 'Europe/London', label: 'Europe/London' },
  { value: 'Europe/Paris', label: 'Europe/Paris' },
  { value: 'Europe/Berlin', label: 'Europe/Berlin' },
  { value: 'Pacific/Honolulu', label: 'Pacific/Honolulu' },
  { value: 'Pacific/Auckland', label: 'Pacific/Auckland' },
  { value: 'Pacific/Kiritimati', label: 'Pacific/Kiritimati' },
] as const satisfies readonly TimezoneOption[];

export const REMINDER_DAYS_OPTIONS = [
  { value: 1, labels: labels('提前 1 天', '1 day before') },
  { value: 3, labels: labels('提前 3 天', '3 days before') },
  { value: 7, labels: labels('提前 7 天', '7 days before') },
  { value: 14, labels: labels('提前 14 天', '14 days before') },
  { value: 30, labels: labels('提前 30 天', '30 days before') },
] as const satisfies readonly ReminderDaysOption[];

export const DEFAULT_SETTINGS: AppSettings = {
  adminUsername: 'admin',
  themeMode: 'dark',
  themeVariant: 'emerald',
  themeCustomColor: DEFAULT_CUSTOM_THEME_COLOR,
  locale: getInitialLocale(),
  showExpired: true,
  defaultCurrency: 'CNY',
  exchangeRateProvider: 'floatrates',
  monthlyBudget: 1500,
  timezone: 'UTC',
  notificationTimeLocal: '08:00' as LocalTime,
  enabledChannels: [],
  testPhone: '',
  telegramBotToken: '',
  telegramChatId: '',
  notifyxApiKey: '',
  webhookUrl: '',
  webhookMethod: 'POST',
  webhookHeaders: '',
  webhookPayload: '',
  wechatWebhookUrl: '',
  wechatMessageType: 'text',
  wechatAddModeTag: false,
  wechatAtPhones: '',
  wechatAtAll: false,
  smtpHost: '',
  smtpPort: '',
  smtpSecure: false,
  smtpUser: '',
  smtpPassword: '',
  smtpFrom: '',
  smtpReplyTo: '',
  notifyMultipleAddresses: false,
  recipientEmail: '',
  barkServerUrl: 'https://api.day.app',
  barkDeviceKey: '',
  barkSilentPush: false,
  customThemes: [],
  activeCustomThemeId: null,
  customThemesEnabled: true,
};
