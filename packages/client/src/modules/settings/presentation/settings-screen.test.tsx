import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DEFAULT_CUSTOM_CONFIG } from "@/types/config";
import {
  DEFAULT_SETTINGS,
  WEBHOOK_HEADERS_PLACEHOLDER,
  WEBHOOK_PAYLOAD_PLACEHOLDER,
  type AppSettings,
  type NotificationChannel,
} from "@/types/subscription";
import { SettingsScreen } from "./settings-screen";

const mocks = vi.hoisted(() => ({
  useSettingsFormController: vi.fn(),
}));

vi.mock("@/components/header", () => ({
  Header: () => <header data-testid="header" />,
}));

vi.mock("@/modules/custom-config/presentation/config-manager-dialog", () => ({
  ConfigManagerDialog: () => null,
}));

vi.mock("@/components/theme-selector", () => ({
  ThemeSelector: () => null,
}));

// CustomThemeSection 内部直接调用 useQueryClient / useSettings；这些测试只关心
// SettingsScreen 自己的布局与传参，与自定义 CSS 主题区块无关，因此 mock 掉以避免
// 强制构造 QueryClientProvider 测试环境。
vi.mock("./custom-theme-section", () => ({
  CustomThemeSection: () => <div data-testid="custom-theme-section" />,
}));

vi.mock("@/components/ui/searchable-select", () => ({
  SearchableSelect: ({ value }: { value: string }) => <div data-testid="searchable-select">{value}</div>,
}));

vi.mock("@/components/ui/time-picker", () => ({
  TimePicker: () => null,
}));

vi.mock("../application/use-settings-form-controller", () => ({
  useSettingsFormController: mocks.useSettingsFormController,
}));

function createControllerState(overrides: {
  settings?: Partial<AppSettings>;
  canAccessPocketBaseAdmin?: boolean;
  testingChannel?: NotificationChannel | null;
  isSavingSettings?: boolean;
  hasUnsavedChanges?: boolean;
} = {}) {
  const fn = vi.fn();
  return {
    settings: {
      ...DEFAULT_SETTINGS,
      enabledChannels: ["email"],
      smtpHost: "smtp.example.com",
      smtpPort: "587",
      smtpSecure: false,
      smtpUser: "smtp-user",
      smtpPassword: "smtp-password",
      smtpFrom: "Renewlet <noreply@example.com>",
      smtpReplyTo: "support@example.com",
      recipientEmail: "alice@example.com",
      ...overrides.settings,
    },
    accountEmail: "alice@example.com",
    canAccessPocketBaseAdmin: overrides.canAccessPocketBaseAdmin ?? true,
    customConfig: DEFAULT_CUSTOM_CONFIG,
    subscriptionsQuery: { data: [] },
    categoryUsageCount: new Map(),
    rates: {},
    activeRateProvider: "floatrates",
    ratesLoading: false,
    lastUpdated: null,
    ratesError: null,
    getCurrencySymbol: () => "¥",
    updateCategories: fn,
    updateStatuses: fn,
    updatePaymentMethods: fn,
    updateSetting: fn,
    monthlyBudgetError: null,
    handleMonthlyBudgetInputChange: fn,
    toggleChannel: fn,
    handleRefreshRates: fn,
    handleUpdateCurrencies: fn,
    hasUnsavedChanges: overrides.hasUnsavedChanges ?? false,
    handleSaveChanges: fn,
    handleDiscardChanges: fn,
    handleDefaultCurrencyChange: fn,
    handleExchangeRateProviderChange: fn,
    handleThemeModeChange: fn,
    handleThemeVariantChange: fn,
    handleThemeCustomColorChange: fn,
    testingChannel: overrides.testingChannel ?? null,
    handleTestConnection: fn,
    isSavingSettings: overrides.isSavingSettings ?? false,
    notificationHistory: {
      data: undefined,
      isLoading: false,
      isFetching: false,
      error: null,
      historyStatus: "all",
      setStatus: fn,
      loadMore: fn,
      refetch: fn,
    },
    password: {
      passwordDialogOpen: false,
      setPasswordDialogOpen: fn,
      handlePasswordDialogOpenChange: fn,
      currentPassword: "",
      setCurrentPassword: fn,
      newPassword: "",
      setNewPassword: fn,
      confirmPassword: "",
      setConfirmPassword: fn,
      isUpdatingPassword: false,
      updatePassword: fn,
    },
    passwordResetEnabled: true,
  };
}

function RouteProbe() {
  const location = useLocation();
  return <div data-testid="route-path">{location.pathname}</div>;
}

