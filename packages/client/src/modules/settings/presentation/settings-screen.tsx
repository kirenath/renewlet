/**
 * 系统配置页（/settings）。
 *
 * 架构位置：
 * - app route 只装配本 screen。
 * - application controller 负责远端同步、toast、主题本地状态和通知测试。
 * - 本文件只消费 props/handlers 并渲染设置分区。
 *
 * 关键依赖：
 * - useSettingsFormController：Settings 页唯一业务入口。
 * - ConfigManagerDialog：自定义配置的模块化 presentation。
 * - ThemeSelector：外观即时预览控件。
 *
 * Caveat: 如果这里直接引入 API client、auth client 或 localStorage，就会破坏
 * presentation -> application -> domain 的依赖方向。
 */

import { useEffect, useState } from 'react';
import { Header } from '@/components/header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NumericInput } from '@/components/ui/numeric-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { TimePicker } from '@/components/ui/time-picker';
import { ConfigManagerDialog } from '@/modules/custom-config/presentation/config-manager-dialog';
import { ThemeSelector } from '@/components/theme-selector';
import { CustomThemeSection } from './custom-theme-section';
import { NotificationHistoryPanel } from './notification-history-panel';
import { Settings2, FolderKanban, Activity, CreditCard, Coins, Palette } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CURRENCY_OPTIONS, type NotificationChannel } from '@/types/subscription';
import { isBuiltInPaymentMethodValue } from '@/types/config';
import { assertLocalTime } from '@/lib/time/local-time';
import { getSupportedTimeZones } from '@/lib/time/time-zone';
import { createCurrencySelectOptions, createTimeZoneSelectOptions } from '@/lib/searchable-options';
import { useSettingsFormController } from '../application/use-settings-form-controller';
import { useI18n } from '@/i18n/I18nProvider';
import type { Locale } from '@/i18n/locales';
import { AccountSettingsSection } from './account-settings-section';
import { NotificationChannelConfigPanel } from './notification-channel-config-panel';
import { NotificationChannelList } from './notification-channel-list';
import { ExchangeRatesSection } from './exchange-rates-section';
import { CheckboxSettingRow, LoadingButtonContent } from './settings-shared-controls';

function useUnsavedChangesGuard(enabled: boolean, message: string, onConfirmLeave: () => void) {
  useEffect(() => {
    if (!enabled) return undefined;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return undefined;
    const handleClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented
        || event.button !== 0
        || event.metaKey
        || event.ctrlKey
        || event.shiftKey
        || event.altKey
      ) {
        return;
      }

      const target = event.target instanceof Element ? event.target : null;
      const anchor = target?.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target && anchor.target !== "_self") return;
      if (anchor.hasAttribute("download")) return;

      const nextUrl = new URL(anchor.href, window.location.href);
      if (nextUrl.origin !== window.location.origin) return;
      const currentUrl = new URL(window.location.href);
      if (
        nextUrl.pathname === currentUrl.pathname
        && nextUrl.search === currentUrl.search
        && nextUrl.hash === currentUrl.hash
      ) {
        return;
      }

      if (window.confirm(message)) {
        onConfirmLeave();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };

    document.addEventListener("click", handleClick, true);
    return () => document.removeEventListener("click", handleClick, true);
  }, [enabled, message, onConfirmLeave]);
}

