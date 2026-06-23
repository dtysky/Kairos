local WINDOW_ID = "kairosVolcVoiceover"
local VOICE_TRACK_NAME = "Kairos VO"
local DEFAULT_RESOURCE_ID = "seed-icl-2.0"

local subtitles = {}
local items = nil
local root = "."

local function quote(value)
    return "'" .. tostring(value):gsub("'", "'\\''") .. "'"
end

local function dirname(path)
    return tostring(path):match("^(.*)/[^/]*$") or "."
end

local source = debug.getinfo(1, "S").source or ""
if source:sub(1, 1) == "@" then
    source = source:sub(2)
end
root = dirname(source)

local function logDir()
    return (os.getenv("HOME") or ".") .. "/Movies/KairosVoiceover/logs"
end

local function appendLog(message)
    local dir = logDir()
    os.execute("/bin/mkdir -p " .. quote(dir))
    local file = io.open(dir .. "/lua-plugin.log", "a")
    if file then
        file:write(os.date("[%Y-%m-%d %H:%M:%S] ") .. tostring(message) .. "\n")
        file:close()
    end
end

local function readText(path)
    local file = io.open(path, "r")
    if not file then
        return ""
    end
    local text = file:read("*a") or ""
    file:close()
    return text
end

local function writeText(path, text)
    local file = io.open(path, "w")
    if not file then
        return false
    end
    file:write(text)
    file:close()
    return true
end

local function uiLog(message)
    appendLog(message)
    if items and items.log then
        local current = items.log.PlainText or ""
        local line = os.date("%H:%M:%S ") .. tostring(message)
        if current == "" then
            items.log.PlainText = line
        else
            items.log.PlainText = current .. "\n" .. line
        end
    end
end

local function safeCall(obj, method, ...)
    local objType = type(obj)
    if obj == nil or (objType ~= "table" and objType ~= "userdata") then
        return nil
    end
    local okLookup, fn = pcall(function()
        return obj[method]
    end)
    if not okLookup then
        return nil
    end
    if fn == nil then
        return nil
    end
    local ok, result = pcall(fn, obj, ...)
    if ok then
        return result
    end
    return nil
end

local function stringify(value)
    if value == nil or type(value) == "table" then
        return ""
    end
    return tostring(value)
end

local function trim(value)
    return tostring(value or ""):match("^%s*(.-)%s*$") or ""
end

local function cleanSubtitleText(value)
    local text = trim(value)
    text = text:gsub("<[^>]+>", "")
    text = text:gsub("\\N", "\n")
    text = text:gsub("%s+", " ")
    return trim(text)
end

local function extractJsonString(text, key)
    local pattern = '"' .. key .. '"%s*:%s*"(.-)"'
    local value = text:match(pattern)
    if not value then
        return ""
    end
    value = value:gsub('\\"', '"')
    value = value:gsub("\\n", "\n")
    value = value:gsub("\\\\", "\\")
    return value
end

local function loadConfig()
    local path = (os.getenv("HOME") or ".") .. "/Movies/KairosVoiceover/config.local.json"
    local text = readText(path)
    return {
        apiKey = extractJsonString(text, "apiKey"),
        speaker = extractJsonString(text, "speaker"),
        resourceId = extractJsonString(text, "resourceId"),
        model = extractJsonString(text, "model"),
        language = extractJsonString(text, "language"),
        speedRatio = extractJsonString(text, "speedRatio"),
        loudnessRatio = extractJsonString(text, "loudnessRatio"),
        contextText = extractJsonString(text, "contextText"),
    }
end

local function jsonString(value)
    local replacements = {
        ['"'] = '\\"',
        ["\\"] = "\\\\",
        ["\b"] = "\\b",
        ["\f"] = "\\f",
        ["\n"] = "\\n",
        ["\r"] = "\\r",
        ["\t"] = "\\t",
    }
    local text = tostring(value or "")
    text = text:gsub('[%z\1-\31\\"]', function(char)
        return replacements[char] or string.format("\\u%04x", char:byte())
    end)
    return '"' .. text .. '"'
end

local function isArray(value)
    if type(value) ~= "table" then
        return false
    end
    local count = 0
    local maxIndex = 0
    for key, _ in pairs(value) do
        if type(key) ~= "number" then
            return false
        end
        count = count + 1
        if key > maxIndex then
            maxIndex = key
        end
    end
    return maxIndex == count
end

