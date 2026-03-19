import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";

const navItems = [
  { path: "/", labelKey: "nav.dashboard", icon: "🏠" },
  { path: "/interview", labelKey: "nav.interview", icon: "💬" },
  { path: "/anchors", labelKey: "nav.anchors", icon: "⚓" },
  { path: "/settings", labelKey: "nav.settings", icon: "⚙️" },
];

export function NavBar() {
  const { pathname } = useLocation();
  const { t } = useTranslation();

  return (
    <nav className="flex justify-around border-t bg-white py-2">
      {navItems.map((item) => (
        <Link
          key={item.path}
          to={item.path}
          className={`flex flex-col items-center text-xs ${
            pathname === item.path ? "text-blue-600" : "text-gray-500"
          }`}
        >
          <span className="text-lg">{item.icon}</span>
          <span>{t(item.labelKey)}</span>
        </Link>
      ))}
    </nav>
  );
}