/** 设置页 screen：只负责布局与展示，业务状态由 controller 提供。 */
export function SettingsScreen() {
  const { t, locale, setLocale, label: localizeLabel, formatDateTime } = useI18n();
  const {
    settings,
    accountEmail,
    canAccessPocketBaseAdmin,
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
    updateSetting,
    monthlyBudgetError,
    handleMonthlyBudgetInputChange,
    toggleChannel,
    handleRefreshRates,
    handleUpdateCurrencies,
    handleDefaultCurrencyChange,
    handleExchangeRateProviderChange,
    hasUnsavedChanges,
    handleSaveChanges,
    handleDiscardChanges,
    handleThemeModeChange,
    handleThemeVariantChange,
    handleThemeCustomColorChange,
    testingChannel,
    handleTestConnection,
    isSavingSettings,
    notificationHistory,
    password,
    passwordResetEnabled,
  } = useSettingsFormController();

  const {
    passwordDialogOpen,
    setPasswordDialogOpen,
    handlePasswordDialogOpenChange,
    currentPassword,
    setCurrentPassword,
    newPassword,
    setNewPassword,
    confirmPassword,
    setConfirmPassword,
    isUpdatingPassword,
    updatePassword,
  } = password;
  const timezoneOptions = createTimeZoneSelectOptions(getSupportedTimeZones());
  const defaultCurrencyOptions = createCurrencySelectOptions({
    currencies: customConfig.currencies,
    currencyOptions: CURRENCY_OPTIONS,
    includeDisabledCurrent: settings.defaultCurrency,
    locale,
    formatLabel: (item, option) =>
      `${getCurrencySymbol(item.value)} ${option ? localizeLabel(option.labels) : localizeLabel(item.labels)}`,
  });
  const [selectedNotificationChannel, setSelectedNotificationChannel] = useState<NotificationChannel | null>(null);
  const activeNotificationChannel = selectedNotificationChannel ?? settings.enabledChannels[0] ?? 'telegram';
  const handleNotificationChannelToggle = (channel: NotificationChannel) => {
    setSelectedNotificationChannel(channel);
    toggleChannel(channel);
  };
  const handleLocaleChange = (value: string) => {
    const nextLocale = value as Locale;
    updateSetting('locale', nextLocale);
    setLocale(nextLocale, { persist: false });
  };
  useUnsavedChangesGuard(hasUnsavedChanges, t("settings.unsavedLeavePrompt"), handleDiscardChanges);

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <Header />

      <main className={cn("flex-1", hasUnsavedChanges && "pb-24")}>
        <div className="mx-auto max-w-7xl px-6 py-8">
          <div className="mb-8">
            <h1 className="text-2xl font-bold text-foreground">{t("settings.title")}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t("settings.subtitle")}</p>
          </div>

          <div className="grid gap-8">
            <AccountSettingsSection
              accountEmail={accountEmail}
              canAccessPocketBaseAdmin={canAccessPocketBaseAdmin}
              passwordResetEnabled={passwordResetEnabled}
              passwordDialogOpen={passwordDialogOpen}
              setPasswordDialogOpen={setPasswordDialogOpen}
              handlePasswordDialogOpenChange={handlePasswordDialogOpenChange}
              currentPassword={currentPassword}
              setCurrentPassword={setCurrentPassword}
              newPassword={newPassword}
              setNewPassword={setNewPassword}
              confirmPassword={confirmPassword}
              setConfirmPassword={setConfirmPassword}
              isUpdatingPassword={isUpdatingPassword}
              updatePassword={updatePassword}
            />

          {/* 外观设置 */}
          <section className="rounded-xl border border-border bg-card p-6">
            <div className="flex items-center gap-2 mb-6">
              <Palette className="h-5 w-5 text-primary" />
              <h2 className="text-lg font-semibold text-foreground">{t("settings.appearance")}</h2>
            </div>
            <ThemeSelector
              mode={settings.themeMode}
              variant={settings.themeVariant}
              customColor={settings.themeCustomColor}
              onModeChange={handleThemeModeChange}
              onVariantChange={handleThemeVariantChange}
              onCustomColorChange={handleThemeCustomColorChange}
            />
          </section>

          {/* 自定义 CSS 主题 ───────────────────────────────────────────────
              该 section 内部通过 `useCustomThemes()` 自管草稿与持久化（每个动作
              都会立即调用 `useUpdateSettings.mutateAsync`），因此**不**接入
              `useSettingsFormController` 的 saved/draft 比对，也不会让底部
              「保存所有设置」保存条变 dirty（Req 9.3 / 12.1）。 */}
          <CustomThemeSection />

          {/* 显示设置 */}
            <section className="rounded-xl border border-border bg-card p-6">
              <h2 className="mb-6 text-lg font-semibold text-foreground">{t("settings.display")}</h2>
              <div className="grid gap-6">
                <div className="grid gap-2">
                  <Label htmlFor="locale">{t("settings.language")}</Label>
                  <Select value={settings.locale} onValueChange={handleLocaleChange}>
                    <SelectTrigger id="locale" className="w-full border-border bg-secondary sm:w-[220px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="zh-CN">{t("locale.zhCN")}</SelectItem>
                      <SelectItem value="en-US">{t("locale.enUS")}</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">{t("settings.languageHelp")}</p>
                </div>
                <CheckboxSettingRow
                  id="showExpired"
                  checked={settings.showExpired}
                  onCheckedChange={(checked) => updateSetting('showExpired', checked)}
                  label={t("settings.showExpired")}
                  description={t("settings.showExpiredHelp")}
                />
            </div>
          </section>

          {/* 预算设置 */}
          <section className="rounded-xl border border-border bg-card p-6">
            <h2 className="mb-6 text-lg font-semibold text-foreground">{t("settings.budget")}</h2>
            <div className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="monthlyBudget">{t("settings.monthlyBudget")}</Label>
                <div className="flex items-center gap-3">
                  <NumericInput
                    id="monthlyBudget"
                    allowNegative={false}
                    allowedDecimalSeparators={[".", "。"]}
                    inputMode="decimal"
                    value={settings.monthlyBudget}
                    onRawValueChange={handleMonthlyBudgetInputChange}
                    className="w-[200px] border-border bg-secondary"
                    placeholder="1500"
                    thousandSeparator
                    aria-invalid={Boolean(monthlyBudgetError)}
                    aria-describedby={monthlyBudgetError ? "monthlyBudget-error" : undefined}
                  />
                  <span className="text-sm text-muted-foreground">
                    {getCurrencySymbol(settings.defaultCurrency)} {t("settings.perMonth")}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("settings.monthlyBudgetHelp")}
                </p>
                {monthlyBudgetError ? (
                  <p id="monthlyBudget-error" className="text-xs text-destructive">{monthlyBudgetError}</p>
                ) : null}
              </div>
            </div>
          </section>

          {/* 数据配置 */}
          <section className="rounded-xl border border-border bg-card p-6">
            <div className="flex items-center gap-2 mb-4">
              <Settings2 className="h-5 w-5 text-primary" />
              <h2 className="text-lg font-semibold text-foreground">{t("settings.dataConfig")}</h2>
            </div>
            <p className="text-sm text-muted-foreground mb-6">
              {t("settings.dataConfigDescription")}
            </p>
            
            <div className="grid gap-3 sm:grid-cols-2">
              <ConfigManagerDialog
                title={t("settings.categoryManager")}
                description={t("settings.categoryManagerDescription")}
                items={customConfig.categories}
                onUpdate={updateCategories}
                showColor={true}
                icon={<FolderKanban className="h-4 w-4" />}
                getDeleteBlockReason={(item) => {
                  if (customConfig.categories.length <= 1) {
                    return t("settings.categoryKeepOne");
                  }

                  // 删除校验依赖订阅数据；在加载/失败时先阻止删除，避免误判。
                  if (subscriptionsQuery.isPending) {
                    return t("settings.categoryChecking");
                  }
                  if (subscriptionsQuery.status === "error") {
                    return t("settings.categoryCheckFailed");
                  }

                  const usedCount = categoryUsageCount.get(item.value) ?? 0;
                  if (usedCount > 0) {
                    return t("settings.categoryUsed", { count: usedCount });
                  }

                  return null;
                }}
              />

              <ConfigManagerDialog
                title={t("settings.statusManager")}
                description={t("settings.statusManagerDescription")}
                items={customConfig.statuses}
                onUpdate={updateStatuses}
                showColor={true}
                readOnly={true}
                icon={<Activity className="h-4 w-4" />}
              />

              <ConfigManagerDialog
                title={t("settings.paymentManager")}
                description={t("settings.paymentManagerDescription")}
                items={customConfig.paymentMethods}
                onUpdate={updatePaymentMethods}
                icon={<CreditCard className="h-4 w-4" />}
                showIcon={true}
                isItemReadOnly={(item) => isBuiltInPaymentMethodValue(item.value)}
              />

              <ConfigManagerDialog
                title={t("settings.currencyManager")}
                description={t("settings.currencyManagerDescription")}
                items={customConfig.currencies}
                onUpdate={handleUpdateCurrencies}
                icon={<Coins className="h-4 w-4" />}
                toggleMode={true}
              />
            </div>
          </section>

          <ExchangeRatesSection
            settings={settings}
            customConfig={customConfig}
            rates={rates}
            activeRateProvider={activeRateProvider}
            ratesLoading={ratesLoading}
            ratesError={ratesError}
            lastUpdated={lastUpdated}
            defaultCurrencyOptions={defaultCurrencyOptions}
            handleRefreshRates={handleRefreshRates}
            handleDefaultCurrencyChange={handleDefaultCurrencyChange}
            handleExchangeRateProviderChange={handleExchangeRateProviderChange}
            getCurrencySymbol={getCurrencySymbol}
          />

          {/* 时区设置 */}
          <section className="rounded-xl border border-border bg-card p-6">
            <h2 className="mb-6 text-lg font-semibold text-foreground">{t("settings.timezone")}</h2>
            <div className="grid gap-2">
              <Label htmlFor="timezone">{t("settings.timezoneSelect")}</Label>
              <SearchableSelect
                value={settings.timezone}
                onValueChange={(value) => updateSetting('timezone', value)}
                options={timezoneOptions}
                placeholder={t("settings.timezonePlaceholder")}
                searchPlaceholder={t("settings.timezoneSearch")}
                emptyMessage={t("settings.timezoneEmpty")}
                className="w-full max-w-md border-border bg-secondary"
                contentClassName="max-w-md"
                aria-label={t("settings.timezoneSelect")}
              />
              <p className="text-xs text-muted-foreground">
                {t("settings.timezoneHelp")}
              </p>
            </div>
          </section>

          {/* 通知设置 */}
          <section className="rounded-xl border border-border bg-card p-6">
            <h2 className="mb-6 text-lg font-semibold text-foreground">{t("settings.notifications")}</h2>
            
            <div className="grid gap-6">
              <div className="grid gap-6 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label>{t("settings.notificationTime")}</Label>
                  <TimePicker
                    value={settings.notificationTimeLocal}
                    onChange={(value) => updateSetting('notificationTimeLocal', assertLocalTime(value))}
                    className="w-full"
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("settings.notificationTimeHelp")}
                  </p>
                </div>
                <div className="grid content-start gap-2">
                  <Label>{t("settings.tip")}</Label>
                  <p className="text-xs text-muted-foreground">
                    {t("settings.cronTip")}
                  </p>
                </div>
              </div>

              <div className="grid gap-6 lg:grid-cols-[minmax(0,280px)_1fr]">
                <NotificationChannelList
                  settings={settings}
                  activeChannel={activeNotificationChannel}
                  onSelect={setSelectedNotificationChannel}
                  onToggle={handleNotificationChannelToggle}
                />
                <NotificationChannelConfigPanel
                  channel={activeNotificationChannel}
                  settings={settings}
                  enabled={settings.enabledChannels.includes(activeNotificationChannel)}
                  updateSetting={updateSetting}
                  testingChannel={testingChannel}
                  onTest={handleTestConnection}
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="testPhone">{t("settings.testPhone")}</Label>
                <Input
                  id="testPhone"
                  placeholder={t("settings.testPhonePlaceholder")}
                  value={settings.testPhone}
                  onChange={(e) => updateSetting('testPhone', e.target.value)}
                  className="border-border bg-secondary"
                />
                <p className="text-xs text-muted-foreground">
                  {t("settings.testPhoneHelp")}
                </p>
              </div>

              <NotificationHistoryPanel
                data={notificationHistory.data}
                isLoading={notificationHistory.isLoading}
                isFetching={notificationHistory.isFetching}
                error={notificationHistory.error}
                status={notificationHistory.historyStatus}
                setStatus={notificationHistory.setStatus}
                loadMore={notificationHistory.loadMore}
                refetch={notificationHistory.refetch}
              />
            </div>
          </section>

          </div>
        </div>
      </main>

      {hasUnsavedChanges ? (
        <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-border bg-card/95 p-4 shadow-[0_-8px_30px_rgba(0,0,0,0.08)] backdrop-blur-sm">
          <div className="mx-auto flex max-w-7xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm font-medium text-foreground">{t("settings.unsavedChanges")}</p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="outline"
                onClick={handleDiscardChanges}
                disabled={isSavingSettings}
              >
                {t("settings.discardChanges")}
              </Button>
              <Button
                type="button"
                className="relative bg-primary text-primary-foreground hover:bg-primary-glow"
                onClick={handleSaveChanges}
                disabled={isSavingSettings || Boolean(monthlyBudgetError)}
                aria-busy={isSavingSettings ? true : undefined}
              >
                <LoadingButtonContent loading={isSavingSettings} loadingLabel={t("common.saving")}>
                  {t("settings.saveChanges")}
                </LoadingButtonContent>
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
