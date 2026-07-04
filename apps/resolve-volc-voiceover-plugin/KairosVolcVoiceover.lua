local WINDOW_ID = "kairosVolcVoiceover"
local PLUGIN_VERSION = "0.2.8"
local VOICE_TRACK_NAME = "Kairos VO"

local subtitles = {}
local subtitleTrackOptions = {}
local selectedSubtitleTrackIndex = nil
local subtitleTreeItems = {}
local items = nil
local root = "."
local voiceConfig = nil
local ui = nil
local getProjectName = nil
local IS_WINDOWS = (
    (package.config and package.config:sub(1, 1) == "\\")
    or tostring(os.getenv("OS") or ""):lower():find("windows", 1, true) ~= nil
)
local updatingSubtitleTrackCombo = false
local supervisorRequest = nil
local ipcCounter = 0
local subtitleSelectionAnchorId = nil
local subtitleLocateAnchorId = nil
local subtitleSelectedIds = {}
local repairingSubtitleSelection = false

local function dirname(path)
    return tostring(path):match("^(.*)[/\\][^/\\]*$") or "."
end

local source = debug.getinfo(1, "S").source or ""
if source:sub(1, 1) == "@" then
    source = source:sub(2)
end
root = dirname(source)
if tostring(root):match("^%a:[/\\]") then
    IS_WINDOWS = true
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
    file:write(tostring(text or ""))
    file:close()
    return true
end

local function jsonUnescape(value)
    local text = tostring(value or "")
    text = text:gsub("\\/", "/")
    text = text:gsub('\\"', '"')
    text = text:gsub("\\\\", "\\")
    return text
end

local function workspaceLinkField(name)
    local linkText = readText(root .. "/../../Config/KairosVolcVoiceover/kairos_workspace.json")
    if linkText == "" then
        linkText = readText(root .. "/KairosVolcVoiceoverLib/kairos_workspace.json")
    end
    local value = linkText:match('"' .. name .. '"%s*:%s*"([^"]*)"') or ""
    return jsonUnescape(value)
end

local function supervisorUrl()
    local configured = workspaceLinkField("supervisorUrl")
    if configured ~= "" then
        return configured
    end
    return "http://127.0.0.1:8940"
end

local function supervisorIpcRoot()
    local configured = workspaceLinkField("ipcRoot")
    if configured ~= "" then
        return configured
    end
    local workspaceRoot = workspaceLinkField("workspaceRoot")
    if workspaceRoot ~= "" then
        return workspaceRoot .. "/.tmp/resolve-volc-voiceover-plugin/ipc"
    end
    return ""
end

local function workspaceTmpDir()
    local workspaceRoot = workspaceLinkField("workspaceRoot")
    if workspaceRoot ~= "" then
        return workspaceRoot .. "/.tmp/resolve-volc-voiceover-plugin"
    end
    return (os.getenv("HOME") or ".") .. "/Movies/KairosVoiceover"
end

local function pluginTmpDir()
    if voiceConfig and tostring(voiceConfig.projectRoot or "") ~= "" then
        local tmp = tostring(voiceConfig.projectRoot) .. "/.tmp/resolve-volc-voiceover-plugin"
        return tmp
    end
    local tmp = workspaceTmpDir()
    return tmp
end

local function logDir()
    return pluginTmpDir() .. "/logs"
end

local function appendLog(message)
    local dir = logDir()
    local file = io.open(dir .. "/lua-plugin.log", "a")
    if file then
        file:write(os.date("[%Y-%m-%d %H:%M:%S] ") .. tostring(message) .. "\n")
        file:close()
    end
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

local function tsvUnescape(value)
    local text = tostring(value or "")
    local out = {}
    local index = 1
    while index <= #text do
        local char = text:sub(index, index)
        if char == "\\" and index < #text then
            local nextChar = text:sub(index + 1, index + 1)
            if nextChar == "n" then
                table.insert(out, "\n")
                index = index + 2
            elseif nextChar == "r" then
                table.insert(out, "\r")
                index = index + 2
            elseif nextChar == "t" then
                table.insert(out, "\t")
                index = index + 2
            elseif nextChar == "\\" then
                table.insert(out, "\\")
                index = index + 2
            else
                table.insert(out, char)
                index = index + 1
            end
        else
            table.insert(out, char)
            index = index + 1
        end
    end
    return table.concat(out)
end

local function splitTabs(line)
    local fields = {}
    local text = tostring(line or "")
    local start = 1
    while true do
        local tab = text:find("\t", start, true)
        if not tab then
            table.insert(fields, tsvUnescape(text:sub(start)))
            break
        end
        table.insert(fields, tsvUnescape(text:sub(start, tab - 1)))
        start = tab + 1
    end
    return fields
end

local function urlEncode(value)
    local text = tostring(value or "")
    return (text:gsub("([^A-Za-z0-9_%.%-%~])", function(char)
        return string.format("%%%02X", string.byte(char))
    end))
end

local function parseHttpUrl(url)
    local scheme, host, port, path = tostring(url or ""):match("^(http)://([^/:]+):?(%d*)(/?.*)$")
    if scheme ~= "http" or host == nil or host == "" then
        return nil, "Only http://host:port Supervisor URLs are supported by Resolve Lua."
    end
    if path == "" then
        path = "/"
    end
    return {
        host = host,
        port = tonumber(port) or 80,
        basePath = path:gsub("/$", ""),
    }
end

local function decodeChunkedBody(body)
    local chunks = {}
    local position = 1
    while position <= #body do
        local lineEnd = body:find("\r\n", position, true)
        local newlineSize = 2
        if not lineEnd then
            lineEnd = body:find("\n", position, true)
            newlineSize = 1
        end
        if not lineEnd then
            return body
        end
        local sizeText = body:sub(position, lineEnd - 1):match("^%s*([^;]+)")
        local chunkSize = tonumber(sizeText, 16)
        if chunkSize == nil then
            return body
        end
        position = lineEnd + newlineSize
        if chunkSize == 0 then
            break
        end
        table.insert(chunks, body:sub(position, position + chunkSize - 1))
        position = position + chunkSize
        if body:sub(position, position + 1) == "\r\n" then
            position = position + 2
        elseif body:sub(position, position) == "\n" then
            position = position + 1
        end
    end
    return table.concat(chunks)
end

