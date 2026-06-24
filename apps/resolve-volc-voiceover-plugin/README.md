# Kairos Volc Voiceover for DaVinci Resolve

DaVinci Resolve Edit-page script for selecting subtitle items, synthesizing
voiceover with Volcengine TTS / voice clone, and inserting the generated audio
back into the current timeline.

## Install

On Windows:

```powershell
.\apps\resolve-volc-voiceover-plugin\install_windows.ps1
```

The installer copies the script files to:

```text
%APPDATA%\Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts\Edit\KairosVolcVoiceover.lua
%APPDATA%\Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts\Edit\KairosVolcVoiceoverLib\
```

It also writes `KairosVolcVoiceoverLib\kairos_workspace.json` with the current
workspace, runtime config path, and Python executable. The Lua menu script uses
that Python executable on Windows instead of macOS `/usr/bin/python3`. Set
`KAIROS_PYTHON` before running the installer if Resolve should use a specific
Python executable. The Windows Lua-to-Python bridge forces UTF-8 stdout so
Chinese profile names from `config/runtime.json` render correctly in the
Resolve panel.

On macOS:

```bash
apps/resolve-volc-voiceover-plugin/install_macos.sh
```

The installer copies the script files to:

```text
/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Edit/KairosVolcVoiceover.lua
/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Edit/KairosVolcVoiceoverLib/
```

It also writes `KairosVolcVoiceoverLib/kairos_workspace.json`, pointing the
installed plugin back to this Kairos workspace so it can read global
`config/runtime.json`.

If the system-level Resolve scripts directory is not writable, the installer
falls back to the same path under `~/Library/Application Support/...`.

Restart Resolve, then open:

```text
Workspace -> Scripts -> Edit -> KairosVolcVoiceover
```

The Resolve menu entry is Lua on purpose. Resolve's Lua script menu path is more
reliable on Resolve 21, so the visible panel runs as a Lua/Fusion UI script.
Python remains as a headless backend for Volcengine synthesis and Resolve
timeline insertion.

For menu/UI diagnostics, install the probe scripts explicitly:

```bash
KAIROS_INSTALL_PROBES=1 apps/resolve-volc-voiceover-plugin/install_macos.sh
```

## Behavior

- Scans all current timeline subtitle tracks.
- Lets the editor select subtitle rows directly in a multi-select list
  (`Shift` range select / `Cmd` additive select), locate the playhead subtitle,
  select the Resolve timeline In/Out range, or clear the current selection.
  Playhead locate checks Resolve timecode with timeline start offsets before
  matching subtitle item frame ranges, and reports the nearest subtitle gap
  when no row covers the playhead.
- Uses a compact voice profile selector backed by workspace global
  `config/runtime.json`.
- Synthesizes one audio file for a single selected subtitle, or one merged
  audio file for all selected subtitles when multiple rows are selected.
- Imports generated audio into Media Pool bin `Kairos Voiceover / <timeline>`.
  Timeline insertion prefers the lowest empty enabled audio track from A2
  upward, then reuses a non-overlapping `Kairos VO` track, then creates a new
  `Kairos VO` track only when no existing track is safe to use.
- The Resolve panel exposes insertion as the normal paid-generation path; the
  backend preview mode is kept only for command-line debugging.
- Stores generated media under the matched Kairos project's
  `config/project-brief.json` `voiceoverMedia` root:

```text
<voiceoverMedia.path-or-alternate>/<safe Resolve project>/<safe timeline>/
```

The media directory intentionally contains only Resolve-importable audio:

```text
vo_<unit>_<request>.mp3
```

Request / insertion debug JSON is project-local under
`projects/<projectId>/.tmp/resolve-volc-voiceover-plugin/manifests/`; it is not
part of the media relink surface.

Volcengine API key and registered voice profiles are configured globally in:

```text
config/runtime.json
```

Example:

```json
{
  "voiceover": {
    "volcApiKey": "YOUR_VOLCENGINE_API_KEY",
    "defaultProfile": "genie_cn_clone",
    "profiles": [
      {
        "name": "genie_cn_clone",
        "displayName": "格聂女声复刻",
        "resourceId": "seed-icl-2.0",
        "speakerId": "YOUR_SPEAKER_ID",
        "language": "zh-cn",
        "model": "",
        "defaultSpeed": 1,
        "defaultLoudness": 1,
        "contextText": "自然、纪录片旁白、克制"
      }
    ]
  }
}
```

Generated audio output is configured per project, so different workstations can
use different mounted drives and relink by the same root-relative paths:

```json
{
  "name": "丙察察格涅南线子梅垭口穿越",
  "voiceoverMedia": {
    "rootId": "voiceover",
    "path": "/Volumes/SSDMAX/kairos-voiceover",
    "alternatePaths": [
      { "path": "F:\\kairos-voiceover" }
    ],
    "resolveProjectAliases": [
      "Kairos Volc Voiceover Debug"
    ],
    "description": "Resolve 字幕配音生成音频"
  }
}
```

The plugin matches the current Resolve project name to a Kairos project brief
name, also accepting Resolve suffixes such as ` [Edit]` or ` [Color]`. If no
unique project matches, or no configured `voiceoverMedia` candidate is writable,
synthesis is blocked instead of writing formal audio files to a fallback folder.
Use `voiceoverMedia.resolveProjectAliases[]` for throwaway Resolve projects
that should intentionally write to this Kairos project's voiceover root.
Lua/Python bridge job files and plugin logs are project-local:

```text
projects/<projectId>/.tmp/resolve-volc-voiceover-plugin/cache/
projects/<projectId>/.tmp/resolve-volc-voiceover-plugin/jobs/
projects/<projectId>/.tmp/resolve-volc-voiceover-plugin/logs/
projects/<projectId>/.tmp/resolve-volc-voiceover-plugin/manifests/
```

## Volcengine Defaults

- TTS endpoint: `https://openspeech.bytedance.com/api/v3/tts/unidirectional`
- Default resource id: `seed-icl-2.0` for cloned voices
- Official voices can use `seed-tts-2.0`
- Clone endpoint: `https://openspeech.bytedance.com/api/v3/tts/voice_clone`

The plugin uses `X-Api-Key`, `X-Api-Resource-Id`, and `X-Api-Request-Id`
headers for synthesis requests.

## Limitations

Resolve scripting does not expose stable Edit-page selected subtitle timeline
items. Selection is therefore maintained in the plugin's subtitle list. The
playhead button scrolls to and selects the subtitle covering the current
playhead frame; Resolve In/Out selects matching subtitle rows in bulk. Set the
In/Out range in Resolve itself with `I` and `O`; the plugin reads that existing
range with `GetMarkInOut()`.

Resolve subtitle text access is version-sensitive. If the current Resolve build
does not expose subtitle text through `GetName()`, `GetProperty()`, or
`GetClipProperty()`, the plugin blocks synthesis rather than guessing text.

Startup errors are written to:

```text
projects/<projectId>/.tmp/resolve-volc-voiceover-plugin/logs/lua-plugin.log
projects/<projectId>/.tmp/resolve-volc-voiceover-plugin/logs/resolve-plugin.log
projects/<projectId>/.tmp/resolve-volc-voiceover-plugin/logs/resolve-plugin-bootstrap.log
```

If Resolve is launched without a project that can be matched to a Kairos project
brief, early bootstrap logs fall back to workspace `.tmp/resolve-volc-voiceover-plugin/`.

## Debug Smoke Test

With Resolve running, this creates or reuses a throwaway project named
`Kairos Volc Voiceover Debug`, creates a debug timeline, creates a local WAV
tone, and inserts it through the same bridge used by the plugin:

```bash
python3 apps/resolve-volc-voiceover-plugin/debug_resolve_plugin.py
```
