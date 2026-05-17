/**
 * Settings application controller。
 *
 * 架构位置：
 * - presentation 只渲染 `SettingsScreen`，所有副作用都在这里收敛。
 * - domain 只提供纯规则（分类使用计数、货币启用策略），避免框架依赖进入业务规则。
 *
 * 关键依赖：
 * - React Query hooks：读取/保存 settings、subscriptions、自定义配置。
 * - 本地 ThemeProvider + theme-storage：处理“立即预览但稍后保存”的外观状态。
 * - toast/api hooks：把网络错误转成用户可理解的反馈。
 *
 * 状态流转：
 * ```
 * 远端 settings -> 首次初始化本地表单
 *              -> 若本地外观有 pending，则外观字段以 localStorage 为准
 * 用户编辑表单 -> draft state
 *              -> 保存更改 -> API -> React Query 缓存 + saved snapshot
 * ```
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "@/lib/theme-provider";
import { useCustomConfig } from "@/contexts/CustomConfigContext";
import { useExchangeRates } from "@/hooks/use-exchange-rates";
import { useSettings, useUpdateSettings } from "@/hooks/use-settings";
import { useSubscriptions } from "@/hooks/use-subscriptions";
import { usePasswordResetAvailability } from "@/hooks/use-password-reset-availability";
import { useToast } from "@/hooks/use-toast";
import { getDisplayErrorMessage } from "@/lib/display-error";
import { applyThemeVariant } from "@/lib/theme-variant";
import {
  readAppearancePendingFromStorage,
  readCustomThemeColorFromStorageOrNull,
  readThemeVariantFromStorage,
  writeAppearancePendingToStorage,
  writeCustomThemeColorToStorage,
  writeThemeVariantToStorage,
} from "@/lib/theme-storage";
import type { ExchangeRateProvider, ExchangeRates } from "@/lib/api/schemas/exchange-rates";
import { DEFAULT_SETTINGS, type AppSettings, type NotificationChannel, type Subscription } from "@/types/subscription";
import { normalizePaymentMethods, type ConfigItem, type CustomConfig } from "@/types/config";
import type { CustomThemeColor, ThemeMode, ThemeVariant } from "@/types/theme";
import { parseNonNegativeFiniteNumberInput } from "@/lib/subscription-form";
import { normalizeCustomConfig } from "@/modules/custom-config/domain/normalize-custom-config";
import { countSubscriptionsByCategory } from "../domain/category-usage";
import { enforceCurrencyConfigPolicy } from "../domain/currency-config-policy";
import { useAccountIdentity } from "./use-account-email";
import { useNotificationTest } from "./use-notification-test";
import { usePasswordChange, type PasswordChangeController } from "./use-password-change";
import {
  useNotificationHistory,
  type NotificationHistoryResponse,
  type NotificationHistoryStatusFilter,
} from "./use-notification-history";
import { useI18n } from "@/i18n/I18nProvider";

type UpdateSetting = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numericField(value: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number") return candidate;
  }
  return null;
}

function stringField(value: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return null;
}

function isPocketBaseUpdateRecord400(error: unknown): boolean {
  if (!isObjectRecord(error)) return false;

  const response = isObjectRecord(error["response"]) ? error["response"] : null;
  const status = numericField(error, ["status", "statusCode"])
    ?? (response ? numericField(response, ["status", "statusCode"]) : null);
  if (status !== 400) return false;

  const message = [
    stringField(error, ["message", "detail", "error"]),
    response ? stringField(response, ["message", "detail", "error"]) : null,
  ].filter(Boolean).join(" ").toLowerCase();

  return message.includes("failed to update record");
}

function getExchangeRateProviderSaveErrorMessage(error: unknown, t: ReturnType<typeof useI18n>["t"]) {
  if (isPocketBaseUpdateRecord400(error)) {
    return t("settings.exchangeRateProviderServerOutdated");
  }
  return getDisplayErrorMessage(error, t("settings.exchangeRateProviderSaveFailed"));
}

function areJsonSnapshotsEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * 自定义 CSS 主题相关字段不并入「保存所有设置」流程：每个动作由
 * `useCustomThemes` controller 立即调用 `useUpdateSettings.mutateAsync`
 * 单独写入（Requirement 9.3 / 12.1）。把它们从草稿快照里剥离，避免：
 *   1) 切换 Master_Switch / 编辑主题让底部保存条变 dirty；
 *   2) 用户点击「保存所有设置」时把表单里 stale 的三字段值覆盖掉
 *      `useCustomThemes` 在另一处刚刚写入的最新状态。
 *
 * 三字段最终随 `mutateAsync` 内部的 `normalizeSettings({ ...current, ...patch })`
 * 从 React Query 缓存的 `current` 中保留下来，无需在这里再回填。
 */