function renderSettingsScreen(initialEntries = ["/settings"]) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <TooltipProvider delayDuration={0}>
        <SettingsScreen />
      </TooltipProvider>
      <RouteProbe />
    </MemoryRouter>,
  );
}

describe("SettingsScreen SMTP email settings", () => {
  beforeEach(() => {
    mocks.useSettingsFormController.mockReturnValue(createControllerState());
  });

  it("renders SMTP fields instead of Resend fields for email notifications", () => {
    renderSettingsScreen();

    expect(screen.queryByText(/Resend/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
    expect(screen.getByLabelText("SMTP 服务器")).toHaveValue("smtp.example.com");
    expect(screen.getByLabelText("SMTP 端口")).toHaveValue("587");
    expect(screen.getByLabelText("SMTP 用户名")).toHaveValue("smtp-user");
    expect(screen.getByLabelText("SMTP 密码")).toHaveValue("smtp-password");
    expect(screen.getByLabelText("发件人")).toHaveValue("Renewlet <noreply@example.com>");
    expect(screen.getByLabelText("回复地址")).toHaveValue("support@example.com");
    expect(screen.getByRole("button", { name: "测试邮件通知" })).toBeInTheDocument();
  });

  it("shows the PocketBase admin link for admins", () => {
    renderSettingsScreen();

    const link = screen.getByRole("link", { name: "PocketBase 后台" });
    expect(link).toHaveAttribute("href", "/_/");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("uses client routing for account page links", async () => {
    const user = userEvent.setup();
    renderSettingsScreen();

    expect(screen.getByTestId("route-path")).toHaveTextContent("/settings");

    await user.click(screen.getByRole("link", { name: "管理用户" }));
    expect(screen.getByTestId("route-path")).toHaveTextContent("/admin/users");

    await user.click(screen.getByRole("link", { name: "忘记密码？" }));
    expect(screen.getByTestId("route-path")).toHaveTextContent("/forgot-password");
  });

  it("hides the PocketBase admin link for non-admin users", () => {
    mocks.useSettingsFormController.mockReturnValue(createControllerState({
      canAccessPocketBaseAdmin: false,
    }));

    renderSettingsScreen();

    expect(screen.queryByRole("link", { name: "PocketBase 后台" })).not.toBeInTheDocument();
  });

  it("lets users choose FloatRates as the exchange-rate source", async () => {
    Element.prototype.hasPointerCapture = vi.fn(() => false);
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
    const user = userEvent.setup();
    const controller = createControllerState({
      settings: {
        exchangeRateProvider: "frankfurter",
      },
    });
    mocks.useSettingsFormController.mockReturnValue(controller);

    renderSettingsScreen();

    await user.click(screen.getByRole("combobox", { name: "汇率来源" }));
    await user.click(screen.getByRole("option", { name: "FloatRates" }));

    expect(controller.handleExchangeRateProviderChange).toHaveBeenCalledWith("floatrates");
  });

  it("shows the selected draft exchange-rate source without forcing an immediate save", () => {
    mocks.useSettingsFormController.mockReturnValue(createControllerState({
      settings: {
        exchangeRateProvider: "floatrates",
      },
    }));

    renderSettingsScreen();

    const select = screen.getByRole("combobox", { name: "汇率来源" });
    expect(select).toHaveTextContent("FloatRates");
    expect(select).toBeEnabled();
  });

  it("renders the monthly budget as a formatted text input instead of a spinbutton", () => {
    renderSettingsScreen();

    const budgetInput = screen.getByLabelText("月度预算金额");
    expect(budgetInput).toHaveAttribute("type", "text");
    expect(budgetInput).toHaveAttribute("inputmode", "decimal");
    expect(screen.queryByRole("spinbutton", { name: "月度预算金额" })).not.toBeInTheDocument();
  });

  it("uses test wording for the Notifyx channel button", () => {
    mocks.useSettingsFormController.mockReturnValue(createControllerState({
      settings: {
        enabledChannels: ["notifyx"],
        notifyxApiKey: "notifyx-key",
      },
    }));

    renderSettingsScreen();

    expect(screen.getByRole("button", { name: "测试 Notifyx 通知" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "发送 Notifyx 通知" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Notifyx 说明" })).toHaveAttribute(
      "href",
      "https://www.notifyx.cn/help",
    );
  });

  it("shows loading state on the active notification test button and disables other test buttons", async () => {
    const user = userEvent.setup();
    mocks.useSettingsFormController.mockReturnValue(createControllerState({
      settings: {
        enabledChannels: ["telegram", "webhook"],
      },
      testingChannel: "telegram",
    }));

    renderSettingsScreen();

    const loadingButton = screen.getByRole("button", { name: "测试中..." });
    expect(loadingButton).toBeDisabled();
    expect(loadingButton).toHaveAttribute("aria-busy", "true");

    await user.click(screen.getByRole("button", { name: "配置 Webhook 通知" }));

    expect(screen.getByRole("button", { name: "测试 Webhook 通知" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "测试 Telegram 通知" })).not.toBeInTheDocument();
  });

  it("renders only the active notification channel config panel", () => {
    mocks.useSettingsFormController.mockReturnValue(createControllerState({
      settings: {
        enabledChannels: ["telegram", "notifyx", "webhook", "wechat", "email", "bark"],
      },
    }));

    renderSettingsScreen();

    expect(screen.getByRole("heading", { name: "Telegram 配置" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Notifyx 配置" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Webhook 通知 配置" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "企业微信机器人 配置" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "邮件通知 配置" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Bark 配置" })).not.toBeInTheDocument();
  });

  it("switches to Bark config when the Bark channel is selected", async () => {
    const user = userEvent.setup();
    mocks.useSettingsFormController.mockReturnValue(createControllerState({
      settings: {
        enabledChannels: ["telegram", "bark"],
        barkServerUrl: "https://api.day.app",
        barkDeviceKey: "bark-device-key",
      },
    }));

    renderSettingsScreen();

    await user.click(screen.getByRole("button", { name: "配置 Bark" }));

    expect(screen.getByRole("heading", { name: "Bark 配置" })).toBeInTheDocument();
    expect(screen.getByLabelText("服务器地址")).toHaveValue("https://api.day.app");
    expect(screen.getByLabelText("设备 Key")).toHaveValue("bark-device-key");
    expect(screen.getByLabelText("静音推送")).toBeInTheDocument();
  });

  it("selects Bark immediately after checking it and keeps the test button available before enabling it", async () => {
    const user = userEvent.setup();
    const controller = createControllerState({
      settings: {
        enabledChannels: ["telegram"],
      },
    });
    mocks.useSettingsFormController.mockReturnValue(controller);

    renderSettingsScreen();

    await user.click(screen.getByRole("checkbox", { name: "启用 Bark" }));

    expect(controller.toggleChannel).toHaveBeenCalledWith("bark");
    expect(screen.getByRole("heading", { name: "Bark 配置" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "测试 Bark 通知" })).toBeEnabled();
  });

  it("renders Webhook examples as placeholders instead of default textarea values", () => {
    mocks.useSettingsFormController.mockReturnValue(createControllerState({
      settings: {
        enabledChannels: ["webhook"],
        webhookUrl: "https://example.com/webhook",
        webhookHeaders: "",
        webhookPayload: "",
      },
    }));

    renderSettingsScreen();

    const headers = screen.getByLabelText("自定义请求头 (JSON格式，可选)");
    const payload = screen.getByLabelText("发送负载 (JSON格式，可选)");

    expect(headers).toHaveValue("");
    expect(headers).toHaveAttribute("placeholder", WEBHOOK_HEADERS_PLACEHOLDER);
    expect(payload).toHaveValue("");
    expect(payload).toHaveAttribute("placeholder", WEBHOOK_PAYLOAD_PLACEHOLDER);
  });

  it("does not show the save bar when there are no unsaved changes", () => {
    renderSettingsScreen();

    expect(screen.queryByText("有未保存更改")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存更改" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "放弃更改" })).not.toBeInTheDocument();
  });

  it("shows discard and save actions only when there are unsaved changes", async () => {
    const user = userEvent.setup();
    const controller = createControllerState({
      hasUnsavedChanges: true,
    });
    mocks.useSettingsFormController.mockReturnValue(controller);

    renderSettingsScreen();

    expect(screen.getByText("有未保存更改")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "放弃更改" }));
    expect(controller.handleDiscardChanges).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "保存更改" }));
    expect(controller.handleSaveChanges).toHaveBeenCalled();
  });

  it("shows loading state on the save changes button", () => {
    mocks.useSettingsFormController.mockReturnValue(createControllerState({
      hasUnsavedChanges: true,
      isSavingSettings: true,
    }));

    renderSettingsScreen();

    const saveButton = screen.getByRole("button", { name: "保存中..." });
    expect(saveButton).toBeDisabled();
    expect(saveButton).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("button", { name: "保存所有设置" })).not.toBeInTheDocument();
  });
});
