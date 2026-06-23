# Kairos Volc Voiceover for DaVinci Resolve

DaVinci Resolve Edit-page script for selecting subtitle items, synthesizing
voiceover with Volcengine TTS / voice clone, and inserting the generated audio
back into the current timeline.

## Install

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
- Lets the editor type subtitle IDs from the list, or select by playhead /
  Resolve timeline In/Out. The Lua UI intentionally uses this stable ID field
  first while Resolve 21 script-menu UI behavior is being hardened.
- Uses a compact voice profile selector backed by workspace global
  `config/runtime.json`.
- Synthesizes one audio file per selected subtitle.
- Inserts generated audio into an audio track named `Kairos VO`.
- Stores generated files and manifests under:

```text
~/Movies/KairosVoiceover/<project>/<timeline>/<runId>/
```

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

## Volcengine Defaults

- TTS endpoint: `https://openspeech.bytedance.com/api/v3/tts/unidirectional`
- Default resource id: `seed-icl-2.0` for cloned voices
- Official voices can use `seed-tts-2.0`
- Clone endpoint: `https://openspeech.bytedance.com/api/v3/tts/voice_clone`

The plugin uses `X-Api-Key`, `X-Api-Resource-Id`, and `X-Api-Request-Id`
headers for synthesis requests.

## Limitations

Resolve scripting does not expose stable Edit-page selected subtitle timeline
items. Selection is therefore maintained inside the plugin UI. The playhead and
Resolve In/Out buttons are shortcuts that select matching subtitle rows. Set the
In/Out range in Resolve itself with `I` and `O`; the plugin reads that existing
range with `GetMarkInOut()`.

Resolve subtitle text access is version-sensitive. If the current Resolve build
does not expose subtitle text through `GetName()`, `GetProperty()`, or
`GetClipProperty()`, the plugin blocks synthesis rather than guessing text.

Startup errors are written to:

```text
~/Movies/KairosVoiceover/logs/lua-plugin.log
~/Movies/KairosVoiceover/logs/resolve-plugin.log
~/Movies/KairosVoiceover/logs/resolve-plugin-bootstrap.log
```

## Debug Smoke Test

With Resolve running, this creates or reuses a throwaway project named
`Kairos Volc Voiceover Debug`, creates a debug timeline, creates a local WAV
tone, and inserts it through the same bridge used by the plugin:

```bash
python3 apps/resolve-volc-voiceover-plugin/debug_resolve_plugin.py
```