function stripCustomThemeFields(value: AppSettings): Omit<
  AppSettings,
  "customThemes" | "activeCustomThemeId" | "customThemesEnabled"
> {
  const { customThemes: _ct, activeCustomThemeId: _ai, customThemesEnabled: _en, ...rest } = value;
  void _ct;
  void _ai;
  void _en;
  return rest;
}

function createDraftSettingsFromRemote(remoteSettings: AppSettings, themeMode: ThemeMode): AppSettings {
  if (!readAppearancePendingFromStorage()) return remoteSettings;
  const storedVariant = readThemeVariantFromStorage();
  const storedCustomColor = readCustomThemeColorFromStorageOrNull();
  return {
    ...remoteSettings,
    themeMode,
    themeVariant: storedVariant ?? remoteSettings.themeVariant,
    themeCustomColor: storedCustomColor ?? remoteSettings.themeCustomColor,
  };
}

interface SettingsSubscriptionsQuery {
  data: Subscription[] | undefined;
  isPending: boolean;
  status: "pending" | "error" | "success";
}

interface SettingsNotificationHistoryController {
  data: NotificationHistoryResponse | undefined;
  isLoading: boolean;
  isFetching: boolean;
  error: unknown;
  historyStatus: NotificationHistoryStatusFilter;
  setStatus: (status: NotificationHistoryStatusFilter) => void;
  loadMore: () => void;
  refetch: () => void | Promise<unknown>;
}

export interface SettingsFormController {
  settings: AppSettings;
  accountEmail: string | null;
  canAccessPocketBaseAdmin: boolean;
  customConfig: CustomConfig;
  subscriptionsQuery: SettingsSubscriptionsQuery;
  categoryUsageCount: Map<string, number>;
  rates: ExchangeRates;
  activeRateProvider: ExchangeRateProvider | "builtin";
  ratesLoading: boolean;
  lastUpdated: Date | null;
  ratesError: string | null;
  getCurrencySymbol: (currency: string) => string;
  updateCategories: (items: ConfigItem[]) => void;
  updateStatuses: (items: ConfigItem[]) => void;
  updatePaymentMethods: (items: ConfigItem[]) => void;
  updateCurrencies: (items: ConfigItem[]) => void;
  updateSetting: UpdateSetting;
  monthlyBudgetError: string | null;
  handleMonthlyBudgetInputChange: (rawValue: string) => void;
  toggleChannel: (channel: NotificationChannel) => void;
  handleRefreshRates: () => Promise<void>;
  handleUpdateCurrencies: (items: ConfigItem[]) => void;
  hasUnsavedChanges: boolean;
  handleSaveChanges: () => Promise<void>;
  handleDiscardChanges: () => void;
  isSavingSettings: boolean;
  handleDefaultCurrencyChange: (value: string) => void;
  handleExchangeRateProviderChange: (value: ExchangeRateProvider) => void;
  handleThemeModeChange: (value: ThemeMode) => void;
  handleThemeVariantChange: (value: ThemeVariant) => void;
  handleThemeCustomColorChange: (value: CustomThemeColor) => void;
  testingChannel: NotificationChannel | null;
  handleTestConnection: (channel: NotificationChannel) => void | Promise<void>;
  notificationHistory: SettingsNotificationHistoryController;
  password: PasswordChangeController;
  passwordResetEnabled: boolean;
}

/**
 * 集中协调 Settings 页的远端状态、本地编辑态和跨模块用例。
 *
 * Caveat: 这里是 Settings 页的“唯一写入口”。新增设置字段时，要同时检查：
 * settings schema、默认值、API merge 策略，以及是否应该纳入统一保存草稿。
 */
