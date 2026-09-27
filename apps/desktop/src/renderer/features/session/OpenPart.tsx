import { useEffect, useState } from "react";
import { Box, FolderOpen, Loader2 } from "lucide-react";
import { cn } from "cn";

import { CAD_EXTENSIONS } from "@shared/cad-refs";
import type { Project } from "@shared/types";

import { loadParts, type Part } from "./open-part";

/**
 * The other door on the new-session screen: a part to open rather than a
 * prompt to send (plan §2, revised). The composer above it assumes every
 * session starts with "build me X"; a folder of STEPs or yesterday's output
 * starts with "here is the part". Without this row the only way to look at
 * geometry was to describe it to the agent.
 *
 * One line of chips — the folder's CAD files — and `Open file…`, the native
 * chooser, for one of them by path. Nothing else: this is not the grid of
 * canned prompts the screen refuses to have, because every chip is a file
 * that exists.
 *
 * Choosing one hands the path to `onOpen`; `NewSession` creates the session
 * and opens it there. The chooser answers with an absolute path, which
 * `NewSession` checks is one of the folder's before opening it.
 */
export function OpenPart({
  project,
  disabled,
  onOpen,
  onPick,
}: {
  project: Project;
  disabled: boolean;
  /** A listed part: root-relative to the project. */
  onOpen: (part: Part) => Promise<void>;
  /** A chosen file: its absolute path. */
  onPick: (source: string) => Promise<void>;
}) {
  // What was loaded, and for which folder: a load that answers after the
  // folder changed is not this folder's row, and a row for a folder that
  // has not answered yet is empty rather than the last folder's.
  const [loaded, setLoaded] = useState<{ projectId: string; parts: Part[] } | null>(null);
  const parts = loaded?.projectId === project.id ? loaded.parts : null;
  const [opening, setOpening] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadParts(project.id).then((answer) => {
      if (!cancelled) setLoaded({ projectId: project.id, parts: answer });
    });
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  const open = async (part: Part) => {
    setOpening(part.path);
    try {
      await onOpen(part);
    } finally {
      setOpening(null);
    }
  };

  const pick = async () => {
    const chosen = await window.hardcore.dialogs.chooseFile({
      title: `Open a part in ${project.name}`,
      defaultPath: project.path,
      filters: [
        { name: "CAD files", extensions: [...CAD_EXTENSIONS] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (!chosen) return;
    setOpening(chosen.path);
    try {
      await onPick(chosen.path);
    } finally {
      setOpening(null);
    }
  };

  const busy = disabled || opening !== null;
  return (
    <div className="mt-4 flex flex-wrap items-center gap-1.5 px-1" data-open-part>
      <span className="mr-0.5 text-[12px] text-muted-foreground">
        {parts && parts.length > 0 ? "Or open a part" : "Or open a part in this folder"}
      </span>
      {parts?.map((part) => (
        <PartChip
          busy={opening === part.path}
          disabled={busy}
          key={part.path}
          onClick={() => void open(part)}
          part={part}
        />
      ))}
      <button
        className={cn(
          "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-dashed px-2 text-[12px] leading-none text-muted-foreground transition-colors",
          "hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50",
        )}
        data-open-part-file
        disabled={busy}
        onClick={() => void pick()}
        title="Open a STEP, STL, GLB, 3MF, DXF or robot description from this folder"
        type="button"
      >
        {opening !== null && !parts?.some((part) => part.path === opening) ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <FolderOpen className="size-3.5" />
        )}
        Open file…
      </button>
    </div>
  );
}

function PartChip({
  part,
  busy,
  disabled,
  onClick,
}: {
  part: Part;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={cn(
        "inline-flex h-7 max-w-[200px] shrink-0 items-center gap-1.5 rounded-md border px-2 text-[12px] leading-none text-foreground/90 transition-colors",
        "hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50",
      )}
      data-open-part-chip
      disabled={disabled}
      onClick={onClick}
      // The name is what a person picks by; the path is a hover away.
      title={part.path}
      type="button"
    >
      {busy ? <Loader2 className="size-3.5 shrink-0 animate-spin" /> : <Box className="size-3.5 shrink-0" />}
      <span className="truncate">{part.name}</span>
    </button>
  );
}