local function jsonEncode(value)
    local kind = type(value)
    if kind == "nil" then
        return "null"
    end
    if kind == "boolean" then
        return value and "true" or "false"
    end
    if kind == "number" then
        return tostring(value)
    end
    if kind == "string" then
        return jsonString(value)
    end
    if kind ~= "table" then
        return jsonString(tostring(value))
    end
    local parts = {}
    if isArray(value) then
        for index = 1, #value do
            table.insert(parts, jsonEncode(value[index]))
        end
        return "[" .. table.concat(parts, ",") .. "]"
    end
    for key, child in pairs(value) do
        table.insert(parts, jsonString(key) .. ":" .. jsonEncode(child))
    end
    return "{" .. table.concat(parts, ",") .. "}"
end

local function getResolve()
    if resolve ~= nil then
        return resolve
    end
    if bmd ~= nil and bmd.scriptapp ~= nil then
        return bmd.scriptapp("Resolve")
    end
    return nil
end

local function getProject()
    local currentResolve = getResolve()
    local manager = safeCall(currentResolve, "GetProjectManager")
    return safeCall(manager, "GetCurrentProject")
end

local function getTimeline()
    local project = getProject()
    return safeCall(project, "GetCurrentTimeline")
end

local function getProjectName()
    local project = getProject()
    return tostring(safeCall(project, "GetName") or "Resolve Project")
end

local function getTimelineName()
    local timeline = getTimeline()
    return tostring(safeCall(timeline, "GetName") or "Timeline")
end

local function stableTimelineId()
    local timeline = getTimeline()
    local uniqueId = safeCall(timeline, "GetUniqueId")
    if uniqueId ~= nil and tostring(uniqueId) ~= "" then
        return tostring(uniqueId)
    end
    return getTimelineName()
end

local function fps()
    local project = getProject()
    local timeline = getTimeline()
    for _, obj in ipairs({timeline, project}) do
        local settings = safeCall(obj, "GetSetting")
        if type(settings) == "table" then
            for _, key in ipairs({"timelineFrameRate", "timelinePlaybackFrameRate"}) do
                local value = tonumber(settings[key])
                if value and value > 0 then
                    return value
                end
            end
        end
        for _, key in ipairs({"timelineFrameRate", "timelinePlaybackFrameRate"}) do
            local value = tonumber(safeCall(obj, "GetSetting", key))
            if value and value > 0 then
                return value
            end
        end
    end
    return 24.0
end

local function framesToMs(frames, frameRate)
    local value = tonumber(frames)
    if not value or frameRate <= 0 then
        return nil
    end
    return value * 1000.0 / frameRate
end

local function frameToTimecode(frame, frameRate)
    local frameValue = math.floor((tonumber(frame) or 0) + 0.5)
    local fpsInt = math.floor((frameRate or 24) + 0.5)
    if fpsInt <= 0 then
        fpsInt = 24
    end
    local totalSeconds = math.floor(math.max(frameValue, 0) / fpsInt)
    local framePart = math.max(frameValue, 0) % fpsInt
    local hours = math.floor(totalSeconds / 3600)
    local minutes = math.floor((totalSeconds % 3600) / 60)
    local seconds = totalSeconds % 60
    return string.format("%02d:%02d:%02d:%02d", hours, minutes, seconds, framePart)
end

local function timecodeToFrame(timecode, frameRate)
    local h, m, s, f = tostring(timecode or ""):match("^(%d+):(%d+):(%d+)[:;](%d+)")
    if not h then
        return nil
    end
    return math.floor(((tonumber(h) * 3600 + tonumber(m) * 60 + tonumber(s)) * frameRate) + tonumber(f) + 0.5)
end

local function timelineNumber(item, method)
    local value = safeCall(item, method)
    if value == nil then
        value = safeCall(item, method, false)
    end
    return tonumber(value)
end

local function extractSubtitleText(summary)
    local candidates = {summary.name}
    for _, mapName in ipairs({"property", "clipProperty"}) do
        local map = summary[mapName]
        if type(map) == "table" then
            for _, key in ipairs({"Text", "Subtitle", "Caption", "Name"}) do
                table.insert(candidates, map[key])
            end
        end
    end
    for _, candidate in ipairs(candidates) do
        local text = cleanSubtitleText(stringify(candidate))
        if text ~= "" then
            return text
        end
    end
    return ""
end

