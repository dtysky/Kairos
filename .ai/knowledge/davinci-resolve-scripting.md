# DaVinci Resolve Scripting Local Documentation

This is Kairos' local working documentation for DaVinci Resolve scripting. It is not just
an index: agents should use it as the first local reference before touching Resolve export,
`/color`, the vendored Resolve host, DRX/DRT handling, render jobs, LUT sync, or Resolve
project/timeline automation.

## Sources And Freshness

- Local official docs, macOS: `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/README.txt`
- Local official docs, Windows: `%PROGRAMDATA%\Blackmagic Design\DaVinci Resolve\Support\Developer\Scripting\README.txt`
- Local official docs, Linux: `/opt/resolve/Developer/Scripting/README.txt`
- Online mirror requested by user: `https://gist.github.com/X-Raym/2f2bf453fc481b9cca624d7ca0e19de8`
- Online readable mirror from that Gist: `https://extremraym.com/cloud/resolve-scripting-doc/`
- Current checked local doc header: `Last Updated: 7 Oct 2025`
- Current checked Gist title: `DaVinci Resolve Scripting API Doc v20.3`
- Last checked in Kairos: `2026-04-24`

Rule of thumb: this local document is the Kairos starting point, but exact signatures must
still be verified against the installed Resolve `README.txt` before implementation when a
task depends on a method that may be version-sensitive.

## Mandatory Kairos Workflow For Resolve Tasks

1. Read this file before implementing any DaVinci Resolve scripting behavior.
2. Verify the exact method signature in the installed `README.txt` or the Gist mirror.
3. Prefer the same-machine vendored backend: `vendor/resolve-color-host/resolve-color-host.py`.
4. Do not route official `/color` or Resolve export automation through MCP wording or stale design assumptions.
5. If the official API lacks a getter or operation, record that limitation in code comments, tests, or docs instead of inventing a state.
6. For real Resolve behavior, validate with a running Resolve Studio instance; unit tests alone only validate our wrappers.

## Runtime And Import Bootstrap

Resolve must be running before external scripts can connect. External scripts normally import
`DaVinciResolveScript` and start from:

```python
import DaVinciResolveScript as dvr_script
resolve = dvr_script.scriptapp("Resolve")
```

On macOS, Kairos should append these locations when needed:

```text
/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting
/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/Modules
```

The official macOS library path is:

```text
/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so
```

Script menu install paths are useful for manual helpers, but Kairos official automation should
remain in the vendored backend:

```text
/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts
/Users/<UserName>/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts
```

For the standalone Volcengine subtitle voiceover helper, Kairos intentionally ships a manual
Resolve menu plugin under `apps/resolve-volc-voiceover-plugin/` and installs it to the Edit
script menu:

```text
/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Edit
```

That plugin is a direct Resolve UI helper, not the official `/color` or `/edit` backend path.

## Object Model Map

- `Resolve`: app-level object, page switching, version/product info, render/burn-in preset import/export, layout presets, `Fusion()`, `GetProjectManager()`, `GetMediaStorage()`.
- `ProjectManager`: project/database lifecycle, load/create/delete/import/export/restore project, folder navigation, current database.
- `Project`: timelines, media pool, gallery, render settings/jobs, project settings, LUT refresh, color groups.
- `MediaStorage`: mounted volumes and filesystem media discovery/import support.
- `MediaPool`: folder tree, media import, timeline creation/import/delete, append clips to current timeline.
- `Folder`: media pool folder contents and subfolders.
- `MediaPoolItem`: source clip properties, metadata, markers, flags, clip color, linked timelines.
- `Timeline`: tracks, clips, markers, playhead, current video item, timeline import/export, still grabbing, node graph.
- `TimelineItem`: clip item properties, takes, versions, markers, flags, clip enable, grade copy, Fusion comps, clip node graph, color group assignment.
- `Graph`: Resolve color node graph operations exposed by the scripting API.
- `ColorGroup`: group name and group Pre-Clip / Post-Clip node graphs.
- `Gallery` / `GalleryStillAlbum`: still import/export/delete, including DRX export/import workflows.

## High-Use API Surface For Kairos

### App And Project

