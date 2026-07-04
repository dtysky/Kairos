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
%APPDATA%\Blackmagic Design\DaVinci Resolve\Support\Fusion\Config\KairosVolcVoiceover\kairos_workspace.json
```

Only the Lua script is installed under `Scripts\Edit`; the workspace link lives
under `Fusion\Config\KairosVolcVoiceover` so Resolve does not show it as a
Scripts menu folder. The workspace link stores the current workspace, runtime
config path, and local Supervisor URL. The plugin expects the
Kairos Supervisor to be running at `http://127.0.0.1:8940`; it no longer installs
or requires a Python backend.

On macOS:

```bash
apps/resolve-volc-voiceover-plugin/install_macos.sh
```

The installer copies the script files to:

```text
~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Edit/KairosVolcVoiceover.lua
~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Config/KairosVolcVoiceover/kairos_workspace.json
```

Only the Lua script is installed under `Scripts/Edit`; the workspace link lives
under `Fusion/Config/KairosVolcVoiceover` so Resolve does not show it as a
Scripts menu folder. The installer also removes legacy Kairos Voiceover script
copies from both user-level and system-level Resolve script directories before
installing the current user-level copy.

Restart Resolve, then open:

```text
Workspace -> Scripts -> Edit -> KairosVolcVoiceover
```

The Resolve menu entry is Lua on purpose. Resolve's Lua script menu path is more
reliable on Resolve 21, so the visible panel runs as a Lua/Fusion UI script.
Lua calls the local Kairos Supervisor TSV API for synthesis, then performs the
Resolve Media Pool import and timeline insertion itself. When Resolve's Lua
runtime cannot open a local TCP/socket connection, the plugin uses a
Supervisor-managed workspace file IPC under
`.tmp/resolve-volc-voiceover-plugin/ipc/` instead of falling back to `.cmd`,
curl, or Python.

For menu/UI diagnostics, install the probe scripts explicitly:

```bash
KAIROS_INSTALL_PROBES=1 apps/resolve-volc-voiceover-plugin/install_macos.sh
```

## Behavior

- Enumerates the current timeline subtitle tracks and requires the editor to
  choose the narration subtitle track before synthesis. When there is only one
  subtitle track, the plugin selects it automatically; when there are multiple
  tracks, it starts on `Select narration track` so source-speech subtitles are
  not synthesized by accident.
- Lets the editor select subtitle rows directly in the plugin list, locate the
  playhead subtitle, select a plugin-managed range from the located row to a
  clicked end row, select the Resolve timeline In/Out range, or clear the
  current selection.
  The subtitle list, playhead locate, Resolve In/Out selection, and Insert all
  operate only on the selected subtitle track. Playhead locate checks Resolve
  timecode with timeline start offsets before matching subtitle item frame
  ranges, reports the nearest subtitle gap when no row covers the playhead, and
  only selects/scrolls the plugin-list row. It also becomes the plugin's range
  anchor: click the end row, press `Range`, then press `Insert`. The plugin
  keeps this range internally so synthesis does not depend on Fusion's native
  Shift-selection anchor. It does not try to select Resolve Edit-page subtitle
  timeline items.
- Uses a compact voice profile selector backed by the Supervisor summary of
  workspace global `config/runtime.json`.
- Synthesizes one audio file for a single selected subtitle, or one merged
  audio file for all selected subtitles when multiple rows are selected. Merged
  text strips terminal `。` / `.` from each subtitle line and never auto-adds a
  period; `？`, `！`, and internal punctuation are preserved.
- Imports generated audio into Media Pool bin `Kairos Voiceover / <timeline>`.
  Timeline insertion prefers the lowest empty enabled audio track from A2
  upward, then reuses a non-overlapping `Kairos VO` track, then creates a new
  `Kairos VO` track only when no existing track is safe to use.
- The Resolve panel exposes insertion as the normal paid-generation path.
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
Cache, manifests, and plugin logs are project-local:

```text
projects/<projectId>/.tmp/resolve-volc-voiceover-plugin/cache/
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
playhead frame and stores that row as the range anchor; the `Range` button then
selects every row from that anchor to the currently clicked row using the
plugin's own internal selection state. Resolve In/Out selects matching subtitle
rows in bulk. Set the In/Out range in Resolve itself with `I` and `O`; the
plugin reads that existing range with `GetMarkInOut()`. Locate does not set
Resolve In/Out and does not pretend to select native timeline items.

The plugin talks only to the local Kairos Supervisor. It prefers
`http://127.0.0.1:8940` via Lua TCP/HTTP, and falls back to workspace file IPC
when Resolve's Lua runtime has no socket/TCP module. Start the Kairos Supervisor
before synthesis. Missing Supervisor, missing IPC directories, ambiguous project
matching, and unwritable `voiceoverMedia` are hard blockers.

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

Start the Kairos Supervisor, install the plugin, open Resolve, choose:

```text
Workspace -> Scripts -> Edit -> KairosVolcVoiceover
```

Then refresh profiles, use Locate to select a subtitle row in the plugin list,
optionally click another row and press Range, and run Insert. Generated audio
should appear in Media Pool bin
`Kairos Voiceover / <timeline>` and on a `Kairos VO` audio track.
