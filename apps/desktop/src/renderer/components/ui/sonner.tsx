import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

// shadcn ships this component reading `next-themes`. text-to-cad owns its theme
// in the settings store (system/light/dark, applied as a `.dark` class on
// <html>), so it reads that instead and `next-themes` is not a dependency.
import { useResolvedTheme } from "@renderer/hooks/use-theme"
import { isMac } from "@renderer/lib/platform"

const Toaster = ({ ...props }: ToasterProps) => {
  const theme = useResolvedTheme()

  return (
    <Sonner
      theme={theme}
      className="toaster group"
      // Deliberate edit to the vendored component: stock is Alt+T, and Option+T types "†" on a
      // Mac keyboard, so the toast list stole focus from a sentence being typed. Mod+Alt+T types
      // nothing, and sits beside Mod+Alt+B (toggle explorer).
      hotkey={[isMac ? "metaKey" : "ctrlKey", "altKey", "KeyT"]}
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