local function summarizeItem(item, trackIndex, index, frameRate)
    local startFrame = timelineNumber(item, "GetStart")
    local endFrame = timelineNumber(item, "GetEnd")
    local durationFrames = timelineNumber(item, "GetDuration")
    if startFrame == nil and endFrame ~= nil and durationFrames ~= nil then
        startFrame = endFrame - durationFrames
    end
    if endFrame == nil and startFrame ~= nil and durationFrames ~= nil then
        endFrame = startFrame + durationFrames
    end
    local property = safeCall(item, "GetProperty")
    if type(property) ~= "table" then
        property = {}
    end
    local clipProperty = safeCall(item, "GetClipProperty")
    if type(clipProperty) ~= "table" then
        clipProperty = {}
    end
    local summary = {
        trackType = "subtitle",
        trackIndex = trackIndex,
        subtitleIndex = index,
        name = tostring(safeCall(item, "GetName") or ""),
        startFrame = startFrame or 0,
        endFrame = endFrame or 0,
        durationFrames = durationFrames or ((endFrame or 0) - (startFrame or 0)),
        timelineInMs = framesToMs(startFrame, frameRate),
        timelineOutMs = framesToMs(endFrame, frameRate),
        durationMs = framesToMs(durationFrames, frameRate),
        property = property,
        clipProperty = clipProperty,
    }
    summary.text = extractSubtitleText(summary)
    summary.startTimecode = frameToTimecode(summary.startFrame, frameRate)
    summary.endTimecode = frameToTimecode(summary.endFrame, frameRate)
    return summary
end