- `resolve.OpenPage(pageName)` supports `media`, `cut`, `edit`, `fusion`, `color`, `fairlight`, `deliver`.
- `resolve.GetProductName()`, `resolve.GetVersion()`, and `resolve.GetVersionString()` are the preflight basis.
- `resolve.GetProjectManager()` and `resolve.GetMediaStorage()` are the main entry points.
- `projectManager.LoadProject(name)` returns `None` when no matching project exists.
- `projectManager.CreateProject(name)` returns `None` if the name is not unique.
- `projectManager.SaveProject()` persists the current project.
- `project.GetMediaPool()` returns the media-pool object.
- `project.GetTimelineCount()`, `project.GetTimelineByIndex(idx)`, `project.GetCurrentTimeline()`, and `project.SetCurrentTimeline(timeline)` are the stable timeline navigation layer.
- `project.RefreshLUTList()` is required when Resolve has not discovered newly copied LUT files.
- `project.GetColorGroupsList()`, `project.AddColorGroup(name)`, and `project.DeleteColorGroup(group)` are the exposed group management calls.

### Media Pool And Timelines

- `mediaPool.ImportMedia([paths])` and `mediaStorage.AddItemListToMediaPool([paths])` can import media.
- For rough-cut still-photo sync, prefer `mediaPool.ImportMedia([path])` and verify the returned `MediaPoolItem` `File Path` equals the requested file. Live probing on 2026-05-19 showed `mediaStorage.AddItemListToMediaPool([path])` can interpret numbered JPEG photos as an image sequence, e.g. `DSC07686.jpg` became `DSC[07686-07688].jpg` with `Type=Video`, which breaks single-photo timeline lookup and review.
- `mediaPool.CreateEmptyTimeline(name)` creates a blank timeline.
- `mediaPool.CreateTimelineFromClips(name, [clips])` creates a timeline and appends clips.
- `mediaPool.AppendToTimeline([mediaPoolItems])` appends clips to the current timeline.
- `mediaPool.DeleteTimelines([timeline])` deletes timelines.
- `timeline.GetTrackCount(trackType)` uses `audio`, `video`, or `subtitle`.
- `timeline.GetItemListInTrack(trackType, index)` returns timeline items on newer docs.
- `timeline.GetItemsInTrack(trackType, index)` is still present in the docs as a compatibility shape; Kairos may fall back to it.
- `timeline.GetMarkInOut()` and `timeline.GetCurrentTimecode()` support helper selection ranges, but the installed docs do not expose a stable `GetSelectedTimelineItems()` for Edit-page timeline selections. Resolve subtitle voiceover plugins must maintain their own selected subtitle rows or derive selection from playhead / Resolve In-Out.
- `timeline.DeleteClips([timelineItems], ripple=False)` clears timeline items.
- `timeline.DuplicateTimeline(name)` returns a copied timeline.
- `timeline.GetCurrentTimecode()` and `timeline.SetCurrentTimecode(timecode)` drive the playhead.
- `timeline.GetCurrentVideoItem()` reads the active color-page video item.

### Render Jobs

- `project.LoadRenderPreset(name)` loads a named preset.
- `project.SetRenderSettings(settings)` sets render settings.
- `project.SetCurrentRenderFormatAndCodec(format, codec)` sets format/codec.
- `project.SetCurrentRenderMode(renderMode)` uses `0` for individual clips and `1` for single clip.
- On Resolve 21.0.0b.28 / Windows, live probing showed MP4/H.265 `SetRenderSettings({"VideoQuality": ...})` returns `False` even though the installed README documents the key. Kairos therefore must not use public `VideoQuality` as the formal fixed-bitrate path for Windows MP4/H.265 `/color` exports; non-Windows hosts that accept `VideoQuality` should keep using the public setting path.
- For Windows MP4/H.265 `/color` fixed bitrate, the vendored host must generate a fresh render-preset XML from Kairos config for every run and import it with `resolve.ImportRenderPreset(xmlPath)` / `project.LoadRenderPreset(name)`. Do not use `SaveAsNewRenderPreset` from the current Deliver page as the template or verification source; it can inherit stale UI state. Live Windows Resolve 21 probing showed `SaveAsNewRenderPreset` can report `AlternateInFolder=1` from the current Deliver UI even while `ExportRenderPreset(presetName)` for the imported named preset keeps `AlternateInFolder=0`; later live render probing also proved `AlternateInFolder` is not the stable direct-root proof because a user-correct current preset can direct-render with `AlternateInFolder=1`.
- The generated XML must set `RecordFormatSubType=hvc1_qsv`, `h264_datarate=<kbps>`, `encoder_command_param_map.rc=CBR`, `encoder_command_param_map.bitrate=<kbps>`, empty `RecordPrefix / RecordSuffix / DestSuffix`, `UsePrefixAndSuffixFromSrc=1`, and `RecordAllowDupImg=1`. Do not keep an encoder-map `quality` key on this CBR path. `UsePrefixAndSuffixFromSrc=0` live-tested as queueing `00000000.mp4 and more`. `CustomClips` may re-export as zeros and is not the stable Source Name proof.
- Resolve 21 Windows materializes individual clips under generated `Event_Version...` folders when `RecordAllowDupImg=0`, even if the queue reports `OutputFilename=<sourceName>.mp4`; setting `RecordAllowDupImg=1` live-tested as direct-root output. The host may still normalize a Resolve-created one-level folder by promoting a single matching `sourceStem.ext` back to `TargetDir/sourceStem.ext`; multiple matches or non-single-file folders must fail. After each `AddRenderJob()`, read `GetRenderJobList()` and fail before `StartRendering()` if `OutputFilename` is not one of the expected source-name files.
- `resolve.ExportRenderPreset` / `resolve.ImportRenderPreset` are exposed on the Resolve app object in this installation; import expects the exported preset XML file path, not the outer `.drp` directory.
- `project.AddRenderJob()` returns a render job id.
- `project.StartRendering(...)`, `project.StopRendering()`, and `project.IsRenderingInProgress()` control execution.
- `project.GetRenderJobStatus(jobId)` is the formal polling call.
- `project.DeleteRenderJob(jobId)` and `project.DeleteAllRenderJobs()` clean the queue.

