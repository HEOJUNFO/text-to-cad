import { useState } from "react";
import { ArrowRight, Box, Check, FolderOpen, Loader2 } from "lucide-react";

import { Button } from "@renderer/components/ui/button";
import { AgentRow, isAgentReady, useOfferedAgents } from "@renderer/features/session/agent-setup";
import { useOpenFolder } from "@renderer/hooks/use-open-folder";
import { cn } from "@renderer/lib/utils";
import { useAgents } from "@renderer/state/agents";
import { useSettings } from "@renderer/state/settings";
import { useUi } from "@renderer/state/ui";
import textToCadMark from "@renderer/assets/brand/text-to-cad-star.svg";

/**
 * The first-run welcome: three short steps over the whole window, shown once.
 * Finishing or skipping it sets `onboardingCompleted`, and the sidebar's
 * Getting started checklist picks up from there.
 */
export function Welcome() {
  const [step, setStep] = useState(0);
  const patch = useSettings((state) => state.patch);
  const finish = () => void patch({ onboardingCompleted: true });
  // On the agent step, Continue says what it means when nothing can run yet:
  // the rest of the app opens, but a session will not start until one is.
  const anyAgentReady = useAgents((state) => state.agents.some(isAgentReady));
  const continueLabel = step === 1 && !anyAgentReady ? "Continue without an agent" : "Continue";

  return (
    <div className="flex h-full flex-col bg-background" data-onboarding>
      {/* The welcome replaces the shell, so this strip is the window's top
          edge: the title bar's height, with the traffic lights' corner
          reserved the same way Settings' header reserves it. */}
      <div
        className="app-drag shrink-0"
        data-onboarding-titlebar
        style={{ height: "var(--titlebar-height)", paddingLeft: "var(--titlebar-inset)" }}
      />
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto px-6 pb-10">
        <div className="w-full max-w-md">
          {step === 0 ? <WelcomeStep /> : step === 1 ? <AgentStep /> : <StartStep onDone={finish} />}

          <div className="mt-8 flex items-center justify-between">
            <StepDots count={3} current={step} />
            <div className="flex items-center gap-2">
              {step > 0 ? (
                <Button className="text-muted-foreground" onClick={() => setStep(step - 1)} size="sm" variant="ghost">
                  Back
                </Button>
              ) : null}
              <Button className="text-muted-foreground" onClick={finish} size="sm" variant="ghost">
                Skip for now
              </Button>
              {step < 2 ? (
                <Button className="gap-1.5" onClick={() => setStep(step + 1)} size="sm">
                  {continueLabel}
                  <ArrowRight className="size-3.5" />
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function WelcomeStep() {
  return (
    <section aria-labelledby="onboarding-title">
      <img alt="" className="size-12 object-contain" src={textToCadMark} />
      <h1 className="mt-5 text-2xl font-medium tracking-tight" id="onboarding-title">
        Welcome to text-to-cad
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Describe a part and an AI agent builds it as real CAD you can open, measure and export.
      </p>
      <ul className="mt-6 space-y-3 text-sm">
        <Point title="Session in the middle">The agent writes a script and builds the part in your folder.</Point>
        <Point title="Model on the right">Every STEP, STL and drawing opens in the built-in viewer.</Point>
        <Point title="Point at what to change">Select a face or edge and Annotate it.</Point>
      </ul>
    </section>
  );
}

function Point({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <Check className="mt-0.5 size-4 shrink-0 text-primary" />
      <span>
        <span className="font-medium">{title}.</span> <span className="text-muted-foreground">{children}</span>
      </span>
    </li>
  );
}

function AgentStep() {
  const detected = useAgents((state) => state.ready);
  const offered = useOfferedAgents();
  const openSettings = useUi((state) => state.openSettings);

  return (
    <section aria-labelledby="onboarding-agent-title">
      <h1 className="text-2xl font-medium tracking-tight" id="onboarding-agent-title">
        Connect an agent
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        text-to-cad runs the coding agent you already use. You need one of these, installed and signed in.
      </p>
      <div className="mt-6 space-y-2">
        {!detected && offered.length === 0 ? (
          <p className="text-sm text-muted-foreground" role="status">
            Looking for agents on this machine…
          </p>
        ) : null}
        {offered.map((agent) => (
          <AgentRow agent={agent} key={agent.id} />
        ))}
      </div>
      <button
        className="mt-3 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        onClick={() => openSettings("agents")}
        type="button"
      >
        Use a different agent in Settings › Agents
      </button>
    </section>
  );
}

function StartStep({ onDone }: { onDone: () => void }) {
  const openFolder = useOpenFolder();
  const [busy, setBusy] = useState<"sample" | "folder" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const trySample = async () => {
    setBusy("sample");
    setError(null);
    try {
      const { path } = await window.textToCad.onboarding.createSample();
      // Main broadcasts the selection, which opens the folder's new-session screen.
      await window.textToCad.projects.addPath({ path });
      onDone();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const chooseFolder = async () => {
    setBusy("folder");
    setError(null);
    try {
      if (await openFolder()) {
        onDone();
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby="onboarding-start-title">
      <h1 className="text-2xl font-medium tracking-tight" id="onboarding-start-title">
        Where do you want to start?
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        A session always belongs to a folder. The agent reads and writes files there.
      </p>
      <div className="mt-6 grid gap-2">
        <StartOption
          busy={busy === "sample"}
          description="An L-bracket to open, change and export. Copied to Documents › text-to-cad Sample."
          disabled={busy !== null}
          icon={<Box className="size-4" />}
          onClick={() => void trySample()}
          title="Try the sample"
        />
        <StartOption
          busy={busy === "folder"}
          description="Start in a folder of your own, empty or not."
          disabled={busy !== null}
          icon={<FolderOpen className="size-4" />}
          onClick={() => void chooseFolder()}
          title="Open a folder…"
        />
      </div>
      {error ? <p className="mt-3 text-xs text-destructive">{error}</p> : null}
    </section>
  );
}

function StartOption({
  title,
  description,
  icon,
  busy,
  disabled,
  onClick,
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className="flex items-start gap-3 rounded-lg border px-3 py-3 text-left transition-colors hover:bg-muted/60 disabled:opacity-60"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <span className="mt-0.5 text-muted-foreground">{busy ? <Loader2 className="size-4 animate-spin" /> : icon}</span>
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
    </button>
  );
}

function StepDots({ count, current }: { count: number; current: number }) {
  return (
    <div aria-label={`Step ${current + 1} of ${count}`} className="flex items-center gap-1.5" role="img">
      {Array.from({ length: count }, (_, index) => (
        <span
          className={cn("size-1.5 rounded-full", index === current ? "bg-foreground" : "bg-muted-foreground/30")}
          key={index}
        />
      ))}
    </div>
  );
}