local function collectSubtitles()
    local timeline = getTimeline()
    if not timeline then
        error("No current Resolve timeline.")
    end
    local frameRate = fps()
    local result = {}
    local trackCount = tonumber(safeCall(timeline, "GetTrackCount", "subtitle") or 0) or 0
    for trackIndex = 1, trackCount do
        local trackItems = safeCall(timeline, "GetItemListInTrack", "subtitle", trackIndex)
        if trackItems == nil then
            trackItems = safeCall(timeline, "GetItemsInTrack", "subtitle", trackIndex)
        end
        if type(trackItems) == "table" then
            for _, item in pairs(trackItems) do
                local itemType = type(item)
                if itemType == "table" or itemType == "userdata" then
                    table.insert(result, summarizeItem(item, trackIndex, #result + 1, frameRate))
                end
            end
        end
    end
    table.sort(result, function(left, right)
        if left.startFrame == right.startFrame then
            return left.trackIndex < right.trackIndex
        end
        return left.startFrame < right.startFrame
    end)
    for index, row in ipairs(result) do
        row.subtitleIndex = index
    end
    return result
end

local function renderSubtitleList()
    local lines = {}
    for _, row in ipairs(subtitles) do
        local text = row.text
        if text == "" then
            text = "(no readable text)"
        end
        if #text > 72 then
            text = text:sub(1, 72) .. "..."
        end
        table.insert(lines, string.format(
            "%03d | T%d | %s - %s | %.0fms | %s",
            row.subtitleIndex,
            row.trackIndex,
            row.startTimecode,
            row.endTimecode,
            tonumber(row.durationMs or 0),
            text
        ))
    end
    if #lines == 0 then
        table.insert(lines, "No subtitle items found on the current timeline.")
    end
    items.subtitleList.PlainText = table.concat(lines, "\n")
end

local function refreshSubtitles(ev)
    local ok, result = pcall(collectSubtitles)
    if not ok then
        uiLog("Refresh failed: " .. tostring(result))
        return
    end
    subtitles = result
    renderSubtitleList()
    uiLog("Loaded " .. tostring(#subtitles) .. " subtitle item(s).")
end

local function selectedIds()
    local ids = {}
    local seen = {}
    local text = items.selectedIds.Text or ""
    for token in tostring(text):gmatch("[^,%s]+") do
        local value = tonumber(token)
        if value and value >= 1 and value <= #subtitles and not seen[value] then
            table.insert(ids, value)
            seen[value] = true
        end
    end
    table.sort(ids)
    return ids
end

local function setSelectedIds(ids)
    local parts = {}
    for _, id in ipairs(ids) do
        table.insert(parts, tostring(id))
    end
    items.selectedIds.Text = table.concat(parts, ",")
end

local function currentFrame()
    local timeline = getTimeline()
    local timecode = safeCall(timeline, "GetCurrentTimecode")
    return timecodeToFrame(timecode, fps())
end

local function usePlayhead(ev)
    local frame = currentFrame()
    if frame == nil then
        uiLog("Unable to read playhead frame.")
        return
    end
    local ids = {}
    for _, row in ipairs(subtitles) do
        if row.startFrame <= frame and frame < row.endFrame then
            table.insert(ids, row.subtitleIndex)
        end
    end
    setSelectedIds(ids)
    uiLog("Selected " .. tostring(#ids) .. " subtitle(s) at frame " .. tostring(frame) .. ".")
end

local function rangesOverlap(leftStart, leftEnd, rightStart, rightEnd)
    return tonumber(leftStart) < tonumber(rightEnd) and tonumber(rightStart) < tonumber(leftEnd)
end

local function markRange()
    local timeline = getTimeline()
    local mark = safeCall(timeline, "GetMarkInOut")
    if type(mark) ~= "table" then
        return nil
    end
    for _, key in ipairs({"all", "video", "audio"}) do
        local current = mark[key]
        if type(current) == "table" and current["in"] ~= nil and current["out"] ~= nil then
            return tonumber(current["in"]), tonumber(current["out"])
        end
    end
    if mark["in"] ~= nil and mark["out"] ~= nil then
        return tonumber(mark["in"]), tonumber(mark["out"])
    end
    return nil
end

local function useMark(ev)
    local markIn, markOut = markRange()
    if not markIn or not markOut then
        uiLog("No Resolve In/Out range found. Set it on the timeline with I and O, then click Select Resolve I/O.")
        return
    end
    local ids = {}
    for _, row in ipairs(subtitles) do
        if rangesOverlap(markIn, markOut, row.startFrame, row.endFrame) then
            table.insert(ids, row.subtitleIndex)
        end
    end
    setSelectedIds(ids)
    uiLog("Selected " .. tostring(#ids) .. " subtitle(s) in Resolve In/Out.")
end

local function selectedSubtitles()
    local selected = {}
    for _, id in ipairs(selectedIds()) do
        table.insert(selected, subtitles[id])
    end
    return selected
end

local function currentSettings()
    return {
        apiKey = items.apiKey.Text or "",
        speaker = items.speaker.Text or "",
        resourceId = items.resourceId.Text ~= "" and items.resourceId.Text or DEFAULT_RESOURCE_ID,
        model = items.model.Text or "",
        language = items.language.Text ~= "" and items.language.Text or "zh-cn",
        speedRatio = items.speed.Text or "",
        loudnessRatio = items.loudness.Text or "",
        contextText = items.contextText.PlainText or "",
    }
end

local function saveConfig(ev)
    local config = currentSettings()
    if not items.saveApiKey.Checked then
        config.apiKey = ""
    end
    local path = (os.getenv("HOME") or ".") .. "/Movies/KairosVoiceover/config.local.json"
    os.execute("/bin/mkdir -p " .. quote(dirname(path)))
    if writeText(path, jsonEncode(config) .. "\n") then
        os.execute("/bin/chmod 600 " .. quote(path))
        uiLog("Saved local config: " .. path)
    else
        uiLog("Failed to save config: " .. path)
    end
end

local function runBackend(mode)
    local selected = selectedSubtitles()
    if #selected == 0 then
        uiLog("No subtitle IDs selected.")
        return
    end
    local job = {
        mode = mode,
        projectName = getProjectName(),
        timelineName = getTimelineName(),
        timelineId = stableTimelineId(),
        runId = os.date("%Y%m%d-%H%M%S"),
        subtitles = selected,
        settings = currentSettings(),
        skipOverflow = items.skipOverflow.Checked == true,
    }
    local tmpDir = (os.getenv("HOME") or ".") .. "/Movies/KairosVoiceover/.tmp"
    os.execute("/bin/mkdir -p " .. quote(tmpDir))
    local stamp = os.date("%Y%m%d-%H%M%S")
    local jobPath = tmpDir .. "/lua-job-" .. stamp .. ".json"
    local outPath = tmpDir .. "/lua-job-" .. stamp .. ".out"
    if not writeText(jobPath, jsonEncode(job) .. "\n") then
        uiLog("Unable to write job file: " .. jobPath)
        return
    end
    local python = root .. "/KairosVolcVoiceoverLib/KairosVolcVoiceover.py"
    local cmd = "/usr/bin/python3 " .. quote(python) .. " --synthesize-job " .. quote(jobPath) .. " > " .. quote(outPath) .. " 2>&1"
    appendLog("backend " .. cmd)
    uiLog("Running backend for " .. tostring(#selected) .. " subtitle(s)...")
    local result = os.execute(cmd)
    local output = readText(outPath)
    if output ~= "" then
        uiLog(output)
    else
        uiLog("Backend finished: " .. tostring(result))
    end
end

local function preview(ev)
    runBackend("preview")
end

local function synthesizeInsert(ev)
    runBackend("insert")
end

local function probe(ev)
    local project = getProject()
    local timeline = getTimeline()
    if not project or not timeline then
        uiLog("Probe failed: no current project/timeline.")
        return
    end
    uiLog(
        "Probe OK: project=" .. getProjectName()
        .. ", timeline=" .. getTimelineName()
        .. ", fps=" .. tostring(fps())
        .. ", subtitles=" .. tostring(#subtitles)
        .. ", voiceTrack=" .. VOICE_TRACK_NAME
    )
end

local function openLogs(ev)
    os.execute("/usr/bin/open " .. quote(logDir()))
end

appendLog("lua plugin start root=" .. tostring(root))
local ui = fusion and fusion.UIManager
local dispatcher = bmd and ui and bmd.UIDispatcher(ui)
appendLog("globals fusion=" .. tostring(fusion ~= nil) .. " bmd=" .. tostring(bmd ~= nil) .. " resolve=" .. tostring(resolve ~= nil))

if not dispatcher then
    appendLog("dispatcher unavailable")
    return
end

local existing = ui:FindWindow(WINDOW_ID)
if existing then
    existing:Show()
    existing:Raise()
    return
end

local config = loadConfig()
local win = dispatcher:AddWindow({
    ID = WINDOW_ID,
    Geometry = {120, 120, 1040, 780},
    WindowTitle = "Kairos Volc Voiceover",
},
ui:VGroup({
    ui:Label({Text = "Kairos Volc Voiceover", Weight = 0}),
    ui:HGroup({
        ui:Button({ID = "refresh", Text = "Refresh Subtitles"}),
        ui:Button({ID = "playhead", Text = "Use Playhead Subtitle"}),
        ui:Button({ID = "mark", Text = "Select Resolve I/O"}),
        ui:Button({ID = "probe", Text = "Probe"}),
        ui:Button({ID = "openLogs", Text = "Logs"}),
    }),
    ui:TextEdit({ID = "subtitleList", Weight = 1.0, ReadOnly = true, AcceptRichText = false}),
    ui:HGroup({
        ui:Label({Text = "Selected IDs", Weight = 0}),
        ui:LineEdit({ID = "selectedIds", Text = "", PlaceholderText = "1,2,3"}),
    }),
    ui:HGroup({
        ui:Label({Text = "API Key", Weight = 0}),
        ui:LineEdit({ID = "apiKey", Text = config.apiKey or "", EchoMode = "Password"}),
        ui:CheckBox({ID = "saveApiKey", Text = "Save local", Checked = false}),
    }),
    ui:HGroup({
        ui:Label({Text = "Speaker", Weight = 0}),
        ui:LineEdit({ID = "speaker", Text = config.speaker or "", PlaceholderText = "speaker_id"}),
        ui:Label({Text = "Resource", Weight = 0}),
        ui:LineEdit({ID = "resourceId", Text = config.resourceId ~= "" and config.resourceId or DEFAULT_RESOURCE_ID}),
    }),
    ui:HGroup({
        ui:Label({Text = "Model", Weight = 0}),
        ui:LineEdit({ID = "model", Text = config.model or ""}),
        ui:Label({Text = "Language", Weight = 0}),
        ui:LineEdit({ID = "language", Text = config.language ~= "" and config.language or "zh-cn"}),
        ui:Label({Text = "Speed", Weight = 0}),
        ui:LineEdit({ID = "speed", Text = config.speedRatio or ""}),
        ui:Label({Text = "Loudness", Weight = 0}),
        ui:LineEdit({ID = "loudness", Text = config.loudnessRatio or ""}),
    }),
    ui:TextEdit({ID = "contextText", Weight = 0.25, AcceptRichText = false, PlainText = config.contextText or ""}),
    ui:HGroup({
        ui:CheckBox({ID = "skipOverflow", Text = "Skip overflow clips", Checked = false}),
        ui:Button({ID = "saveConfig", Text = "Save Config"}),
        ui:Button({ID = "preview", Text = "Preview"}),
        ui:Button({ID = "synthesizeInsert", Text = "Synthesize + Insert"}),
        ui:Button({ID = "close", Text = "Close"}),
    }),
    ui:TextEdit({ID = "log", Weight = 0.45, ReadOnly = true, AcceptRichText = false}),
}))

if not win then
    appendLog("window creation failed")
    return
end

items = win:GetItems()

local function onClose(ev)
    appendLog("lua plugin close")
    dispatcher:ExitLoop()
end

win.On[WINDOW_ID].Close = onClose
win.On["close"].Clicked = onClose
win.On["refresh"].Clicked = refreshSubtitles
win.On["playhead"].Clicked = usePlayhead
win.On["mark"].Clicked = useMark
win.On["probe"].Clicked = probe
win.On["openLogs"].Clicked = openLogs
win.On["saveConfig"].Clicked = saveConfig
win.On["preview"].Clicked = preview
win.On["synthesizeInsert"].Clicked = synthesizeInsert

win:Show()
appendLog("lua plugin window shown")
refreshSubtitles(nil)
dispatcher:RunLoop()
