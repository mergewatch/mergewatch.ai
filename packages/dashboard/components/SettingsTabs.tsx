"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

const tabs = [
  { label: "General", href: "/dashboard/settings" },
  { label: "API Keys", href: "/dashboard/settings/api-keys" },
];

function cn(...classes: (string | false | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}

export default function SettingsTabs() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const org = searchParams.get("org");

  function hrefFor(base: string) {
    return org ? `${base}?org=${org}` : base;
  }

  return (
    <div className="flex gap-1 border-b border-border-default px-4 pt-4 sm:px-8">
      {tabs.map((t) => {
        const active =
          t.href === "/dashboard/settings"
            ? pathname === "/dashboard/settings"
            : pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={hrefFor(t.href)}
            className={cn(
              "relative px-3 py-2 text-sm transition-colors",
              active
                ? "text-fg-primary"
                : "text-fg-tertiary hover:text-fg-primary"
            )}
          >
            {t.label}
            {active && (
              <span className="absolute inset-x-3 -bottom-px h-px bg-accent-green" />
            )}
          </Link>
        );
      })}
    </div>
  );
}
