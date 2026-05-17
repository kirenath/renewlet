package main

// main.go 是 Renewlet 的 PocketBase 应用入口。
//
// 架构位置：
//   - 负责启动 PocketBase、注册 schema migration、record hooks、cron 和自定义 HTTP route。
//   - 静态前端由 embedded FS 提供，自定义 API 复用 PocketBase auth/session。
//   - 具体请求/响应 DTO 在 api_contracts.go，通知任务在 notifications.go，文件资产在 assets.go。
//
// Caveat: 这里的 route 是前端 API schema 的后端真相来源；新增字段时必须同步 Zod schema 和 route 测试。
import (
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/hook"
	appstatic "github.com/zhiyingzzhou/renewlet/packages/server/internal/static"
)

func init() {
	core.AppMigrations.Register(func(app core.App) error {
		return ensureSchema(app)
	}, nil, "20260514000000_renewlet_schema.go")
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		runHealthcheck()
		return
	}

	if os.Getenv("GOMEMLIMIT") == "" {
		_ = os.Setenv("GOMEMLIMIT", "128MiB")
	}
	if err := validatePBEncryptionKeyEnv(); err != nil {
		log.Fatal(err)
	}

	app := pocketbase.New()
	if err := registerNotificationCron(app); err != nil {
		log.Fatal(err)
	}
	// Record hook 必须早于 Serve route 注册，这样 API、SDK 和管理后台写入都能共享同一套持久层校验。
	registerRecordHooks(app)

	app.OnBootstrap().BindFunc(func(e *core.BootstrapEvent) error {
		if err := e.Next(); err != nil {
			return err
		}
		if err := e.App.RunAppMigrations(); err != nil {
			return err
		}
		return ensureSchema(e.App)
	})

	app.OnRecordAuthWithPasswordRequest("users").BindFunc(func(e *core.RecordAuthWithPasswordRequestEvent) error {
		if e.Record != nil && e.Record.GetBool("banned") {
			return errors.New(localizedDisabledBanReason(requestLocale(e.Request)))
		}
		return e.Next()
	})

	app.OnServe().Bind(&hook.Handler[*core.ServeEvent]{
		Func: func(e *core.ServeEvent) error {
			registerRoutes(e.App, e.Router)

			staticFS, err := fs.Sub(appstatic.Files, "public")
			if err != nil {
				return err
			}
			if !e.Router.HasRoute(http.MethodGet, "/{path...}") {
				e.Router.GET("/{path...}", staticWithSecurityHeaders(staticFS))
			}

			return e.Next()
		},
		Priority: 999,
	})

	if err := app.Start(); err != nil {
		log.Fatal(err)
	}
}

func runHealthcheck() {
	url := "http://127.0.0.1:3000/api/app/health"
	for _, arg := range os.Args[2:] {
		if strings.HasPrefix(arg, "--url=") {
			url = strings.TrimPrefix(arg, "--url=")
		}
	}

	client := http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer resp.Body.Close()

	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		fmt.Fprintf(os.Stderr, "healthcheck failed: %s\n", resp.Status)
		os.Exit(1)
	}
}

// staticWithSecurityHeaders 为嵌入式前端静态资源补安全响应头。
// Caveat: CSP connect-src 需要覆盖前端直接访问的第三方 API；新增外部 fetch 时要同步这里。
func staticWithSecurityHeaders(staticFS fs.FS) func(*core.RequestEvent) error {
	handler := apis.Static(staticFS, true)
	return func(e *core.RequestEvent) error {
		headers := e.Response.Header()
		headers.Set("X-Content-Type-Options", "nosniff")
		headers.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		headers.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		headers.Set("Content-Security-Policy", strings.Join([]string{
			"default-src 'self'",
			"script-src 'self' https://static.cloudflareinsights.com",
			"style-src 'self' 'unsafe-inline' https:",
			"font-src 'self' data: https:",
			"img-src 'self' data: blob: https:",
			"connect-src 'self' https://api.frankfurter.dev https://www.floatrates.com https://testingcf.jsdelivr.net https://www.google.com https://icons.duckduckgo.com",
			"object-src 'none'",
			"base-uri 'self'",
			"frame-ancestors 'none'",
		}, "; "))
		return handler(e)
	}
}
