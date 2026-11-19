import type { ResolvedAppearance } from "@rakazo/ui-tokens";
import { useSyncExternalStore } from "react";

function currentAppearance(): ResolvedAppearance {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function subscribeAppearance(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

/** The page's appearance, redrawn when the theme attribute changes. */
export function useWebAppearance(): ResolvedAppearance {
  return useSyncExternalStore<ResolvedAppearance>(
    subscribeAppearance,
    currentAppearance,
    () => "dark",
  );
}
