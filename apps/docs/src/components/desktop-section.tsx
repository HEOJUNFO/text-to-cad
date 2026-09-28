import { Download, ExternalLink } from "lucide-react";
import { formatSize, getDesktopDownloads } from "@/lib/desktop-downloads";

/**
 * The desktop app, downloadable: one button per platform from the latest
 * release, or, while no release carries installers yet, a line saying where
 * they will appear. The section reads like the others on the page: a heading,
 * a sentence, then the thing itself.
 */
export async function DesktopSection() {
  const downloads = await getDesktopDownloads();
  return (
    <section id="desktop" aria-labelledby="desktop-title" className="scroll-mt-20 space-y-3 py-6">
      <div>
        <h2 id="desktop-title" className="text-heading font-medium tracking-normal text-foreground">
          DESKTOP APP
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
          text-to-cad as an app: your folders on the left, the agent in the middle, a CAD viewer on
          the right. cadgen and every skill ship inside it, so nothing installs on first launch.
          Open a STEP, annotate a face, and ask for the change.
        </p>
      </div>

      {downloads.installers.length > 0 ? (
        <div className="grid min-w-0 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {downloads.installers.map((installer) => (
            <a
              key={installer.id}
              className="card-glow flex min-w-0 items-center gap-3 border border-border bg-card px-3.5 py-3 transition hover:bg-secondary/60"
              href={installer.url}
              data-desktop-installer={installer.id}
            >
              <Download className="size-4 shrink-0 text-primary" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-foreground">{installer.platform}</span>
                <span className="block text-label uppercase tracking-[1.5px] text-muted-foreground">{installer.detail}</span>
              </span>
              <span className="shrink-0 text-label text-muted-foreground">{formatSize(installer.size)}</span>
            </a>
          ))}
        </div>
      ) : (
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground" data-desktop-installers="none">
          Installers for macOS, Windows and Linux are attached to each release once the app is in
          it. Watch the{" "}
          <a
            className="inline-flex items-center gap-1 text-primary transition hover:text-primary/80"
            href={downloads.releaseUrl}
            rel="noreferrer"
            target="_blank"
          >
            releases page
            <ExternalLink className="size-3" aria-hidden="true" />
          </a>
          , or build it from the repository with <code className="text-foreground">npm run package:mac</code>.
        </p>
      )}

      <p className="text-sm leading-6 text-muted-foreground">
        {downloads.version ? (
          <>
            <span className="text-foreground">Version {downloads.version}.</span>{" "}
          </>
        ) : null}
        The app checks these same releases for updates and asks before it downloads one. macOS
        builds are not yet signed: control-click the app and choose Open the first time.{" "}
        <a
          className="inline-flex items-center gap-1 text-primary transition hover:text-primary/80"
          href={downloads.releaseUrl}
          rel="noreferrer"
          target="_blank"
        >
          All releases
          <ExternalLink className="size-3" aria-hidden="true" />
        </a>
      </p>
    </section>
  );
}
