--[[--
Ruoka cookbook for KOReader.

While KOReader is open, asks the Ruoka app on the home network every few seconds whether a recipe
was sent with "Open on Kindle", and opens it. Every half hour (and at start) it also refreshes the
full cookbook, downloading it only when the app's ETag changed.

Nothing connects into the Kindle: the plugin only makes outgoing requests to the configured server.
--]]--

local DataStorage = require("datastorage")
local Device = require("device")
local InfoMessage = require("ui/widget/infomessage")
local InputDialog = require("ui/widget/inputdialog")
local NetworkMgr = require("ui/network/manager")
local UIManager = require("ui/uimanager")
local WidgetContainer = require("ui/widget/container/widgetcontainer")
local http = require("socket.http")
local lfs = require("libs/libkoreader-lfs")
local logger = require("logger")
local ltn12 = require("ltn12")
local rapidjson = require("rapidjson")
local socket = require("socket")
local socketutil = require("socketutil")
local _ = require("gettext")

-- Sent as the User-Agent, so the Ruoka app can show which release is on the Kindle. Bump it with
-- every change to this plugin.
local PLUGIN_VERSION = 2
local USER_AGENT = "Ruoka-KOReader/" .. PLUGIN_VERSION
local POLL_SECONDS = 5
-- A recipe that fails to download is tried again on the next polls before giving up on it
local MAX_ATTEMPTS = 5
-- While the cookbook is open it is not replaced under the reader; look again this soon
local BUSY_RETRY_SECONDS = 60
local MAX_BACKOFF_SECONDS = 60
local COOKBOOK_EVERY_SECONDS = 30 * 60

local Ruoka = WidgetContainer:extend{
    name = "ruoka",
    is_doc_only = false,
}

-- A plugin is instantiated again on every document load and reader/file manager switch, so the
-- poller lives at module level and is started once
local settings = G_reader_settings:readSetting("ruoka", { enabled = true })
local state = {
    running = false,
    last_request = nil,
    attempts = {},
    failures = 0,
    next_cookbook_check = 0,
}

-- The Kindle keeps books in /mnt/us/documents, which earlier releases always used. Other KOReader
-- devices have no such folder, so use the home folder set in KOReader, then the device's own.
local paths
local function getPaths()
    if paths then return paths end
    local dir = "/mnt/us/documents"
    if lfs.attributes(dir, "mode") ~= "directory" then
        dir = G_reader_settings:readSetting("home_dir") or Device.home_dir or DataStorage:getDataDir()
        dir = dir:gsub("/+$", "")
    end
    paths = {
        cookbook = dir .. "/Ruoka-Cookbook.epub",
        -- Hidden from the file browser; single recipes are opened from here and old ones cleared away
        recipes = dir .. "/.ruoka",
    }
    return paths
end

local function openFile()
    local ReaderUI = require("apps/reader/readerui")
    return ReaderUI.instance and ReaderUI.instance.document and ReaderUI.instance.document.file
end

local function readDefaultServer(plugin_path)
    local f = plugin_path and io.open(plugin_path .. "/server.txt", "r")
    if not f then return nil end
    local text = f:read("*l")
    f:close()
    if text then text = text:gsub("%s+", ""):gsub("/+$", "") end
    if text == "" then return nil end
    return text
end

local function connected()
    local ok, result = pcall(function() return NetworkMgr:isConnected() end)
    -- Some devices return nothing here; then just try the request
    return not ok or result ~= false
end

local function request(spec, block_timeout, total_timeout)
    spec.headers = spec.headers or {}
    spec.headers["User-Agent"] = USER_AGENT
    socketutil:set_timeout(block_timeout, total_timeout)
    local ok, code, headers = pcall(function()
        local c, h = socket.skip(1, http.request(spec))
        return c, h
    end)
    socketutil:reset_timeout()
    if not ok then
        logger.warn("Ruoka: request failed", code)
        return nil, nil
    end
    return code, headers
end

local function download(url, path, extra_headers)
    local tmp = path .. ".part"
    local file = io.open(tmp, "wb")
    if not file then return nil end
    local headers = { ["Accept-Encoding"] = "identity" }
    for k, v in pairs(extra_headers or {}) do headers[k] = v end
    local code, response_headers = request({
        url = url,
        headers = headers,
        sink = ltn12.sink.file(file),
    }, socketutil.FILE_BLOCK_TIMEOUT, socketutil.FILE_TOTAL_TIMEOUT)
    if code == 200 then
        os.rename(tmp, path)
    else
        os.remove(tmp)
    end
    return code, response_headers
end

local function openBook(path)
    local ReaderUI = require("apps/reader/readerui")
    if ReaderUI.instance then
        ReaderUI.instance:switchDocument(path)
    else
        ReaderUI:showReader(path)
    end
end

local function clearOldRecipes(keep)
    local dir = getPaths().recipes
    if lfs.attributes(dir, "mode") ~= "directory" then
        lfs.mkdir(dir)
        return
    end
    local open = openFile()
    for name in lfs.dir(dir) do
        local full = dir .. "/" .. name
        if name:match("%.epub$") and full ~= keep and full ~= open then os.remove(full) end
    end
end

