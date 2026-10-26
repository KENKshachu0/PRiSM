import { NoticeProvider } from "./NoticeProvider";
import { PlayerAccountMenu } from "./PlayerAccountMenu";
import { resolveLocale, translate, useI18n } from "../i18n";
import { Component, lazy, Suspense, type ReactNode } from "react";
import {
  Link,
  Navigate,
  NavLink,
  useLocation,
  Route,
  Routes,
} from "react-router-dom";
import { Gamepad2, IdCard, Shield, Store, UserRound } from "lucide-react";
import { AuthProvider, useAuth } from "./AuthContext";
import { AuthPage } from "./AuthPage";

const MerchantBillingPage = lazy(() =>
  import("./MerchantBillingPage").then((module) => ({
    default: module.MerchantBillingPage,
  })),
);
const AdminPage = lazy(() =>
  import("./AdminPage").then((module) => ({ default: module.AdminPage })),
);
const CardsPage = lazy(() =>
  import("./CardsPage").then((module) => ({ default: module.CardsPage })),
);
import { ResourcePage } from "./ResourcePage";
const MerchantPage = lazy(() =>
  import("./MerchantPage").then((module) => ({ default: module.MerchantPage })),
);
const SettingsPage = lazy(() =>
  import("./SettingsPage").then((module) => ({ default: module.SettingsPage })),
);
const ShopPage = lazy(() => import("./ShopPage"));

/**
 * The coarse route identity used to reset the error boundary. A merchant tab
 * switch stays inside the same shop and must keep the page mounted.
 */
function routeArea(pathname: string): string {
  const [first, second] = pathname.split("/").filter(Boolean);
  return first === "merchant" && second ? `/${first}/${second}` : pathname;
}

export function App() {
  return (
    <AuthProvider>
      <NoticeProvider>
        <Shell />
      </NoticeProvider>
    </AuthProvider>
  );
}

function Shell() {
  const { t } = useI18n();
  const { user } = useAuth();
  const { pathname } = useLocation();
  const machineSession = pathname === "/m" || pathname.startsWith("/m/") || /^\/t\/[^/]+\/?$/.test(pathname);
  return (
    <div className="min-h-screen bg-canvas text-ink">
      {!machineSession && (
        <header className="site-header">
          <div className="site-header-inner">
            <Link to="/" className="site-brand focus-ring">
              <span className="grid size-10 place-items-center rounded-2xl bg-mint text-white">
                <Gamepad2 size={20} />
              </span>
              PRiSM
            </Link>
            <nav className="site-navigation" aria-label={t("主导航")}>
              <NavItem
                to="/cards"
                icon={<IdCard size={16} />}
                label={t("卡片")}
              />
              {(user?.hasShops || user?.role === "admin") && (
                <NavItem
                  to="/merchant"
                  icon={<Store size={16} />}
                  label={t("店家")}
                />
              )}
              {user?.role === "admin" && (
                <NavItem
                  to="/admin"
                  icon={<Shield size={16} />}
                  label={t("管理")}
                />
              )}
              {user && (
                <NavItem
                  to="/settings"
                  icon={<UserRound size={16} />}
                  label={t("账号")}
                />
              )}
              {user ? (
                <PlayerAccountMenu />
              ) : (
                <NavLink
                  className="focus-ring rounded px-3 py-2 hover:bg-ink/5"
                  to="/login"
                >
                  {t("登录")}
                </NavLink>
              )}
            </nav>
          </div>
        </header>
      )}
      {machineSession && (
        <div className="player-account-bar">
          <PlayerAccountMenu />
        </div>
      )}
      <main className={machineSession ? "session-main" : "site-main"}>
        {/* Keyed by area, not by full path: switching a merchant tab must not
            remount the page, or it drops its data and flashes a loading state. */}
        <PageErrorBoundary key={routeArea(pathname)}>
        <Suspense
          fallback={
            <div className="rounded border border-ink/10 bg-panel p-6">
              {t("加载中...")}
            </div>
          }
        >
          <Routes>
            <Route path="/" element={<Navigate to="/cards" replace />} />
            {/* Shop code without a machine id: the standalone, ticket-free shop surface. */}
            <Route path="/t/:shopCode" element={<ShopPage />} />
            <Route path="/login" element={<AuthPage />} />
            <Route
              path="/register"
              element={<Navigate to="/login" replace />}
            />
            <Route path="/cards" element={<CardsPage />} />
            <Route path="/merchant" element={<MerchantPage />} />
            <Route
              path="/merchant/:shopCode/billing/:section?"
              element={<MerchantBillingPage />}
            />
            <Route
              path="/merchant/:shopCode/:section?"
              element={<MerchantPage />}
            />
            <Route path="/admin" element={<AdminPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/m" element={<ResourcePage />} />
            <Route path="/m/expired" element={<ResourcePage />} />
            <Route path="/m/:ticket" element={<ResourcePage />} />
          </Routes>
        </Suspense>
        </PageErrorBoundary>
      </main>
    </div>
  );
}

function NavItem({
  to,
  icon,
  label,
}: {
  to: string;
  icon: ReactNode;
  label: string;
}) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `focus-ring site-nav-item ${isActive ? "is-active" : ""}`
      }
    >
      {icon}
      <span className="nav-label">{label}</span>
    </NavLink>
  );
}

/** A route crash should never leave mobile users staring at a blank page. */
class PageErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    // Stack traces remain in browser diagnostics, not in the public UI.
    console.error("PRiSM page render failed", error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    // The boundary sits above I18nProvider's consumers it replaces, so it reads
    // the same negotiated locale directly instead of requiring a provider.
    const language =
      typeof navigator === "undefined" ? "en" : resolveLocale(navigator.languages);
    return (
      <section role="alert" className="mx-auto max-w-lg space-y-4 rounded-xl border border-ink/10 bg-panel p-6">
        <h1 className="text-xl font-semibold">{translate("页面暂时无法显示", language)}</h1>
        <p className="text-sm text-ink/70">{translate("页面发生错误，请刷新重试。若问题持续，请联系管理员。", language)}</p>
        <button className="focus-ring rounded-xl bg-primary px-4 py-3 text-sm font-medium text-primary-foreground" onClick={() => window.location.reload()}>
          {translate("刷新页面", language)}
        </button>
      </section>
    );
  }
}
