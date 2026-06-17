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
/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Edit/Kairos Volc Voiceover
```

Restart Resolve, then open:

```text
Workspace -> Scripts -> Edit -> Kairos Volc Voiceover
```

## Behavior

- Scans all current timeline subtitle tracks.
- Lets the editor choose subtitles in the plugin list, or select by playhead /
  Mark In-Out.
- Shows a read-only subtitle ID list as a compatibility fallback; if the Resolve
  Tree widget selection misbehaves, type IDs such as `1,2,3` into the fallback
  field.
- Synthesizes one audio file per selected subtitle.
- Inserts generated audio into an audio track named `Kairos VO`.
- Stores generated files and manifests under:

```text
~/Movies/KairosVoiceover/<project>/<timeline>/<runId>/
```

API keys and speaker settings are stored only in the local plugin config:

```text
~/Movies/KairosVoiceover/config.local.json
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
Mark In-Out buttons are shortcuts that select matching subtitle rows.

Resolve subtitle text access is version-sensitive. If the current Resolve build
does not expose subtitle text through `GetName()`, `GetProperty()`, or
`GetClipProperty()`, the plugin blocks synthesis rather than guessing text.