local function checkRequest(server)
    local body = {}
    local code = request({
        url = server .. "/kindle/request",
        sink = ltn12.sink.table(body),
    }, 3, 5)
    if code == 204 then return true end
    if code ~= 200 then return false end
    local ok, req = pcall(rapidjson.decode, table.concat(body))
    if not ok or type(req) ~= "table" or type(req.id) ~= "string" or type(req.url) ~= "string" then
        return true
    end
    if req.id == state.last_request then return true end

    local safe = tostring(req.recipe or "recipe"):gsub("[^%w%-]", "-")
    local path = string.format("%s/%s-%s.epub", getPaths().recipes, safe, tostring(req.servings or ""))
    clearOldRecipes(path)
    if download(server .. req.url, path) ~= 200 then
        -- A Wi-Fi blip should not lose the recipe: the app keeps offering it, so try the next polls
        local attempts = (state.attempts[req.id] or 0) + 1
        state.attempts[req.id] = attempts
        if attempts >= MAX_ATTEMPTS then
            state.last_request = req.id
            state.attempts = {}
            UIManager:show(InfoMessage:new{ text = _("Could not download the recipe from Ruoka."), timeout = 4 })
        end
        return true
    end
    state.last_request = req.id
    state.attempts = {}
    request({ url = server .. "/kindle/opened/" .. req.id, method = "POST", source = ltn12.source.empty() }, 3, 5)
    logger.info("Ruoka: opening", req.recipe)
    UIManager:nextTick(function() openBook(path) end)
    return true
end

local function checkCookbook(server, force)
    local path = getPaths().cookbook
    local is_open = openFile() == path
    -- The "This week" page changes length from day to day, so replacing the book while it is read
    -- would move pages and highlights under the reader. Asked for from the menu, it is reloaded.
    if is_open and not force then return "busy" end
    local headers = {}
    if not force and settings.etag and lfs.attributes(path, "mode") == "file" then
        headers["If-None-Match"] = settings.etag
    end
    local code, response_headers = download(server .. "/cookbook.epub", path, headers)
    if code == 200 and response_headers then
        settings.etag = response_headers.etag or response_headers.ETag
        G_reader_settings:saveSetting("ruoka", settings)
        logger.info("Ruoka: cookbook updated")
        if is_open then
            UIManager:nextTick(function()
                local ReaderUI = require("apps/reader/readerui")
                if ReaderUI.instance then pcall(function() ReaderUI.instance:reloadDocument() end) end
            end)
        end
        return "updated"
    end
    if code == 304 then return "current" end
    return nil
end

local poll

local function schedule(seconds)
    UIManager:scheduleIn(seconds, poll)
end

poll = function()
    local server = settings.server
    if not settings.enabled or not server then
        state.running = false
        return
    end
    if not connected() then
        schedule(15)
        return
    end
    local ok = checkRequest(server)
    if ok and os.time() >= state.next_cookbook_check then
        local result = checkCookbook(server, false)
        state.next_cookbook_check = os.time()
            + (result == "busy" and BUSY_RETRY_SECONDS or COOKBOOK_EVERY_SECONDS)
    end
    -- An unreachable server would otherwise stall the screen with a timeout every few seconds
    state.failures = ok and 0 or state.failures + 1
    schedule(math.min(MAX_BACKOFF_SECONDS, POLL_SECONDS * (2 ^ state.failures)))
end

local function start()
    if state.running or not settings.enabled or not settings.server then return end
    state.running = true
    state.failures = 0
    UIManager:nextTick(poll)
end

local function stop()
    UIManager:unschedule(poll)
    state.running = false
end

function Ruoka:init()
    if not settings.server then
        settings.server = readDefaultServer(self.path)
        if settings.server then G_reader_settings:saveSetting("ruoka", settings) end
    end
    self.ui.menu:registerToMainMenu(self)
    start()
end

-- The Kindle drops Wi-Fi in its sleep screen; start again on waking
function Ruoka:onSuspend()
    stop()
end

function Ruoka:onResume()
    state.next_cookbook_check = 0
    start()
end

function Ruoka:addToMainMenu(menu_items)
    menu_items.ruoka = {
        text = _("Ruoka cookbook"),
        sorting_hint = "tools",
        sub_item_table = {
            {
                text = _("Update cookbook now"),
                callback = function()
                    if not settings.server then
                        UIManager:show(InfoMessage:new{ text = _("Set the Ruoka server address first.") })
                        return
                    end
                    local result = checkCookbook(settings.server, true)
                    UIManager:show(InfoMessage:new{
                        text = result and _("Cookbook updated.") or _("Could not reach the Ruoka app."),
                        timeout = 3,
                    })
                end,
            },
            {
                text = _("Open cookbook"),
                enabled_func = function() return lfs.attributes(getPaths().cookbook, "mode") == "file" end,
                callback = function() openBook(getPaths().cookbook) end,
            },
            {
                text = _("Listen for \"Open on Kindle\""),
                checked_func = function() return settings.enabled end,
                callback = function()
                    settings.enabled = not settings.enabled
                    G_reader_settings:saveSetting("ruoka", settings)
                    if settings.enabled then start() else stop() end
                end,
            },
            {
                text_func = function()
                    return _("Server: ") .. (settings.server or _("not set"))
                end,
                keep_menu_open = true,
                callback = function(touchmenu_instance)
                    local dialog
                    dialog = InputDialog:new{
                        title = _("Ruoka server address"),
                        input = settings.server or "http://",
                        buttons = {{
                            { text = _("Cancel"), id = "close", callback = function() UIManager:close(dialog) end },
                            { text = _("Save"), is_enter_default = true, callback = function()
                                local value = dialog:getInputText():gsub("%s+", ""):gsub("/+$", "")
                                settings.server = value ~= "" and value or nil
                                settings.etag = nil
                                G_reader_settings:saveSetting("ruoka", settings)
                                UIManager:close(dialog)
                                stop()
                                start()
                                if touchmenu_instance then touchmenu_instance:updateItems() end
                            end },
                        }},
                    }
                    UIManager:show(dialog)
                    dialog:onShowKeyboard()
                end,
            },
        },
    }
end

return Ruoka
