import { MotionConfig } from "motion/react";
import { useEffect } from "react";

import { CommandPalette } from "@renderer/app/CommandPalette";
import { Shell } from "@renderer/app/Shell";
import { Welcome } from "@renderer/features/onboarding/Welcome";
import { SettingsRoute } from "@renderer/features/settings/SettingsRoute";
import { useApplyAppearance } from "@renderer/hooks/use-appearance";
import { useSettingsShortcuts } from "@renderer/hooks/use-settings-shortcuts";
import { useApplyTheme } from "@renderer/hooks/use-theme";
import { Toaster } from "@renderer/components/ui/sonner";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { hydrate, subscribeToMain } from "@renderer/state/bridge";
import { useSettings } from "@renderer/state/settings";
import { useShowWelcome } from "@renderer/state/onboarding";
import { useUi } from "@renderer/state/ui";

/**
 * The window. Three full-window routes — the three-pane shell, Settings and
 * the first-run welcome — plus the palette and the toaster, which belong to
 * none of them.
 */
export function App() {
  const route = useUi((state) => state.route);
  // First run: the welcome covers the shell until it is finished or skipped.
  const showWelcome = useShowWelcome();
  useApplyTheme();
  // The accent, the UI scale, the code font, reduced motion and the
  // translucent sidebar are tokens on <html> (Settings › Appearance).
  useApplyAppearance();
  useSettingsShortcuts();
  const reduceMotion = useSettings((state) => state.settings?.reduceMotion ?? false);

  useEffect(() => {
    const detach = subscribeToMain();
    void hydrate();
    return detach;
  }, []);

  return (
    // The `.reduce-motion` class only reaches CSS animations; the JS ones (the
    // shimmer's sweep) read this. The setting wins, the OS is the fallback.
    <MotionConfig reducedMotion={reduceMotion ? "always" : "user"}>
      <TooltipProvider delayDuration={300}>
        {route === "settings" ? <SettingsRoute /> : showWelcome ? <Welcome /> : <Shell />}
        <CommandPalette />
        {/* Top right, under the title strip: the composer is centred at the
            bottom, and a toast in the bottom corner sat on its send button and
            chips — the refusal of a prompt over the very box that kept it. */}
        <Toaster offset={{ top: "calc(var(--titlebar-height) + 8px)", right: 16 }} position="top-right" />
      </TooltipProvider>
    </MotionConfig>
  );
}
