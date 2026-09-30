"""Native local file dialogs, isolated from the MCP loop and CAD kernel."""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
import threading

PICKER_TIMEOUT_SECONDS = 120
_MAC_SCRIPT = r'''
ObjC.import('AppKit');
const app = $.NSApplication.sharedApplication;
app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
app.activateIgnoringOtherApps(true);
const panel = $.NSOpenPanel.openPanel;
panel.title = 'Open Model';
panel.prompt = 'Open';
panel.canChooseDirectories = false;
panel.canChooseFiles = true;
panel.allowsMultipleSelection = false;
panel.allowedFileTypes = $(['step', 'stp', 'stl', 'glb', '3mf']);
panel.runModal == $.NSModalResponseOK
    ? JSON.stringify({path: ObjC.unwrap(panel.URL.path)})
    : JSON.stringify({cancelled: true});
'''
_WINDOWS_SCRIPT = r'''
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$owner = New-Object System.Windows.Forms.Form
try {
    $owner.TopMost = $true
    $owner.ShowInTaskbar = $false
    $owner.StartPosition = 'CenterScreen'
    $owner.Width = 1
    $owner.Height = 1
    $owner.Opacity = 0
    $owner.Show()
    $owner.Activate()
    $dialog.Title = 'Open Model'
    $dialog.Filter = 'CAD models (*.step;*.stp;*.stl;*.glb;*.3mf)|*.step;*.stp;*.stl;*.glb;*.3mf'
    $dialog.Multiselect = $false
    $dialog.CheckFileExists = $true
    if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
        @{path=$dialog.FileName} | ConvertTo-Json -Compress
    } else { @{cancelled=$true} | ConvertTo-Json -Compress }
} finally { $dialog.Dispose(); $owner.Close(); $owner.Dispose() }
'''


class PickerError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.retryable = False


def _command() -> tuple[list[str], bool]:
    """Arguments and whether stdout is structured JSON; never run a shell."""
    if sys.platform == "darwin":
        executable = shutil.which("osascript")
        if executable:
            return [executable, "-l", "JavaScript", "-e", _MAC_SCRIPT], True
    elif sys.platform == "win32":
        executable = shutil.which("powershell.exe") or shutil.which("pwsh.exe")
        if executable:
            return [executable, "-NoProfile", "-STA", "-NonInteractive", "-Command", _WINDOWS_SCRIPT], True
    elif sys.platform.startswith("linux"):
        if not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
            raise PickerError("FILE_PICKER_UNAVAILABLE", "Open Model needs a local graphical desktop. Open the CAD file through your host's file browser instead.")
        executable = shutil.which("zenity")
        if executable:
            return [executable, "--file-selection", "--title=Open Model", "--file-filter=CAD models | *.step *.stp *.stl *.glb *.3mf *.STEP *.STP *.STL *.GLB *.3MF"], False
        executable = shutil.which("kdialog")
        if executable:
            return [executable, "--title", "Open Model", "--getopenfilename", os.path.expanduser("~"), "CAD models (*.step *.stp *.stl *.glb *.3mf *.STEP *.STP *.STL *.GLB *.3MF)"], False
    raise PickerError("FILE_PICKER_UNAVAILABLE", "No native CAD file chooser is available. macOS requires osascript, Windows requires PowerShell, and Linux requires zenity or kdialog on a graphical desktop.")


def picker_capability() -> dict:
    try:
        _command()
        return {"supported": True}
    except PickerError as error:
        return {"supported": False, "reason": str(error)}


class FilePicker:
    def __init__(self):
        self._active = threading.Lock()

    async def choose(self) -> str | None:
        if not self._active.acquire(blocking=False):
            raise PickerError("FILE_PICKER_BUSY", "A CAD file chooser is already open. Choose a file or cancel that dialog first.")
        spawn = None
        process = None
        communication = None
        try:
            arguments, structured = _command()
            # Shield spawn so cancellation cannot abandon a child between its
            # creation and obtaining the process handle needed for cleanup.
            spawn = asyncio.create_task(asyncio.create_subprocess_exec(
                *arguments, stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            ))
            process = await asyncio.shield(spawn)
            communication = asyncio.create_task(process.communicate())
            try:
                stdout, stderr = await asyncio.wait_for(asyncio.shield(communication), PICKER_TIMEOUT_SECONDS)
            except asyncio.TimeoutError as error:
                raise PickerError("FILE_PICKER_TIMEOUT", "The CAD file chooser timed out and was closed. Select Open Model to try again.") from error
            try:
                output = stdout.decode("utf-8-sig").rstrip("\r\n")
            except UnicodeDecodeError as error:
                raise PickerError("FILE_PICKER_FAILED", "The native file chooser returned an unreadable filename. Try Open Model again.") from error
            if not structured and process.returncode == 1 and not output and not stderr.strip():
                return None
            if process.returncode != 0:
                detail = stderr.decode("utf-8", errors="replace").strip()[:1000]
                raise PickerError("FILE_PICKER_FAILED", "The native CAD file chooser could not open. Check that a graphical desktop is available. " + detail)
            if structured:
                try:
                    result = json.loads(output)
                    if isinstance(result, dict) and result.get("cancelled") is True:
                        return None
                    output = result.get("path") if isinstance(result, dict) else None
                except ValueError as error:
                    raise PickerError("FILE_PICKER_FAILED", "The native file chooser returned an invalid response. Try Open Model again.") from error
            if not isinstance(output, str) or not output:
                raise PickerError("FILE_PICKER_FAILED", "The native file chooser did not return a file. Try Open Model again.")
            return output
        except OSError as error:
            raise PickerError("FILE_PICKER_FAILED", f"The native file chooser could not start: {error}") from error
        finally:
            # MCP cancellation uses AnyIO cancel scopes. Shield cleanup from
            # that scope as well as the original asyncio task cancellation.
            import anyio
            with anyio.CancelScope(shield=True):
                try:
                    if process is None and spawn is not None and not (spawn.done() and spawn.exception() is not None):
                        process = await asyncio.shield(spawn)
                    if process is not None and process.returncode is None:
                        try:
                            process.terminate()
                        except ProcessLookupError:
                            pass
                        try:
                            await asyncio.wait_for(process.wait(), 2)
                        except asyncio.TimeoutError:
                            try:
                                process.kill()
                            except ProcessLookupError:
                                pass
                            await process.wait()
                    if communication is not None:
                        await communication
                finally:
                    self._active.release()