### Timeline Items And Clip Grades

- `timelineItem.GetName()`, `GetDuration()`, `GetStart()`, `GetEnd()`, `GetSourceStartFrame()`, and `GetSourceEndFrame()` are the timeline placement basics.
- `timelineItem.GetMediaPoolItem()` links back to source media.
- Subtitle item text is version-sensitive. The Volc voiceover plugin may try `GetName()`, `GetProperty().Text / Subtitle / Caption`, and `GetClipProperty().Text / Subtitle / Caption`; if all are empty, it must block instead of guessing subtitle text.
- For generated voiceover audio, import the audio file with `MediaPool.ImportMedia` and append it with `MediaPool.AppendToTimeline([{"mediaPoolItem": item, "mediaType": 2, "trackIndex": audioTrackIndex, "recordFrame": frame}])`. The documented `Project.InsertAudioToCurrentTrackAtPlayhead(...)` depends on Fairlight selected track/playhead state and is less deterministic for batch subtitle insertion.
- The Volc voiceover plugin reads `volcApiKey` and registered voice profiles from workspace global `config/runtime.json.voiceover`. The Resolve panel should expose a compact profile selector rather than raw API key / speaker / resource / model / language fields.

### Rough-cut Append Source Ranges

- Historical live probing on 2026-05-19 in Resolve project `丙察察格聂南线子梅垭口穿越 [Edit]`, clip `C0709.mp4`, showed that `AppendToTimeline([{mediaPoolItem,startFrame,endFrame,...}])` may report unexpected `TimelineItem.GetSourceStartFrame()` values for camera clips with embedded timecode. Kairos no longer creates temporary source-probe timelines to compensate for this; the rough-cut host passes direct media-relative `startFrame / endFrame` values, then validates the appended `TimelineItem` with `GetSourceStartFrame()` / `GetSourceEndFrame()` and fails loudly on mismatch.
- Resolve locks project/timeline frame rate before timeline creation. Live probing on 2026-05-19 showed setting `timelineFrameRate=30` after a rough-cut timeline already existed left the timeline at the Resolve default `24`, while Kairos still computed `recordFrame` at `30`, causing incorrect placement and duration. The rough-cut host must set project frame-rate settings before creating the target timeline; if the only existing timeline is the generated target rough cut with the wrong FPS, recreate it before proceeding, otherwise block with a clear fps mismatch. Kairos must also set and verify `timelinePlaybackFrameRate`; timeline fps and playback fps must both match the runtime timeline fps.
- For Resolve rough cuts, Kairos uses `TimelineItem.SetClipColor("Orange")` on every non-muted video item and its linked audio item(s) as a user-facing selection aid for manual audio normalization in the Edit/Fairlight Timeline Index. Do not use Color-page filters or flags for this marker: Color-page selection does not become Edit-page timeline selection, and Resolve flag behavior propagates across linked items imprecisely.
- The official docs do not expose a still-image duration setter. For Resolve rough cuts, Kairos defaults photo stills to `1000ms` unless the edit rule / confirmed Flow Plan or runtime `timelineStillDurationMs` explicitly overrides it, then validates the resulting TimelineItem duration after append.
- `timelineItem.GetProperty(key)` and `timelineItem.SetProperty(key, value)` expose documented item properties.
- `timelineItem.SetClipEnabled(bool)` and `timelineItem.GetClipEnabled()` are clip-level enable state, not color-node enable state.
- `timelineItem.CopyGrades([targetTimelineItems])` copies the current node stack layer grade to targets.
- `timelineItem.AddVersion(name, versionType)`, `LoadVersionByName(name, versionType)`, and `GetVersionNameList(versionType)` support grade versions.
- `timelineItem.GetNodeGraph(layerIdx)` returns the clip graph; `layerIdx` is optional and starts at `1`.
- `timelineItem.AssignToColorGroup(colorGroup)` and `RemoveFromColorGroup()` manage group membership.
- `timelineItem.Stabilize()` and `SmartReframe()` exist, but they are Resolve-native actions and are not equivalent to Gyroflow OFX automation.