export function useSettingsFormController(): SettingsFormController {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [savedSettings, setSavedSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [customConfig, setCustomConfig] = useState<CustomConfig>(() => normalizeCustomConfig(null));
  const [savedCustomConfig, setSavedCustomConfig] = useState<CustomConfig>(() => normalizeCustomConfig(null));
  const [hasInitializedFromRemote, setHasInitializedFromRemote] = useState(false);
  const [hasInitializedCustomConfig, setHasInitializedCustomConfig] = useState(false);
  const [monthlyBudgetError, setMonthlyBudgetError] = useState<string | null>(null);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const accountIdentity = useAccountIdentity();
  const accountEmail = accountIdentity.email;
  const { data: remoteSettings } = useSettings();
  const subscriptionsQuery = useSubscriptions();
  const updateSettings = useUpdateSettings();
  const { theme, setTheme } = useTheme();
  const { config: persistedCustomConfig, saveConfig } = useCustomConfig();
  const {
    rates,
    activeProvider: activeRateProvider,
    loading: ratesLoading,
    lastUpdated,
    refresh: refreshRates,
    error: ratesError,
    getCurrencySymbol,
  } = useExchangeRates(savedSettings.exchangeRateProvider);
  const { toast } = useToast();
  const { t, setLocale } = useI18n();
  const password = usePasswordChange();
  const passwordResetEnabled = usePasswordResetAvailability();
  const notificationTest = useNotificationTest(settings);
  const notificationHistory = useNotificationHistory();
  const { refetch: refetchNotificationHistory } = notificationHistory;
  const hasAutoFilledRecipientEmailRef = useRef(false);
  const settingsDirtyRef = useRef(false);
  const customConfigDirtyRef = useRef(false);

  const categoryUsageCount = useMemo(
    () => countSubscriptionsByCategory(subscriptionsQuery.data ?? []),
    [subscriptionsQuery.data],
  );

  const settingsDirty = useMemo(
    () => !areJsonSnapshotsEqual(stripCustomThemeFields(settings), stripCustomThemeFields(savedSettings)),
    [settings, savedSettings],
  );
  const customConfigDirty = useMemo(
    () => !areJsonSnapshotsEqual(customConfig, savedCustomConfig),
    [customConfig, savedCustomConfig],
  );
  const hasUnsavedChanges = settingsDirty || customConfigDirty;

  useEffect(() => {
    settingsDirtyRef.current = settingsDirty;
  }, [settingsDirty]);

  useEffect(() => {
    customConfigDirtyRef.current = customConfigDirty;
  }, [customConfigDirty]);

  useEffect(() => {
    // 为什么等待远端初始化后再回填邮箱：避免默认邮箱覆盖数据库里已有的收件人配置。
    if (hasAutoFilledRecipientEmailRef.current) return;
    if (!hasInitializedFromRemote) return;
    const email = (accountEmail ?? "").trim();
    if (!email || !email.includes("@")) return;

    setSettings((prev) => {
      hasAutoFilledRecipientEmailRef.current = true;
      if (prev.recipientEmail.trim()) return prev;
      return { ...prev, recipientEmail: email };
    });
  }, [accountEmail, hasInitializedFromRemote]);

  useEffect(() => {
    if (!remoteSettings) return;
    const nextDraft = createDraftSettingsFromRemote(remoteSettings, theme);
    if (!hasInitializedFromRemote) {
      setSavedSettings(remoteSettings);
      setSettings(nextDraft);
      setHasInitializedFromRemote(true);
      return;
    }

    setSavedSettings(remoteSettings);
    if (!settingsDirtyRef.current) setSettings(nextDraft);
  }, [hasInitializedFromRemote, remoteSettings, theme]);

  useEffect(() => {
    const normalized = normalizeCustomConfig(persistedCustomConfig);
    if (!hasInitializedCustomConfig) {
      setSavedCustomConfig(normalized);
      setCustomConfig(normalized);
      setHasInitializedCustomConfig(true);
      return;
    }

    if (!customConfigDirtyRef.current) {
      setSavedCustomConfig(normalized);
      setCustomConfig(normalized);
    }
  }, [hasInitializedCustomConfig, persistedCustomConfig]);

  useEffect(() => {
    if (theme !== "light" && theme !== "dark" && theme !== "system") return;
    setSettings((prev) => (prev.themeMode === theme ? prev : { ...prev, themeMode: theme }));
  }, [theme]);

  const updateSetting = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleMonthlyBudgetInputChange = useCallback(
    (rawValue: string) => {
      if (rawValue.trim() === "") {
        setMonthlyBudgetError(null);
        updateSetting("monthlyBudget", 0);
        return;
      }

      const parsed = parseNonNegativeFiniteNumberInput(rawValue);
      if (parsed === null) {
        setMonthlyBudgetError(t("settings.budgetInvalid"));
        return;
      }

      setMonthlyBudgetError(null);
      updateSetting("monthlyBudget", parsed);
    },
    [t, updateSetting],
  );

  const toggleChannel = useCallback((channel: NotificationChannel) => {
    setSettings((prev) => ({
      ...prev,
      enabledChannels: prev.enabledChannels.includes(channel)
        ? prev.enabledChannels.filter((c) => c !== channel)
        : [...prev.enabledChannels, channel],
    }));
  }, []);

  const updateCategories = useCallback((items: ConfigItem[]) => {
    setCustomConfig((prev) => ({ ...prev, categories: items }));
  }, []);

  const updateStatuses = useCallback((items: ConfigItem[]) => {
    setCustomConfig((prev) => ({ ...prev, statuses: items }));
  }, []);

  const updatePaymentMethods = useCallback((items: ConfigItem[]) => {
    setCustomConfig((prev) => ({ ...prev, paymentMethods: normalizePaymentMethods(items) }));
  }, []);

  const updateCurrencies = useCallback((items: ConfigItem[]) => {
    setCustomConfig((prev) => ({ ...prev, currencies: items }));
  }, []);

  const handleRefreshRates = useCallback(async () => {
    await refreshRates(savedSettings.exchangeRateProvider);
    toast({
      title: t("settings.ratesUpdated"),
      description: t("settings.ratesUpdatedDescription"),
    });
  }, [refreshRates, savedSettings.exchangeRateProvider, t, toast]);

  const handleUpdateCurrencies = useCallback(
    (items: ConfigItem[]) => {
      // 货币开关会影响新增订阅下拉和全站统计口径，因此策略放在 domain 层统一约束。
      const result = enforceCurrencyConfigPolicy(items, settings.defaultCurrency);
      if (result.ok) {
        updateCurrencies(result.items);
        return;
      }

      toast({
        title: result.reason === "none-enabled"
          ? t("settings.currencyPolicy.noneTitle")
          : t("settings.currencyPolicy.defaultTitle"),
        description: result.reason === "none-enabled"
          ? t("settings.currencyPolicy.noneDescription")
          : t("settings.currencyPolicy.defaultDescription", { currency: settings.defaultCurrency }),
        variant: "destructive",
      });

      if (result.items) updateCurrencies(result.items);
    },
    [settings.defaultCurrency, t, toast, updateCurrencies],
  );

  const syncSavedPreviewState = useCallback(
    (nextSettings: AppSettings) => {
      setTheme(nextSettings.themeMode);
      applyThemeVariant(nextSettings.themeVariant, nextSettings.themeCustomColor);
      writeThemeVariantToStorage(nextSettings.themeVariant);
      writeCustomThemeColorToStorage(nextSettings.themeCustomColor);
      writeAppearancePendingToStorage(false);
      setLocale(nextSettings.locale, { persist: false, markAsSaved: true });
    },
    [setLocale, setTheme],
  );

  const handleSaveChanges = useCallback(async () => {
    if (isSavingSettings || !hasUnsavedChanges) return;
    if (monthlyBudgetError) {
      toast({
        title: t("settings.saveFailed"),
        description: monthlyBudgetError,
        variant: "destructive",
      });
      return;
    }

    setIsSavingSettings(true);
    const shouldSaveSettings = settingsDirty;
    const shouldSaveCustomConfig = customConfigDirty;
    const providerChanged = settings.exchangeRateProvider !== savedSettings.exchangeRateProvider;

    try {
      const settingsPromise: Promise<AppSettings | null> = shouldSaveSettings
        ? updateSettings.mutateAsync(stripCustomThemeFields(settings))
        : Promise.resolve(null);
      const customConfigPromise: Promise<CustomConfig | null> = shouldSaveCustomConfig
        ? saveConfig(customConfig)
        : Promise.resolve(null);
      const [settingsResult, customConfigResult] = await Promise.allSettled([
        settingsPromise,
        customConfigPromise,
      ] as const);

      const failedScopes: string[] = [];
      let firstError: unknown = null;

      if (settingsResult.status === "fulfilled" && settingsResult.value) {
        const saved = settingsResult.value;
        setSavedSettings(saved);
        setSettings(saved);
        syncSavedPreviewState(saved);
        void refetchNotificationHistory();
        if (providerChanged) {
          try {
            await refreshRates(saved.exchangeRateProvider);
          } catch (e) {
            console.warn("Failed to refresh exchange rates after saving settings:", e);
          }
        }
      } else if (settingsResult.status === "rejected") {
        failedScopes.push(t("settings.appSettingsScope"));
        firstError = settingsResult.reason;
      }

      if (customConfigResult.status === "fulfilled" && customConfigResult.value) {
        const savedConfig = customConfigResult.value;
        setSavedCustomConfig(savedConfig);
        setCustomConfig(savedConfig);
      } else if (customConfigResult.status === "rejected") {
        failedScopes.push(t("settings.customConfigScope"));
        firstError ??= customConfigResult.reason;
      }

      if (failedScopes.length === 0) {
        toast({
          title: t("settings.saved"),
          description: t("settings.savedDescription"),
        });
        return;
      }

      const fallbackDescription = providerChanged && firstError
        ? getExchangeRateProviderSaveErrorMessage(firstError, t)
        : getDisplayErrorMessage(firstError, t("settings.saveFailedDescription"));
      toast({
        title: t("settings.saveFailed"),
        description: failedScopes.length > 1
          ? t("settings.partialSaveFailedDescription", { scope: failedScopes.join(", ") })
          : fallbackDescription,
        variant: "destructive",
      });
    } finally {
      setIsSavingSettings(false);
    }
  }, [
    customConfig,
    customConfigDirty,
    hasUnsavedChanges,
    isSavingSettings,
    monthlyBudgetError,
    refetchNotificationHistory,
    refreshRates,
    saveConfig,
    savedSettings.exchangeRateProvider,
    settings,
    settingsDirty,
    syncSavedPreviewState,
    t,
    toast,
    updateSettings,
  ]);

  const handleDiscardChanges = useCallback(() => {
    setSettings(savedSettings);
    setCustomConfig(savedCustomConfig);
    setMonthlyBudgetError(null);
    syncSavedPreviewState(savedSettings);
  }, [savedCustomConfig, savedSettings, syncSavedPreviewState]);

  const handleDefaultCurrencyChange = useCallback(
    (value: string) => {
      updateSetting("defaultCurrency", value);
    },
    [updateSetting],
  );

  const handleExchangeRateProviderChange = useCallback(
    (value: ExchangeRateProvider) => {
      updateSetting("exchangeRateProvider", value);
    },
    [updateSetting],
  );

  const handleThemeModeChange = useCallback(
    (value: ThemeMode) => {
      updateSetting("themeMode", value);
      setTheme(value);
      writeAppearancePendingToStorage(true);
    },
    [setTheme, updateSetting],
  );

  const handleThemeVariantChange = useCallback(
    (value: ThemeVariant) => {
      // 主题风格先写 DOM 再等待统一保存；这是为了让 Settings 页像控制面板一样即时反馈。
      updateSetting("themeVariant", value);
      applyThemeVariant(value, settings.themeCustomColor);
      writeThemeVariantToStorage(value);
      writeAppearancePendingToStorage(true);
    },
    [settings.themeCustomColor, updateSetting],
  );

  const handleThemeCustomColorChange = useCallback(
    (value: CustomThemeColor) => {
      // 自定义色只有在 custom 主题下才需要立即覆写 CSS 变量，其他主题仅保存候选值。
      updateSetting("themeCustomColor", value);
      writeCustomThemeColorToStorage(value);
      writeAppearancePendingToStorage(true);

      if (settings.themeVariant === "custom") {
        applyThemeVariant("custom", value);
      }
    },
    [settings.themeVariant, updateSetting],
  );

  return {
    settings,
    accountEmail,
    canAccessPocketBaseAdmin: accountIdentity.role === "admin",
    customConfig,
    subscriptionsQuery,
    categoryUsageCount,
    rates,
    activeRateProvider,
    ratesLoading,
    lastUpdated,
    ratesError,
    getCurrencySymbol,
    updateCategories,
    updateStatuses,
    updatePaymentMethods,
    updateCurrencies,
    updateSetting,
    monthlyBudgetError,
    handleMonthlyBudgetInputChange,
    toggleChannel,
    handleRefreshRates,
    handleUpdateCurrencies,
    hasUnsavedChanges,
    handleSaveChanges,
    handleDiscardChanges,
    isSavingSettings,
    handleDefaultCurrencyChange,
    handleExchangeRateProviderChange,
    handleThemeModeChange,
    handleThemeVariantChange,
    handleThemeCustomColorChange,
    testingChannel: notificationTest.testingChannel,
    handleTestConnection: notificationTest.testConnection,
    notificationHistory,
    password,
    passwordResetEnabled,
  };
}
