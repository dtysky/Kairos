#!/usr/bin/env python3
from __future__ import annotations

import sys
import time
import traceback
from pathlib import Path


def probe_log(message):
    try:
        log_dir = Path.home() / "Movies" / "KairosVoiceover" / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        with (log_dir / "script-probe.log").open("a", encoding="utf-8") as handle:
            handle.write(time.strftime("[%Y-%m-%d %H:%M:%S] "))
            handle.write(str(message))
            handle.write("\n")
    except Exception:
        pass


try:
    probe_log(
        "probe start "
        + f"file={globals().get('__file__', '<missing>')} "
        + f"cwd={Path.cwd()} "
        + f"argv={sys.argv} "
        + f"has_resolve={'resolve' in globals()} "
        + f"has_fusion={'fusion' in globals()} "
        + f"has_bmd={'bmd' in globals()}"
    )
    current_resolve = globals().get("resolve")
    current_fusion = globals().get("fusion")
    current_bmd = globals().get("bmd")
    if current_resolve is None:
        try:
            import DaVinciResolveScript as dvr_script
        except ImportError:
            modules = "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/Modules"
            if modules not in sys.path:
                sys.path.append(modules)
            import DaVinciResolveScript as dvr_script
        current_bmd = current_bmd or dvr_script
        current_resolve = dvr_script.scriptapp("Resolve")
    if current_fusion is None and current_resolve is not None:
        current_fusion = current_resolve.Fusion()
    probe_log(
        "probe resolved "
        + f"resolve={bool(current_resolve)} "
        + f"fusion={bool(current_fusion)} "
        + f"bmd={bool(current_bmd)}"
    )
    if current_fusion is not None and current_bmd is not None:
        ui = current_fusion.UIManager
        dispatcher = current_bmd.UIDispatcher(ui)
        win = dispatcher.AddWindow(
            {
                "ID": "com.dtysky.kairos.scriptprobe",
                "Geometry": [160, 160, 420, 160],
                "WindowTitle": "Kairos Script Probe",
            },
            ui.VGroup(
                [
                    ui.Label({"Text": "Kairos Script Probe OK", "Weight": 0}),
                    ui.Button({"ID": "close", "Text": "Close"}),
                ]
            ),
        )

        def on_close(ev):
            dispatcher.ExitLoop()

        win.On["com.dtysky.kairos.scriptprobe"].Close = on_close
        win.On["close"].Clicked = on_close
        win.Show()
        probe_log("probe window shown")
        dispatcher.RunLoop()
except Exception:
    probe_log(traceback.format_exc())
    raise