### Color Graph

Graph methods currently relevant to Kairos:

- `GetNumNodes()`
- `SetLUT(nodeIndex, lutPath)`
- `GetLUT(nodeIndex)`
- `SetNodeCacheMode(nodeIndex, cacheMode)`
- `GetNodeCacheMode(nodeIndex)`
- `GetNodeLabel(nodeIndex)`
- `GetToolsInNode(nodeIndex)`
- `SetNodeEnabled(nodeIndex, isEnabled)`
- `ApplyGradeFromDRX(path, gradeMode)`
- `ResetAllGrades()`

Important graph constraints:

- `SetLUT()` and `SetCDL()` node indexes are 1-based in Resolve v16.2.0+.
- `ApplyGradeFromDRX(path, gradeMode)` grade modes are: `0` no keyframes, `1` source-timecode aligned, `2` start-frames aligned.
- `SetLUT()` succeeds only for LUT paths Resolve already knows; use `project.RefreshLUTList()` after copying LUTs.
- The official docs expose `SetNodeEnabled()` but do not expose `GetNodeEnabled()`.
- The official docs do not expose color-node insert, move, or delete operations.
- The official docs do not expose OpenFX parameter getters/setters or a generic "click OFX button" operation.
- `GetToolsInNode(nodeIndex)` returns tool names such as `OFX: Gyroflow`, `OFX: Dehaze`, or `OFX: Noise Reduction`; it does not prove the OFX has loaded source-specific data.

### Gyroflow OpenFX In Resolve

Kairos checked the local Gyroflow OpenFX bundle and upstream plugin source while debugging
`/color` clip repair on 2026-04-24.

- Gyroflow's Resolve OpenFX parameter set contains a button named `LoadCurrent` with UI label `Load for current file`.
- Pressing that button runs Gyroflow plugin code, not Resolve scripting code owned by Kairos.
- The plugin implementation invokes Resolve's `fuscript` to query
  `Resolve():GetProjectManager():GetCurrentProject():GetCurrentTimeline():GetCurrentVideoItem():GetMediaPoolItem():GetClipProperty()`
  and then reads the current clip's `File Path`.
- Resolve's documented Python `NodeGraph` API does not expose a method to press `LoadCurrent` or set Gyroflow's hidden `ProjectPath` string.
- `SetNodeEnabled(1, True)` can request that the Gyroflow node be enabled, but it does not trigger `LoadCurrent`.
- A live probe on project `tmp 调色流程测试 2026-04-20 15 32 30 [Color]`, duplicated timeline `kairos-test action6 [Color]`, and clip `DJI_20260217100743_0227_D.MP4` confirmed that applying `config/default.drx`, calling `SetNodeEnabled` on nodes 1-5, and exporting the current frame still added `0` bytes to `gyroflow-openfx.log`.
- A second live probe in the same project confirmed that importing `vendor/resolve-color-host/donors/gyro-only.drt`, copying its grade to `DJI_20260217100743_0227_D.MP4`, enabling node 1, and exporting the current frame added Gyroflow log entries for that exact DJI file. This means a clean DRT donor can trigger Gyroflow's own current-file path during render, while the current DRX template does not.
- For Kairos bulk clip repair, use a clean canonical five-node DRT donor as the only automatic seed source. Treat DRX as manual diagnostic material only; do not use `ApplyGradeFromDRX()` as a large-batch fallback unless a new live probe proves it is stable and source-correct.
- ZV-E1 / Sony portrait clips are not inherently ineligible for Gyroflow, but Resolve may rotate input pixels before the OFX plugin sees them. Kairos handles this by choosing source-orientation-specific DRT donors (`default.drt`, `gyroflow-portrait-90.drt`, `gyroflow-portrait--90.drt`) for the Gyroflow OFX setup, while using `TimelineItem:SetProperty()` on the Resolve timeline for final horizontal framing. ffprobe source `rotation=90` is Gyroflow `270`, so it gets `RotationAngle=-90` and `gyroflow-portrait--90.drt`; ffprobe source `rotation=-90/270` is Gyroflow `90`, so it gets `RotationAngle=90` and `gyroflow-portrait-90.drt`. For horizontal-encoded portrait sources, `ZoomX/ZoomY` must compensate Gyroflow/DRT output that otherwise appears as a smaller landscape region inside the horizontal canvas.
- If a portrait DRT hash is missing or stale on an already prepared root, rerun the affected chunk and reset the stale portrait clip with `ResetAllGrades()` before reapplying the orientation DRT. Live testing showed a fresh single-clip timeline plus the same DRT path is clean, so stale old-clip OFX state must be cleared before DRT reapply.
- Resolve scripting exposes timeline item transform keys such as `RotationAngle`, `ZoomX`, `ZoomY`, `ZoomGang`, `Pan`, and `Tilt`, but the documented API still does not expose generic Gyroflow OFX parameter setters. Do not replace orientation-specific DRTs with guessed OFX parameter writes.