local function httpRequest(method, path, body)
    local okSocket, socket = pcall(require, "socket")
    if not okSocket or type(socket) ~= "table" or type(socket.tcp) ~= "function" then
        return nil, "Resolve Lua socket/TCP module is unavailable. Start Supervisor and install LuaSocket support; this plugin will not use external command fallbacks."
    end
    local parsed, parseError = parseHttpUrl(supervisorUrl())
    if not parsed then
        return nil, parseError
    end
    local tcp = socket.tcp()
    if not tcp then
        return nil, "Unable to create Lua TCP socket."
    end
    pcall(function()
        tcp:settimeout(120)
    end)
    local okConnect, connectError = tcp:connect(parsed.host, parsed.port)
    if not okConnect then
        pcall(function()
            tcp:close()
        end)
        return nil, "Unable to connect to Supervisor at " .. supervisorUrl() .. ": " .. tostring(connectError)
    end

    local requestPath = (parsed.basePath or "") .. path
    if requestPath == "" then
        requestPath = "/"
    end
    local payload = body or ""
    local requestLines = {
        tostring(method or "GET") .. " " .. requestPath .. " HTTP/1.1",
        "Host: " .. parsed.host .. ":" .. tostring(parsed.port),
        "Connection: close",
        "Accept: text/tab-separated-values",
    }
    if payload ~= "" then
        table.insert(requestLines, "Content-Type: application/json; charset=utf-8")
        table.insert(requestLines, "Content-Length: " .. tostring(#payload))
    end
    table.insert(requestLines, "")
    table.insert(requestLines, payload)
    local sent, sendError = tcp:send(table.concat(requestLines, "\r\n"))
    if not sent then
        pcall(function()
            tcp:close()
        end)
        return nil, "Unable to send Supervisor request: " .. tostring(sendError)
    end
    local response, receiveError, partial = tcp:receive("*a")
    pcall(function()
        tcp:close()
    end)
    response = response or partial or ""
    if response == "" then
        return nil, "No response from Supervisor: " .. tostring(receiveError)
    end
    local header, responseBody = response:match("^(.-\r\n\r\n)(.*)$")
    if header == nil then
        header, responseBody = response:match("^(.-\n\n)(.*)$")
    end
    if header == nil then
        return nil, "Malformed Supervisor HTTP response: " .. response:sub(1, 240)
    end
    local status = tonumber(header:match("HTTP/%d%.%d%s+(%d+)") or "")
    if status == nil or status < 200 or status >= 300 then
        return nil, "Supervisor HTTP " .. tostring(status or "?") .. ": " .. tostring(responseBody or ""):sub(1, 500)
    end
    if header:lower():find("transfer%-encoding:%s*chunked") then
        responseBody = decodeChunkedBody(responseBody or "")
    end
    return responseBody or "", nil
end

local function loadVoiceoverConfigSummary()
    local projectName = type(getProjectName) == "function" and getProjectName() or ""
    local output, requestError = supervisorRequest({
        method = "GET",
        path = "/api/resolve-volc-voiceover/config-summary.tsv?resolveProjectName=" .. urlEncode(projectName),
        type = "config-summary",
        resolveProjectName = projectName,
        timeoutSeconds = 8,
    })
    local result = {
        runtimeConfigPath = "",
        hasApiKey = false,
        defaultProfile = "",
        backendVersion = "",
        profiles = {},
        error = "",
        projectId = "",
        projectRoot = "",
        voiceoverMediaStatus = "",
        voiceoverMediaPath = "",
    }
    if output == nil then
        result.error = requestError or "Unable to reach Supervisor."
        return result
    end
    for line in output:gmatch("[^\r\n]+") do
        local fields = splitTabs(line)
        local kind = fields[1]
        if kind == "VERSION" then
            result.backendVersion = fields[2] or ""
        elseif kind == "CONFIG" then
            result.runtimeConfigPath = fields[2] or ""
        elseif kind == "HAS_API_KEY" then
            result.hasApiKey = fields[2] == "1"
        elseif kind == "DEFAULT" then
            result.defaultProfile = fields[2] or ""
        elseif kind == "PROFILE" then
            table.insert(result.profiles, {
                name = fields[2] or "",
                displayName = fields[3] or fields[2] or "",
            })
        elseif kind == "PROJECT" then
            result.projectId = fields[2] or ""
            result.projectRoot = fields[4] or ""
        elseif kind == "VOICEOVER_MEDIA" then
            result.voiceoverMediaStatus = fields[2] or ""
            result.voiceoverMediaPath = fields[3] or ""
        elseif kind == "ERROR" then
            local code = fields[2] or "error"
            local message = fields[3] or line
            result.error = code .. ": " .. message
        end
    end
    if result.error == "" and #(result.profiles or {}) == 0 then
        if output ~= "" then
            result.error = output:gsub("[\r\n]+", " "):sub(1, 240)
        else
            result.error = "No output from Supervisor config summary."
        end
    end
    return result
end

local function profileLabel(profile)
    local display = tostring(profile.displayName or profile.name or "")
    local name = tostring(profile.name or "")
    if display ~= "" and display ~= name then
        return display .. " (" .. name .. ")"
    end
    return name
end

local function profileLabels(config)
    local labels = {}
    for _, profile in ipairs(config.profiles or {}) do
        table.insert(labels, profileLabel(profile))
    end
    if #labels == 0 then
        table.insert(labels, "No profiles in config/runtime.json")
    end
    return labels
end

local function defaultProfileIndex(config)
    local defaultName = tostring(config.defaultProfile or "")
    for index, profile in ipairs(config.profiles or {}) do
        if defaultName ~= "" and profile.name == defaultName then
            return index - 1
        end
    end
    return 0
end

local function profileIndexByName(config, name)
    local profileName = tostring(name or "")
    if profileName == "" then
        return nil
    end
    for index, profile in ipairs(config.profiles or {}) do
        if profile.name == profileName then
            return index - 1
        end
    end
    return nil
end

local function preferredProfileIndex(config, preferredName)
    return profileIndexByName(config, preferredName) or defaultProfileIndex(config)
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

local function waitBriefly(seconds)
    local delay = tonumber(seconds) or 0.1
    if bmd ~= nil and type(bmd.wait) == "function" then
        local ok = pcall(function()
            bmd.wait(delay)
        end)
        if ok then
            return
        end
    end
    if fusion ~= nil and type(fusion.Sleep) == "function" then
        local ok = pcall(function()
            fusion:Sleep(math.max(1, math.floor(delay * 1000)))
        end)
        if ok then
            return
        end
    end
    local untilTime = os.clock() + delay
    while os.clock() < untilTime do
    end
end

local function ipcRequestId()
    ipcCounter = ipcCounter + 1
    local entropy = tostring({}):gsub("[^A-Za-z0-9]", "")
    return os.date("%Y%m%d%H%M%S") .. "-" .. tostring(ipcCounter) .. "-"
        .. tostring(math.floor(os.clock() * 1000000)) .. "-" .. entropy
end

local function fileIpcRequest(request, timeoutSeconds)
    local rootPath = supervisorIpcRoot()
    if rootPath == "" then
        return nil, "Supervisor IPC root is not configured in Fusion/Config/KairosVolcVoiceover/kairos_workspace.json."
    end
    local requestId = ipcRequestId()
    request.requestId = requestId
    request.createdAt = os.date("!%Y-%m-%dT%H:%M:%SZ")

    local requestsDir = rootPath .. "/requests"
    local responsesDir = rootPath .. "/responses"
    local requestPath = requestsDir .. "/" .. requestId .. ".json"
    local requestTmpPath = requestPath .. ".tmp"
    local responsePath = responsesDir .. "/" .. requestId .. ".tsv"
    os.remove(responsePath)
    os.remove(requestPath)
    if not writeText(requestTmpPath, jsonEncode(request) .. "\n") then
        return nil, "Unable to write Supervisor IPC request: " .. requestTmpPath
            .. ". Start/restart Supervisor and reinstall the plugin to recreate IPC directories."
    end
    local renamed, renameError = os.rename(requestTmpPath, requestPath)
    if not renamed then
        os.remove(requestTmpPath)
        return nil, "Unable to publish Supervisor IPC request: " .. tostring(renameError)
    end

    local deadline = os.clock() + (tonumber(timeoutSeconds) or 60)
    while os.clock() < deadline do
        local output = readText(responsePath)
        if output ~= "" then
            os.remove(responsePath)
            return output, nil
        end
        waitBriefly(0.1)
    end
    return nil, "Timed out waiting for Supervisor IPC response. Make sure Kairos Supervisor is running and has loaded the latest build."
end

supervisorRequest = function(request)
    local output, requestError = httpRequest(request.method or "GET", request.path or "/", request.body or "")
    if output ~= nil then
        return output, nil
    end
    appendLog("Supervisor HTTP unavailable; using file IPC fallback: " .. tostring(requestError))
    return fileIpcRequest({
        type = request.type,
        resolveProjectName = request.resolveProjectName,
        job = request.job,
    }, request.timeoutSeconds)
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

function getProjectName()
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

local function countTableValues(value)
    local count = 0
    if type(value) == "table" then
        for _, _ in pairs(value) do
            count = count + 1
        end
    end
    return count
end

local function getTrackItems(timeline, trackType, trackIndex)
    local trackItems = safeCall(timeline, "GetItemListInTrack", trackType, trackIndex)
    if trackItems == nil then
        trackItems = safeCall(timeline, "GetItemsInTrack", trackType, trackIndex)
    end
    if type(trackItems) ~= "table" then
        return {}
    end
    return trackItems
end

local function subtitleTrackLabel(track)
    if track == nil or track.trackIndex == nil then
        return "Select narration track"
    end
    local labelText = "S" .. tostring(track.trackIndex) .. " - " .. tostring(track.itemCount or 0) .. " items"
    local name = trim(track.name)
    if name ~= "" then
        labelText = labelText .. " - " .. name
    end
    return labelText
end

local function collectSubtitleTracks()
    local timeline = getTimeline()
    if not timeline then
        error("No current Resolve timeline.")
    end
    local tracks = {}
    local trackCount = tonumber(safeCall(timeline, "GetTrackCount", "subtitle") or 0) or 0
    for trackIndex = 1, trackCount do
        local trackItems = getTrackItems(timeline, "subtitle", trackIndex)
        table.insert(tracks, {
            trackIndex = trackIndex,
            name = trim(safeCall(timeline, "GetTrackName", "subtitle", trackIndex)),
            itemCount = countTableValues(trackItems),
        })
    end
    return tracks
end

local function replaceSubtitleTrackItems(labels, currentIndex)
    if not (items and items.subtitleTrack) then
        return false
    end
    local combo = items.subtitleTrack
    updatingSubtitleTrackCombo = true
    local ok = pcall(function()
        combo:Clear()
        combo:AddItems(labels)
        combo.CurrentIndex = currentIndex or 0
    end)
    if not ok then
        ok = pcall(function()
            combo:Clear()
            for _, labelText in ipairs(labels) do
                combo:AddItem(labelText)
            end
            combo.CurrentIndex = currentIndex or 0
        end)
    end
    updatingSubtitleTrackCombo = false
    return ok
end

local function selectedSubtitleTrackOption()
    if not (items and items.subtitleTrack) then
        return nil
    end
    local index = tonumber(items.subtitleTrack.CurrentIndex) or 0
    return subtitleTrackOptions[index + 1] or subtitleTrackOptions[index]
end

local function refreshSubtitleTrackOptions()
    local previousTrackIndex = selectedSubtitleTrackIndex
    local currentOption = selectedSubtitleTrackOption()
    if currentOption and currentOption.trackIndex then
        previousTrackIndex = currentOption.trackIndex
    end
    local tracks = collectSubtitleTracks()
    local labels = {}
    subtitleTrackOptions = {}
    local currentIndex = 0
    if #tracks == 0 then
        table.insert(subtitleTrackOptions, {trackIndex = nil, label = "No subtitle tracks"})
    elseif #tracks == 1 then
        table.insert(subtitleTrackOptions, tracks[1])
        currentIndex = 0
    else
        table.insert(subtitleTrackOptions, {trackIndex = nil, label = "Select narration track"})
        for _, track in ipairs(tracks) do
            table.insert(subtitleTrackOptions, track)
            if previousTrackIndex ~= nil and track.trackIndex == previousTrackIndex then
                currentIndex = #subtitleTrackOptions - 1
            end
        end
    end
    for _, option in ipairs(subtitleTrackOptions) do
        table.insert(labels, option.label or subtitleTrackLabel(option))
    end
    replaceSubtitleTrackItems(labels, currentIndex)
    local selected = subtitleTrackOptions[currentIndex + 1]
    selectedSubtitleTrackIndex = selected and selected.trackIndex or nil
    return tracks
end

local function collectSubtitles(trackIndex)
    local timeline = getTimeline()
    if not timeline then
        error("No current Resolve timeline.")
    end
    local selectedTrack = tonumber(trackIndex)
    if selectedTrack == nil then
        error("Select a narration subtitle track.")
    end
    local frameRate = fps()
    local result = {}
    local trackItems = getTrackItems(timeline, "subtitle", selectedTrack)
    for _, item in pairs(trackItems) do
        local itemType = type(item)
        if itemType == "table" or itemType == "userdata" then
            table.insert(result, summarizeItem(item, selectedTrack, #result + 1, frameRate))
        end
    end
    table.sort(result, function(left, right)
        if left.startFrame == right.startFrame then
            return left.subtitleIndex < right.subtitleIndex
        end
        return left.startFrame < right.startFrame
    end)
    for index, row in ipairs(result) do
        row.subtitleIndex = index
    end
    return result
end

local function setTreeItemText(item, column, value)
    local text = tostring(value or "")
    local ok = pcall(function()
        item.Text[column] = text
    end)
    if not ok then
        pcall(function()
            item.Text[column + 1] = text
        end)
    end
end

local function treeItemText(item, column)
    local ok, value = pcall(function()
        return item.Text[column]
    end)
    if ok and value ~= nil then
        return tostring(value)
    end
    ok, value = pcall(function()
        return item.Text[column + 1]
    end)
    if ok and value ~= nil then
        return tostring(value)
    end
    return ""
end

local function updateSelectionStatus()
    if not (items and items.selectionStatus and items.subtitleTree) then
        return
    end
    local count = #subtitleSelectedIds
    local uiCount = 0
    local selected = safeCall(items.subtitleTree, "SelectedItems")
    if type(selected) == "table" then
        for _, item in pairs(selected) do
            local id = tonumber(treeItemText(item, 0))
            if id ~= nil then
                uiCount = uiCount + 1
            end
        end
    end
    if uiCount > count then
        count = uiCount
    end
    items.selectionStatus.Text = "Selected: " .. tostring(count)
end

local function newTreeItem(tree)
    local item = safeCall(tree, "NewItem")
    if item ~= nil then
        return item
    end
    if ui and ui.TreeItem then
        local ok, created = pcall(function()
            return ui:TreeItem({})
        end)
        if ok then
            return created
        end
        ok, created = pcall(function()
            return ui:TreeItem()
        end)
        if ok then
            return created
        end
    end
    return nil
end

local function applySubtitleTreeColumns()
    if not (items and items.subtitleTree) then
        return
    end
    local tree = items.subtitleTree
    pcall(function()
        tree.ColumnCount = 6
    end)
    pcall(function()
        tree:SetHeaderLabels({"ID", "Track", "In", "Out", "Ms", "Text"})
    end)
    pcall(function()
        tree.ColumnWidth[0] = 42
        tree.ColumnWidth[1] = 48
        tree.ColumnWidth[2] = 88
        tree.ColumnWidth[3] = 88
        tree.ColumnWidth[4] = 58
        tree.ColumnWidth[5] = 390
    end)
end

local function renderSubtitleList()
    if not (items and items.subtitleTree) then
        return
    end
    local tree = items.subtitleTree
    safeCall(tree, "Clear")
    subtitleTreeItems = {}
    subtitleSelectedIds = {}
    subtitleSelectionAnchorId = nil
    subtitleLocateAnchorId = nil
    applySubtitleTreeColumns()
    for _, row in ipairs(subtitles) do
        local text = row.text
        if text == "" then
            text = "(no readable text)"
        end
        if #text > 120 then
            text = text:sub(1, 120) .. "..."
        end
        local item = newTreeItem(tree)
        if item ~= nil then
            setTreeItemText(item, 0, string.format("%03d", row.subtitleIndex))
            setTreeItemText(item, 1, "T" .. tostring(row.trackIndex))
            setTreeItemText(item, 2, row.startTimecode)
            setTreeItemText(item, 3, row.endTimecode)
            setTreeItemText(item, 4, string.format("%.0f", tonumber(row.durationMs or 0)))
            setTreeItemText(item, 5, text)
            safeCall(tree, "AddTopLevelItem", item)
            subtitleTreeItems[row.subtitleIndex] = item
        end
    end
    if #subtitles == 0 then
        local item = newTreeItem(tree)
        if item ~= nil then
            setTreeItemText(item, 0, "")
            if selectedSubtitleTrackIndex == nil then
                setTreeItemText(item, 5, "Select a narration subtitle track before loading subtitles.")
            else
                setTreeItemText(item, 5, "No subtitle items found on the selected subtitle track.")
            end
            pcall(function()
                item.Disabled = true
            end)
            safeCall(tree, "AddTopLevelItem", item)
        end
    end
    updateSelectionStatus()
end

local function loadSelectedSubtitleTrack(reason)
    local option = selectedSubtitleTrackOption()
    selectedSubtitleTrackIndex = option and option.trackIndex or nil
    if selectedSubtitleTrackIndex == nil then
        subtitles = {}
        renderSubtitleList()
        if option and option.label == "No subtitle tracks" then
            uiLog("No subtitle tracks found on the current timeline.")
        else
            uiLog("Select a narration subtitle track.")
        end
        return
    end
    local ok, result = pcall(function()
        return collectSubtitles(selectedSubtitleTrackIndex)
    end)
    if not ok then
        uiLog("Refresh failed: " .. tostring(result))
        return
    end
    subtitles = result
    renderSubtitleList()
    uiLog(
        tostring(reason or "Loaded")
            .. " " .. tostring(#subtitles)
            .. " subtitle item(s) from S" .. tostring(selectedSubtitleTrackIndex) .. "."
    )
end

local function refreshSubtitles(ev)
    local ok, result = pcall(refreshSubtitleTrackOptions)
    if not ok then
        uiLog("Refresh failed: " .. tostring(result))
        return
    end
    loadSelectedSubtitleTrack("Loaded")
end

local function subtitleTrackChanged(ev)
    if updatingSubtitleTrackCombo then
        return
    end
    local option = selectedSubtitleTrackOption()
    local comboTrackIndex = option and option.trackIndex or nil
    if comboTrackIndex == selectedSubtitleTrackIndex then
        return
    end
    loadSelectedSubtitleTrack("Loaded")
end

local function ensureSelectedSubtitleTrackLoaded()
    local option = selectedSubtitleTrackOption()
    local comboTrackIndex = option and option.trackIndex or nil
    if comboTrackIndex ~= selectedSubtitleTrackIndex then
        loadSelectedSubtitleTrack("Loaded")
    end
    return selectedSubtitleTrackIndex ~= nil
end

local function normalizeSubtitleIds(rawIds)
    local normalized = {}
    local seen = {}
    for _, raw in ipairs(rawIds or {}) do
        local value = tonumber(raw)
        if value and value >= 1 and value <= #subtitles and subtitleTreeItems[value] and not seen[value] then
            table.insert(normalized, value)
            seen[value] = true
        end
    end
    table.sort(normalized)
    return normalized
end

local function treeSelectedIds()
    local ids = {}
    local seen = {}
    local selected = safeCall(items.subtitleTree, "SelectedItems")
    if type(selected) == "table" then
        for _, item in pairs(selected) do
            local value = tonumber(treeItemText(item, 0))
            if value and value >= 1 and value <= #subtitles and not seen[value] then
                table.insert(ids, value)
                seen[value] = true
            end
        end
    end
    table.sort(ids)
    return ids
end

local function selectedIds()
    return normalizeSubtitleIds(subtitleSelectedIds)
end

local function selectedIdsSet(ids)
    local result = {}
    for _, id in ipairs(ids or {}) do
        result[id] = true
    end
    return result
end

local function sameIdSet(left, right)
    local leftSet = selectedIdsSet(left)
    local rightSet = selectedIdsSet(right)
    for key, _ in pairs(leftSet) do
        if not rightSet[key] then
            return false
        end
    end
    for key, _ in pairs(rightSet) do
        if not leftSet[key] then
            return false
        end
    end
    return true
end

local function idsAreContiguous(ids)
    if #ids <= 1 then
        return true
    end
    for index = 2, #ids do
        if tonumber(ids[index]) ~= tonumber(ids[index - 1]) + 1 then
            return false
        end
    end
    return true
end

local function treeCurrentId(tree)
    if tree == nil then
        return nil
    end
    local candidates = {}
    pcall(function()
        table.insert(candidates, tree.CurrentItem)
    end)
    pcall(function()
        table.insert(candidates, tree.CurrentIndex)
    end)
    for _, candidate in ipairs(candidates) do
        if type(candidate) == "number" then
            if subtitleTreeItems[candidate] then
                return candidate
            end
            if subtitleTreeItems[candidate + 1] then
                return candidate + 1
            end
        elseif candidate ~= nil then
            local id = tonumber(treeItemText(candidate, 0))
            if id ~= nil and subtitleTreeItems[id] then
                return id
            end
        end
    end
    return nil
end

local function inferRangeEndpoint(ids, anchorId)
    local minId = nil
    local maxId = nil
    for _, id in ipairs(ids or {}) do
        minId = minId == nil and id or math.min(minId, id)
        maxId = maxId == nil and id or math.max(maxId, id)
    end
    if minId == nil or maxId == nil then
        return nil
    end
    if anchorId <= minId then
        return maxId
    end
    if anchorId >= maxId then
        return minId
    end
    local downCount = anchorId - minId
    local upCount = maxId - anchorId
    -- Fusion/Qt may keep an old Shift anchor after Locate. When the plugin
    -- anchor sits inside a huge UI-selected range, keep the boundary nearest
    -- to the plugin anchor instead of preserving the stale far-side range.
    if upCount <= downCount then
        return maxId
    end
    return minId
end

local function rangeIds(anchorId, currentId)
    local ids = {}
    local first = math.min(anchorId, currentId)
    local last = math.max(anchorId, currentId)
    for id = first, last do
        if subtitleTreeItems[id] then
            table.insert(ids, id)
        end
    end
    return ids
end

local function treeSetItemSelected(tree, item, selected)
    safeCall(tree, "SetItemSelected", item, selected == true)
    safeCall(tree, "SetItemSelected", item, selected == true, 0)
    pcall(function()
        item.Selected = selected == true
    end)
end

local function treeClearSelection(tree)
    safeCall(tree, "ClearSelection")
    safeCall(tree, "clearSelection")
    for _, item in pairs(subtitleTreeItems) do
        treeSetItemSelected(tree, item, false)
    end
end

local function treeSetCurrentItem(tree, item)
    if item == nil then
        return
    end
    safeCall(tree, "SetCurrentItem", item)
    safeCall(tree, "setCurrentItem", item)
    safeCall(tree, "SetCurrentItem", item, 0)
    safeCall(tree, "setCurrentItem", item, 0)
    pcall(function()
        tree.CurrentItem = item
    end)
    pcall(function()
        tree.CurrentIndex = item
    end)
    safeCall(tree, "SetFocus")
    safeCall(tree, "setFocus")
end

local function setSelectedIds(ids, scrollToFirst, anchorId, currentId)
    local tree = items and items.subtitleTree or nil
    if tree == nil then
        return
    end
    ids = normalizeSubtitleIds(ids)
    subtitleSelectedIds = ids
    local wanted = {}
    local firstItem = nil
    for _, id in ipairs(ids) do
        local value = tonumber(id)
        if value and subtitleTreeItems[value] then
            wanted[value] = true
            if firstItem == nil then
                firstItem = subtitleTreeItems[value]
            end
        end
    end
    repairingSubtitleSelection = true
    treeClearSelection(tree)
    for id, item in pairs(subtitleTreeItems) do
        treeSetItemSelected(tree, item, wanted[id] == true)
    end
    local currentItem = nil
    if currentId ~= nil and subtitleTreeItems[currentId] then
        currentItem = subtitleTreeItems[currentId]
    end
    if scrollToFirst and firstItem ~= nil then
        treeSetCurrentItem(tree, currentItem or firstItem)
        safeCall(tree, "ScrollToItem", firstItem)
        safeCall(tree, "scrollToItem", firstItem)
    elseif currentItem ~= nil then
        treeSetCurrentItem(tree, currentItem)
    end
    repairingSubtitleSelection = false
    if #ids == 0 then
        subtitleSelectionAnchorId = nil
    else
        subtitleSelectionAnchorId = tonumber(anchorId) or tonumber(ids[1])
    end
    updateSelectionStatus()
end

local function onSubtitleSelectionChanged(ev)
    if repairingSubtitleSelection then
        updateSelectionStatus()
        return
    end
    local ids = treeSelectedIds()
    if #ids == 0 then
        subtitleSelectedIds = {}
        subtitleSelectionAnchorId = nil
        updateSelectionStatus()
        return
    end
    if #ids == 1 then
        subtitleSelectedIds = normalizeSubtitleIds(ids)
        subtitleSelectionAnchorId = ids[1]
        updateSelectionStatus()
        return
    end

    local anchorId = tonumber(subtitleSelectionAnchorId)
    if anchorId ~= nil and subtitleTreeItems[anchorId] and idsAreContiguous(ids) then
        local currentId = treeCurrentId(items and items.subtitleTree or nil)
        if currentId == nil or currentId == anchorId or not subtitleTreeItems[currentId] then
            currentId = inferRangeEndpoint(ids, anchorId)
        end
        if currentId ~= nil and currentId ~= anchorId and subtitleTreeItems[currentId] then
            local corrected = rangeIds(anchorId, currentId)
            if #corrected > 0 and not sameIdSet(ids, corrected) then
                setSelectedIds(corrected, false, anchorId, currentId)
                updateSelectionStatus()
                return
            end
        end
    end
    subtitleSelectedIds = normalizeSubtitleIds(ids)
    updateSelectionStatus()
end

local function reconcileTreeSelectionForAction()
    local ids = treeSelectedIds()
    if #ids == 0 then
        return selectedIds()
    end
    local internalIds = selectedIds()
    if #ids == 1 and #internalIds > 1 then
        return internalIds
    end
    local anchorId = tonumber(subtitleSelectionAnchorId)
    if #ids > 1 and anchorId ~= nil and subtitleTreeItems[anchorId] and idsAreContiguous(ids) then
        local currentId = treeCurrentId(items and items.subtitleTree or nil)
        if currentId == nil or currentId == anchorId or not subtitleTreeItems[currentId] then
            currentId = inferRangeEndpoint(ids, anchorId)
        end
        if currentId ~= nil and currentId ~= anchorId and subtitleTreeItems[currentId] then
            ids = rangeIds(anchorId, currentId)
        end
    end
    subtitleSelectedIds = normalizeSubtitleIds(ids)
    updateSelectionStatus()
    return selectedIds()
end

local function clearSelection(ev)
    subtitleLocateAnchorId = nil
    setSelectedIds({}, false)
    uiLog("Cleared subtitle selection.")
end

local function selectIdsMatching(predicate, scrollToFirst)
    local ids = {}
    for _, row in ipairs(subtitles) do
        if predicate(row) then
            table.insert(ids, row.subtitleIndex)
        end
    end
    setSelectedIds(ids, scrollToFirst)
    return ids
end

local function selectRangeFromLocateAnchor(ev)
    if not ensureSelectedSubtitleTrackLoaded() then
        return
    end
    local anchorId = tonumber(subtitleLocateAnchorId) or tonumber(subtitleSelectionAnchorId)
    if anchorId == nil or not subtitleTreeItems[anchorId] then
        uiLog("Locate an anchor subtitle first, then click the range end row and press Range.")
        return
    end

    local targetId = treeCurrentId(items and items.subtitleTree or nil)
    local uiIds = treeSelectedIds()
    if targetId == nil or not subtitleTreeItems[targetId] then
        if #uiIds == 1 then
            targetId = uiIds[1]
        elseif #uiIds > 1 and idsAreContiguous(uiIds) then
            targetId = inferRangeEndpoint(uiIds, anchorId)
        elseif #uiIds > 1 then
            targetId = uiIds[#uiIds]
        end
    end
    if targetId == nil or not subtitleTreeItems[targetId] then
        uiLog("Click the subtitle row that should end the range, then press Range.")
        return
    end

    local ids = rangeIds(anchorId, targetId)
    setSelectedIds(ids, false, anchorId, targetId)
    subtitleLocateAnchorId = anchorId
    uiLog(
        "Selected range #"
            .. tostring(anchorId)
            .. "-#"
            .. tostring(targetId)
            .. " ("
            .. tostring(#ids)
            .. " subtitle(s))."
    )
end

local function currentFrameCandidates()
    local timeline = getTimeline()
    local frameRate = fps()
    local timecode = safeCall(timeline, "GetCurrentTimecode")
    local rawFrame = timecodeToFrame(timecode, frameRate)
    if rawFrame == nil then
        return {}, tostring(timecode or "")
    end
    local candidates = {}
    local seen = {}
    local function addCandidate(value, label)
        local number = tonumber(value)
        if number == nil then
            return
        end
        local frame = math.floor(number + 0.5)
        if seen[frame] then
            return
        end
        seen[frame] = true
        table.insert(candidates, {frame = frame, label = label})
    end
    addCandidate(rawFrame, "timecode")
    local startTimecodeFrame = timecodeToFrame(safeCall(timeline, "GetStartTimecode"), frameRate)
    local startFrame = tonumber(safeCall(timeline, "GetStartFrame"))
    if startTimecodeFrame ~= nil then
        addCandidate(rawFrame - startTimecodeFrame, "timecode-startTimecode")
        if startFrame ~= nil then
            addCandidate(rawFrame - startTimecodeFrame + startFrame, "timecode-startTimecode+startFrame")
        end
    end
    if startFrame ~= nil then
        addCandidate(rawFrame - startFrame, "timecode-startFrame")
    end
    return candidates, tostring(timecode or "")
end

local function subtitleIdsAtFrame(frame)
    local ids = {}
    for _, row in ipairs(subtitles) do
        local startFrame = tonumber(row.startFrame)
        local endFrame = tonumber(row.endFrame)
        if startFrame ~= nil and endFrame ~= nil and startFrame <= frame and frame < endFrame then
            table.insert(ids, row.subtitleIndex)
        end
    end
    return ids
end

local function nearestSubtitleGap(frame)
    local previousRow = nil
    local nextRow = nil
    for _, row in ipairs(subtitles) do
        local startFrame = tonumber(row.startFrame)
        local endFrame = tonumber(row.endFrame)
        if startFrame ~= nil and endFrame ~= nil then
            if endFrame <= frame and (previousRow == nil or endFrame > tonumber(previousRow.endFrame or -1)) then
                previousRow = row
            end
            if frame < startFrame and (nextRow == nil or startFrame < tonumber(nextRow.startFrame or 999999999)) then
                nextRow = row
            end
        end
    end
    local parts = {}
    if previousRow ~= nil then
        table.insert(parts, "prev #" .. tostring(previousRow.subtitleIndex) .. " ends " .. tostring(previousRow.endTimecode or previousRow.endFrame))
    end
    if nextRow ~= nil then
        table.insert(parts, "next #" .. tostring(nextRow.subtitleIndex) .. " starts " .. tostring(nextRow.startTimecode or nextRow.startFrame))
    end
    if #parts == 0 then
        return ""
    end
    return " (" .. table.concat(parts, ", ") .. ")"
end

local function usePlayhead(ev)
    if not ensureSelectedSubtitleTrackLoaded() then
        return
    end
    local candidates, timecode = currentFrameCandidates()
    if #candidates == 0 then
        uiLog("Unable to read playhead frame.")
        return
    end
    for _, candidate in ipairs(candidates) do
        local ids = subtitleIdsAtFrame(candidate.frame)
        if #ids > 0 then
            subtitleLocateAnchorId = ids[1]
            setSelectedIds(ids, true, ids[1], ids[1])
            uiLog(
                "Located " .. tostring(#ids)
                    .. " subtitle(s) at frame " .. tostring(candidate.frame)
                    .. " (tc=" .. tostring(timecode)
                    .. ", mode=" .. tostring(candidate.label) .. ")."
            )
            return
        end
    end
    local frame = candidates[1].frame
    subtitleLocateAnchorId = nil
    setSelectedIds({}, false)
    uiLog(
        "Located 0 subtitle(s) at frame " .. tostring(frame)
            .. " (tc=" .. tostring(timecode) .. ")"
            .. nearestSubtitleGap(frame) .. "."
    )
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
    if not ensureSelectedSubtitleTrackLoaded() then
        return
    end
    local markIn, markOut = markRange()
    if not markIn or not markOut then
        uiLog("No Resolve In/Out range found. Set it on the timeline with I and O, then click Select Resolve I/O.")
        return
    end
    local ids = selectIdsMatching(function(row)
        if rangesOverlap(markIn, markOut, row.startFrame, row.endFrame) then
            return true
        end
        return false
    end, true)
    uiLog("Selected " .. tostring(#ids) .. " subtitle(s) in Resolve In/Out.")
end

local function selectedSubtitles()
    local selected = {}
    for _, id in ipairs(reconcileTreeSelectionForAction()) do
        table.insert(selected, subtitles[id])
    end
    return selected
end

local function firstTableValue(value)
    if type(value) ~= "table" then
        return nil
    end
    if value[1] ~= nil then
        return value[1]
    end
    for _, item in pairs(value) do
        return item
    end
    return nil
end

local function getMediaPool()
    local project = getProject()
    return safeCall(project, "GetMediaPool")
end

local function folderName(folder)
    return trim(safeCall(folder, "GetName"))
end

local function findChildFolder(parent, name)
    local children = safeCall(parent, "GetSubFolderList")
    if type(children) ~= "table" then
        return nil
    end
    for _, child in pairs(children) do
        if folderName(child) == name then
            return child
        end
    end
    return nil
end

local function ensureChildFolder(mediaPool, parent, name)
    local existing = findChildFolder(parent, name)
    if existing ~= nil then
        return existing
    end
    local created = safeCall(mediaPool, "AddSubFolder", parent, name)
    if created ~= nil then
        return created
    end
    return findChildFolder(parent, name)
end

local function ensureVoiceoverMediaFolder(timelineName)
    local mediaPool = getMediaPool()
    if not mediaPool then
        return nil, "Resolve Media Pool is unavailable."
    end
    local rootFolder = safeCall(mediaPool, "GetRootFolder")
    if not rootFolder then
        return nil, "Resolve Media Pool root folder is unavailable."
    end
    local voiceRoot = ensureChildFolder(mediaPool, rootFolder, "Kairos Voiceover")
    if not voiceRoot then
        return nil, "Unable to create or find Media Pool bin Kairos Voiceover."
    end
    local timelineFolder = ensureChildFolder(mediaPool, voiceRoot, trim(timelineName) ~= "" and trim(timelineName) or "Timeline")
    if not timelineFolder then
        return nil, "Unable to create or find timeline voiceover Media Pool bin."
    end
    return timelineFolder, nil
end

local function timelineItemBounds(item)
    local startFrame = timelineNumber(item, "GetStart")
    local endFrame = timelineNumber(item, "GetEnd")
    local durationFrames = timelineNumber(item, "GetDuration")
    if startFrame == nil and endFrame ~= nil and durationFrames ~= nil then
        startFrame = endFrame - durationFrames
    end
    if endFrame == nil and startFrame ~= nil and durationFrames ~= nil then
        endFrame = startFrame + durationFrames
    end
    return tonumber(startFrame), tonumber(endFrame)
end

local function trackIsUsable(timeline, index)
    local enabled = safeCall(timeline, "GetIsTrackEnabled", "audio", index)
    local locked = safeCall(timeline, "GetIsTrackLocked", "audio", index)
    return enabled ~= false and locked ~= true
end

local function trackItems(timeline, index)
    return getTrackItems(timeline, "audio", index)
end

local function trackIsEmpty(timeline, index)
    return countTableValues(trackItems(timeline, index)) == 0
end

local function trackHasOverlap(timeline, index, startFrame, endFrame)
    for _, item in pairs(trackItems(timeline, index)) do
        local itemStart, itemEnd = timelineItemBounds(item)
        if itemStart ~= nil and itemEnd ~= nil and rangesOverlap(startFrame, endFrame, itemStart, itemEnd) then
            return true
        end
    end
    return false
end

local function trackName(timeline, index)
    return trim(safeCall(timeline, "GetTrackName", "audio", index))
end

local function chooseVoiceTrack(unit)
    local timeline = getTimeline()
    if not timeline then
        return nil, "No current timeline."
    end
    local trackCount = tonumber(safeCall(timeline, "GetTrackCount", "audio") or 0) or 0
    local recordFrame = tonumber(unit.recordFrame) or 0
    local durationFrames = tonumber(unit.durationFrames) or nil
    local targetDurationMs = tonumber(unit.targetDurationMs) or nil
    if durationFrames == nil and targetDurationMs ~= nil then
        durationFrames = math.max(1, math.floor(targetDurationMs * fps() / 1000.0 + 0.5))
    end
    durationFrames = durationFrames or math.max(1, math.floor(fps() + 0.5))
    local endFrame = recordFrame + durationFrames

    for index = 2, trackCount do
        if trackIsUsable(timeline, index) and trackIsEmpty(timeline, index) then
            return index, nil
        end
    end
    for index = 2, trackCount do
        if trackIsUsable(timeline, index)
            and trackName(timeline, index) == VOICE_TRACK_NAME
            and not trackHasOverlap(timeline, index, recordFrame, endFrame) then
            return index, nil
        end
    end
    for index = 2, trackCount do
        if trackIsUsable(timeline, index) and not trackHasOverlap(timeline, index, recordFrame, endFrame) then
            return index, nil
        end
    end

    local added = safeCall(timeline, "AddTrack", "audio", "stereo")
    if added == nil or added == false then
        return nil, "Unable to add audio track for " .. VOICE_TRACK_NAME .. "."
    end
    local newIndex = (tonumber(safeCall(timeline, "GetTrackCount", "audio") or 0) or trackCount + 1)
    safeCall(timeline, "SetTrackName", "audio", newIndex, VOICE_TRACK_NAME)
    return newIndex, nil
end

local function importAudioToMediaPool(mediaFolder, audioPath)
    local mediaPool = getMediaPool()
    if not mediaPool then
        return nil, "Resolve Media Pool is unavailable."
    end
    local previousFolder = safeCall(mediaPool, "GetCurrentFolder")
    safeCall(mediaPool, "SetCurrentFolder", mediaFolder)
    local imported = safeCall(mediaPool, "ImportMedia", {audioPath})
    if previousFolder ~= nil then
        safeCall(mediaPool, "SetCurrentFolder", previousFolder)
    end
    local item = firstTableValue(imported)
    if item == nil then
        return nil, "ImportMedia returned no MediaPoolItem for " .. tostring(audioPath)
    end
    return item, nil
end

local function appendVoiceoverUnit(mediaFolder, unit)
    local mediaPool = getMediaPool()
    if not mediaPool then
        return false, "Resolve Media Pool is unavailable."
    end
    local audioPath = trim(unit.resolveAudioPath)
    if audioPath == "" then
        return false, "Supervisor returned an empty audio path for unit " .. tostring(unit.unitId)
    end
    local mediaItem, importError = importAudioToMediaPool(mediaFolder, audioPath)
    if not mediaItem then
        return false, importError
    end
    local trackIndex, trackError = chooseVoiceTrack(unit)
    if not trackIndex then
        return false, trackError
    end
    local recordFrame = tonumber(unit.recordFrame) or 0
    local appended = safeCall(mediaPool, "AppendToTimeline", {{
        mediaPoolItem = mediaItem,
        mediaType = 2,
        trackIndex = trackIndex,
        recordFrame = recordFrame,
    }})
    local timelineItem = firstTableValue(appended)
    if timelineItem == nil then
        return false, "AppendToTimeline returned no item for " .. tostring(unit.unitId)
    end
    safeCall(timelineItem, "SetName", "Kairos VO " .. tostring(unit.unitId or ""))
    safeCall(timelineItem, "AddMarker", 0, "Blue", "Kairos VO", "", 1, "kairosVoiceoverUnitId=" .. tostring(unit.unitId or ""))
    return true, "Inserted " .. tostring(unit.unitId) .. " on A" .. tostring(trackIndex)
end

local function saveProject()
    local currentResolve = getResolve()
    local manager = safeCall(currentResolve, "GetProjectManager")
    return safeCall(manager, "SaveProject")
end

local function parseSynthesizeTsv(output)
    local result = {
        ok = false,
        manifestPath = "",
        units = {},
        error = "",
    }
    for line in tostring(output or ""):gmatch("[^\r\n]+") do
        local fields = splitTabs(line)
        local kind = fields[1]
        if kind == "OK" then
            result.ok = true
            result.manifestPath = fields[2] or ""
            result.unitCount = tonumber(fields[3]) or 0
        elseif kind == "UNIT" then
            table.insert(result.units, {
                unitId = fields[2] or "",
                resolveAudioPath = fields[3] or "",
                recordFrame = tonumber(fields[4]) or 0,
                durationStatus = fields[5] or "unknown",
                durationMs = tonumber(fields[6] or ""),
                targetDurationMs = tonumber(fields[7] or ""),
                overflowMs = tonumber(fields[8] or ""),
            })
        elseif kind == "ERROR" then
            local code = fields[2] or "error"
            local message = fields[3] or line
            result.error = code .. ": " .. message
        end
    end
    if result.error == "" and not result.ok then
        result.error = tostring(output or "Supervisor returned no OK row."):sub(1, 500)
    end
    return result
end

local function selectedProfile()
    if not voiceConfig or #(voiceConfig.profiles or {}) == 0 then
        return nil
    end
    local index = tonumber(items.profile.CurrentIndex)
    if index ~= nil then
        if voiceConfig.profiles[index + 1] then
            return voiceConfig.profiles[index + 1]
        end
        if voiceConfig.profiles[index] then
            return voiceConfig.profiles[index]
        end
    end
    local currentText = tostring(items.profile.CurrentText or items.profile.Text or "")
    for _, profile in ipairs(voiceConfig.profiles) do
        if profileLabel(profile) == currentText or profile.name == currentText then
            return profile
        end
    end
    return voiceConfig.profiles[1]
end

local function currentSettings()
    local profile = selectedProfile()
    local settings = {
        profileName = profile and profile.name or "",
    }
    local speed = tonumber(trim(items.speed.Text or ""))
    local loudness = tonumber(trim(items.loudness.Text or ""))
    if speed ~= nil then
        settings.speedRatio = speed
    end
    if loudness ~= nil then
        settings.loudnessRatio = loudness
    end
    return settings
end

local function openRuntimeConfig(ev)
    if voiceConfig and voiceConfig.runtimeConfigPath ~= "" then
        uiLog("Runtime config path: " .. tostring(voiceConfig.runtimeConfigPath))
    else
        uiLog("No Kairos runtime config path found.")
    end
end

local function voiceConfigStatusLine()
    if not voiceConfig then
        return "Voice config: not loaded"
    end
    if voiceConfig.error ~= "" then
        return "Voice config error: " .. voiceConfig.error
    end
    local defaultName = tostring(voiceConfig.defaultProfile or "")
    local suffix = ""
    if defaultName ~= "" then
        suffix = ", default=" .. defaultName
    end
    if tostring(voiceConfig.runtimeConfigPath or "") ~= "" then
        suffix = suffix .. ", path=" .. tostring(voiceConfig.runtimeConfigPath)
    end
    if tostring(voiceConfig.backendVersion or "") ~= "" then
        suffix = suffix .. ", supervisor=" .. tostring(voiceConfig.backendVersion)
    end
    if tostring(voiceConfig.projectId or "") ~= "" then
        suffix = suffix .. ", project=" .. tostring(voiceConfig.projectId)
    end
    if tostring(voiceConfig.voiceoverMediaStatus or "") ~= "" then
        suffix = suffix .. ", media=" .. tostring(voiceConfig.voiceoverMediaStatus)
    end
    return "Voice config: " .. tostring(#(voiceConfig.profiles or {})) .. " profile(s), "
        .. "apiKey=" .. (voiceConfig.hasApiKey and "configured" or "missing")
        .. suffix
end

local function replaceProfileItems(labels, currentIndex)
    if not (items and items.profile) then
        return false
    end
    local combo = items.profile
    local ok = pcall(function()
        combo:Clear()
        combo:AddItems(labels)
        combo.CurrentIndex = currentIndex or 0
    end)
    if ok then
        return true
    end
    ok = pcall(function()
        combo:Clear()
        for _, labelText in ipairs(labels) do
            combo:AddItem(labelText)
        end
        combo.CurrentIndex = currentIndex or 0
    end)
    return ok
end

local function reloadVoiceoverConfig(silent)
    local previousName = ""
    if voiceConfig and items and items.profile then
        local previous = selectedProfile()
        previousName = previous and previous.name or ""
    end
    voiceConfig = loadVoiceoverConfigSummary()
    local labels = profileLabels(voiceConfig)
    local updated = replaceProfileItems(labels, preferredProfileIndex(voiceConfig, previousName))
    if silent ~= true then
        uiLog(voiceConfigStatusLine())
        if not updated then
            uiLog("Profile dropdown did not update live. Close and reopen the panel.")
        end
    end
    return updated
end

local function synthesizeAndInsert()
    reloadVoiceoverConfig(true)
    if not ensureSelectedSubtitleTrackLoaded() then
        uiLog("Select a narration subtitle track before inserting voiceover.")
        return
    end
    local selected = selectedSubtitles()
    if #selected == 0 then
        uiLog("No subtitle rows selected.")
        return
    end
    if not selectedProfile() then
        uiLog("No voice profile configured. Add voiceover.profiles[] in config/runtime.json.")
        return
    end
    if not (voiceConfig and voiceConfig.hasApiKey) then
        uiLog("Volcengine API key missing. Set voiceover.volcApiKey in config/runtime.json.")
        return
    end
    local job = {
        resolveProjectName = getProjectName(),
        timelineName = getTimelineName(),
        timelineId = stableTimelineId(),
        runId = os.date("%Y%m%d-%H%M%S"),
        subtitleTrackIndex = selectedSubtitleTrackIndex,
        subtitles = selected,
        settings = currentSettings(),
    }
    if #selected > 1 then
        uiLog("Requesting Supervisor synthesis for " .. tostring(#selected) .. " subtitle(s) as one merged voiceover...")
    else
        uiLog("Requesting Supervisor synthesis for 1 subtitle...")
    end
    local body = jsonEncode(job)
    local output, requestError = supervisorRequest({
        method = "POST",
        path = "/api/resolve-volc-voiceover/synthesize.tsv",
        body = body,
        type = "synthesize",
        job = job,
        timeoutSeconds = 180,
    })
    if output == nil then
        uiLog(requestError or "Supervisor synthesis request failed.")
        return
    end
    local result = parseSynthesizeTsv(output)
    if result.error ~= "" then
        uiLog("Supervisor synthesis failed: " .. result.error)
        return
    end
    if #result.units == 0 then
        uiLog("Supervisor returned no audio units.")
        return
    end

    local mediaFolder, folderError = ensureVoiceoverMediaFolder(getTimelineName())
    if not mediaFolder then
        uiLog(folderError)
        return
    end

    local inserted = 0
    local skipped = 0
    for _, unit in ipairs(result.units) do
        if items.skipOverflow.Checked == true and unit.durationStatus == "overflow" then
            skipped = skipped + 1
            uiLog("Skipped overflow unit " .. tostring(unit.unitId) .. " (" .. tostring(unit.overflowMs or "?") .. "ms over).")
        else
            local ok, message = appendVoiceoverUnit(mediaFolder, unit)
            if ok then
                inserted = inserted + 1
                uiLog(message)
            else
                uiLog("Insert failed for " .. tostring(unit.unitId) .. ": " .. tostring(message))
            end
        end
    end
    saveProject()
    local suffix = ""
    if result.manifestPath ~= "" then
        suffix = ", manifest=" .. result.manifestPath
    end
    uiLog("Voiceover insert complete: inserted=" .. tostring(inserted) .. ", skipped=" .. tostring(skipped) .. suffix)
end

local function synthesizeInsert(ev)
    synthesizeAndInsert()
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
        .. ", subtitleTrack=" .. tostring(selectedSubtitleTrackIndex or "none")
        .. ", subtitles=" .. tostring(#subtitles)
        .. ", voiceTrack=" .. VOICE_TRACK_NAME
    )
end

local function openLogs(ev)
    uiLog("Log directory path: " .. logDir())
end

appendLog("lua plugin start root=" .. tostring(root))
ui = fusion and fusion.UIManager
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

local smallFont = ui:Font({PixelSize = 12})
local titleFont = ui:Font({PixelSize = 13})

local function button(id, text, width)
    return ui:Button({
        ID = id,
        Text = text,
        Weight = 0,
        Font = smallFont,
        MinimumSize = {width, 24},
        MaximumSize = {width, 24},
    })
end

local function label(text, width)
    return ui:Label({
        Text = text,
        Weight = 0,
        Font = smallFont,
        MinimumSize = {width, 22},
        MaximumSize = {width, 22},
    })
end

local function lineEdit(id, text, placeholder, width)
    return ui:LineEdit({
        ID = id,
        Text = text or "",
        PlaceholderText = placeholder or "",
        Weight = 0,
        Font = smallFont,
        MinimumSize = {width, 24},
        MaximumSize = {width, 24},
    })
end

voiceConfig = {
    runtimeConfigPath = "",
    hasApiKey = false,
    defaultProfile = "",
    profiles = {},
    error = "",
}
local initialProfileLabels = {"Loading profiles..."}
local initialSubtitleTrackLabels = {"Loading tracks..."}
local win = dispatcher:AddWindow({
    ID = WINDOW_ID,
    Geometry = {160, 160, 760, 420},
    WindowTitle = "Kairos Volc Voiceover " .. PLUGIN_VERSION,
},
ui:VGroup({
    ui:Label({Text = "Kairos Volc Voiceover " .. PLUGIN_VERSION, Weight = 0, Font = titleFont, MaximumSize = {760, 22}}),
    ui:HGroup({Weight = 0, MaximumSize = {760, 28}}, {
        button("refresh", "Refresh", 86),
        label("Track", 38),
        ui:ComboBox({
            ID = "subtitleTrack",
            Items = initialSubtitleTrackLabels,
            CurrentIndex = 0,
            Weight = 0,
            Font = smallFont,
            MinimumSize = {174, 24},
            MaximumSize = {174, 24},
        }),
        button("mark", "Resolve I/O", 92),
        button("clearSelection", "Clear", 58),
        button("probe", "Probe", 58),
        button("openLogs", "Logs", 54),
        ui:Label({
            ID = "selectionStatus",
            Text = "Selected: 0",
            Weight = 1,
            Font = smallFont,
            MinimumSize = {92, 22},
            MaximumSize = {760, 22},
        }),
    }),
    ui:Tree({
        ID = "subtitleTree",
        Weight = 0.74,
        ColumnCount = 6,
        HeaderHidden = false,
        RootIsDecorated = false,
        AlternatingRowColors = true,
        AllColumnsShowFocus = true,
        SelectionBehavior = "SelectRows",
        SelectionMode = "ExtendedSelection",
        UniformRowHeights = true,
        Font = smallFont,
    }),
    ui:HGroup({Weight = 0, MaximumSize = {760, 28}}, {
        label("Voice", 44),
        ui:ComboBox({
            ID = "profile",
            Items = initialProfileLabels,
            CurrentIndex = 0,
            Weight = 0,
            Font = smallFont,
            MinimumSize = {190, 24},
            MaximumSize = {190, 24},
        }),
        label("Speed", 42),
        lineEdit("speed", "", "default", 76),
        label("Gain", 34),
        lineEdit("loudness", "", "default", 76),
        button("openConfig", "Config", 62),
        button("reloadConfig", "Reload", 62),
    }),
    ui:HGroup({Weight = 0, MaximumSize = {760, 28}}, {
        ui:CheckBox({
            ID = "skipOverflow",
            Text = "Skip overflow",
            Checked = false,
            Weight = 0,
            Font = smallFont,
            MinimumSize = {120, 24},
            MaximumSize = {120, 24},
        }),
        button("playhead", "Locate", 68),
        button("rangeSelect", "Range", 68),
        button("synthesizeInsert", "Insert", 86),
        button("close", "Close", 64),
    }),
    ui:TextEdit({
        ID = "log",
        Weight = 0.24,
        ReadOnly = true,
        AcceptRichText = false,
        Font = smallFont,
    }),
}))

if not win then
    appendLog("window creation failed")
    return
end

items = win:GetItems()
local initialProfileReloaded = reloadVoiceoverConfig(true)

local function onClose(ev)
    appendLog("lua plugin close")
    dispatcher:ExitLoop()
end

win.On[WINDOW_ID].Close = onClose
win.On["close"].Clicked = onClose
win.On["refresh"].Clicked = refreshSubtitles
win.On["subtitleTrack"].CurrentIndexChanged = subtitleTrackChanged
win.On["playhead"].Clicked = usePlayhead
win.On["rangeSelect"].Clicked = selectRangeFromLocateAnchor
win.On["mark"].Clicked = useMark
win.On["clearSelection"].Clicked = clearSelection
win.On["subtitleTree"].ItemSelectionChanged = onSubtitleSelectionChanged
win.On["probe"].Clicked = probe
win.On["openLogs"].Clicked = openLogs
win.On["openConfig"].Clicked = openRuntimeConfig
win.On["reloadConfig"].Clicked = reloadVoiceoverConfig
win.On["synthesizeInsert"].Clicked = synthesizeInsert

win:Show()
appendLog("lua plugin window shown")
refreshSubtitles(nil)
uiLog(voiceConfigStatusLine())
if not initialProfileReloaded then
    uiLog("Profile dropdown did not update during startup. Click Reload.")
end
dispatcher:RunLoop()