### Color Groups

- `colorGroup.GetName()` and `SetName(name)` manage group naming.
- `colorGroup.GetClipsInTimeline(timeline)` returns clips in the group for a timeline.
- `colorGroup.GetPreClipNodeGraph()` is Kairos' current technical transform bed.
- `colorGroup.GetPostClipNodeGraph()` is Kairos' formal creative truth layer.

### Gallery And DRX

- `timeline.GrabStill()` grabs a still from the current video clip.
- `timeline.GrabAllStills(stillFrameSource)` can grab stills from all clips; `1` means first frame and `2` means middle frame.
- `gallery.GetCurrentStillAlbum()` returns the current album.
- `album.ExportStills([still], folderPath, filePrefix, format)` supports `drx`.
- `album.ImportStills([filePaths])` imports stills.
- `album.DeleteStills([still])` deletes temporary stills.

Kairos no longer uses DRX as the formal large-batch cold-start / legacy-rebuild mechanism for clip repair layout. If a task depends on DRX contents, validate by applying the DRX manually in Resolve and inspecting the resulting graph; do not route bulk prepare through repeated `ApplyGradeFromDRX()` calls.

## Known Gaps And Do-Not-Assume Rules

- Do not claim a node is enabled from `SetNodeEnabled()` alone unless the workflow has also verified the result by a supported side effect, UI check, rendered/DRX output, or explicit project state.
- Do not claim Gyroflow has performed `Load from file` merely because `OFX: Gyroflow` exists in node 1.
- Do not claim Gyroflow has performed `Load from file` merely because `SetNodeEnabled(1, True)` returned success or a current-frame export succeeded.
- Do not invent `GetNodeEnabled()`: it is not in the official docs and returns no reliable state in current Kairos testing.
- Do not assume Resolve scripting can edit OFX internal parameters. If a task needs that, first prove the method exists locally or design around a DRX/DRT/template workflow.
- Do not assume `GrabStill()` / `GrabAllStills()` is harmless in production logic; it mutates Gallery state unless temporary stills are deleted.
- Do not assume node graph mutations are safe on user grades; Kairos `/color` must preserve canonical reruns and only rebuild legacy graphs under the documented contract.
- Do not rely on stale `color/current.json` or `color/groups/*.json` as proof of current Resolve UI state.

## Kairos Resolve Verification Checklist

- Verify Resolve Studio is running and external scripting is enabled.
- Run preflight through the vendored backend before official `/color` mutations.
- Confirm the project name and timeline name before modifying an existing Resolve project.
- Use `GetToolsInNode()` and `GetNumNodes()` to inspect graph shape.
- Use `GetLUT()` and `RefreshLUTList()` when debugging LUT application.
- For render changes, inspect render job status and output manifests, not just `StartRendering()` success.
- For clip repair changes, verify more than one clip and more than one root timeline when the behavior is root-wide.
- For Gyroflow, distinguish three layers: `gyroEligible` technical signal, `OFX: Gyroflow` node presence, and actual source-specific load/effect.
- When adding new Resolve scripting behavior, add or update tests around the deterministic wrapper, and record any live-Resolve-only verification in the final report.
