// All modules together, on a copy of the real settings. Run with:
//   CLONE=1 SHOTS=eval EVAL="$(cat tests/integration.js)" tools/shell-test.sh <sandbox> light hide-accessibility=true
// Then read <sandbox>/shots/eval.txt, and <sandbox>/shell.log for: already disposed,
// TypeError, Unhandled promise, add_child: assertion, isnan, no handler with id.
// Every module off and on, the dock rebuilt, off and on, a folder and a dialog open
// through a glass restart, the launcher's surface, a quick window, a lock cycle.
const ext = Main.extensionManager.lookup("super-g@soheil").stateObj;
const s = ext._settings; const out = {};
const settle = async (ms = 700) => { await ext._queue; await wait(ms); await ext._queue; };
const stops = []; const origStop = ext._stop;
ext._stop = function (n) { stops.push(n); return origStop.call(this, n); };
const a11y = Main.panel.statusArea.a11y.container;
await settle(1500);
out.start = {a11y: a11y.visible, mods: [...ext._active.keys()]};
s.set_boolean("hide-accessibility", false); await wait(400); out.a11yShownWhenAsked = a11y.visible;
s.set_boolean("hide-accessibility", true); await wait(400); out.a11yHiddenWhenAsked = a11y.visible;

// Drawer: most-used row plus sections.
const drawer = ext._active.get("drawer");
s.set_boolean("app-drawer-suggestions", true);
const all = drawer._allApps();
const usage = imports.gi.Shell.AppUsage.get_default();
usage.get_most_used = () => all.slice(0, 7);
const dock = drawer._dockExt.dockManager._allDocks[0];
const button = dock?.dash?._showAppsIcon?.toggleButton;
if (button) {
  drawer.open(dock, button); await wait(600);
  const tiles = [...drawer._tiles.entries()];
  out.drawer = {apps: all.length, shown: drawer._visible.length, orphanTiles: tiles.filter(([, t]) => !t.button.get_parent()).length,
    usedTiles: tiles.filter(([k]) => k.startsWith("used/")).length};
  await wait(1500);
  out.drawer.tilesAfterSettling = [...drawer._tiles.values()].filter(t => t.button.get_parent()).length;
  await shot("drawer-all");
  drawer.close(true); await wait(200);
} else out.drawer = "no dock button";

// A dock rebuild must not leave dead buttons behind.
const before = drawer._buttons.size;
drawer._dockExt.dockManager._toggle?.(); await wait(1500);
const style = s.get_string("app-drawer-style");
s.set_string("app-drawer-style", style === "overview" ? "dock-popup" : "overview"); await wait(200);
s.set_string("app-drawer-style", style); await wait(300);
out.dockRebuild = {before, after: drawer._buttons.size};

// A folder and a dialog open through a glass restart.
await shot("overview-before");
const Gio = imports.gi.Gio;
const folders = new Gio.Settings({schema_id: "org.gnome.desktop.app-folders"});
const child = new Gio.Settings({schema_id: "org.gnome.desktop.app-folders.folder", path: "/org/gnome/desktop/app-folders/folders/Test/"});
child.set_string("name", "Test");
child.set_strv("apps", ["org.gnome.TextEditor.desktop", "org.gnome.Calculator.desktop", "org.gnome.Nautilus.desktop"]);
folders.set_strv("folder-children", [...folders.get_strv("folder-children"), "Test"]);
await wait(1500);
const appDisplay = Main.overview._overview.controls._appDisplay;
appDisplay._redisplay?.(); await wait(500);
const folder = appDisplay._folderIcons?.[0];
const washes = p => p ? p.get_children().filter(c => /background-color: rgba\((0,0,0,0.38|255,255,255,0.28)\)/.test(c.style ?? "")).length : -1;
if (folder) {
  Main.overview.showApps(); await wait(1200);
  await shot("overview-apps");
  folder.open?.() ?? folder.view; await wait(800);
  const dialog = folder._dialog; const parent = dialog?.get_parent();
  out.folder = {opened: !!dialog, washesOpen: washes(parent), tracked: ext._active.get("glass")._folders.size};
  dialog?.popdown?.(); await wait(500);
  Main.overview.hide(); await wait(900);
  s.set_boolean("module-glass", false); await settle();
  out.folder.washesGlassOff = washes(parent); out.folder.easeOverride = dialog ? Object.hasOwn(dialog, "ease") : null;
  s.set_boolean("module-glass", true); await settle();
} else out.folder = "no folders here";

const ModalDialog = await import("resource:///org/gnome/shell/ui/modalDialog.js");
const dlg = new ModalDialog.ModalDialog({styleClass: "test"});
dlg.open(); await wait(400);
s.set_boolean("module-glass", false); await settle();
s.set_boolean("module-glass", true); await settle();
dlg.close(); await wait(600);
await wait(200);

// Launcher surface comes back without glass.
const mat = ext._active.get("launcher")?.instance?._materialLayer;
if (mat) {
  ext._active.get("launcher").instance._updateTheme();
  const glassed = mat.style;
  s.set_boolean("module-glass", false); await settle();
  out.launcher = {glassed: !!glassed?.includes("transparent"), withoutGlass: mat.style ?? "(none)"};
  s.set_boolean("module-glass", true); await settle();
  out.launcher.again = !!mat.style?.includes("transparent");
}

// Dock off and on: what hangs on it goes first and comes back on the new one.
stops.length = 0;
s.set_boolean("module-dock", false); await settle(1200);
out.dockOff = {stops: [...stops], active: [...ext._active.keys()]};
stops.length = 0;
s.set_boolean("module-dock", true); await settle(2500);
const fresh = ext._active.get("dock");
out.dockOn = {stops: [...stops], active: [...ext._active.keys()], magnifier: !!fresh?.magnifier,
  stale: ["dockmotion", "windows", "glass", "drawer"].filter(n => ext._active.get(n)?.dock !== fresh)};

// Every module off and on, in turn.
const mods = ["corners", "windows", "panel", "glass", "drawer", "hotcorners", "gestures", "launcher", "dockmotion", "appearance"];
out.toggled = {};
for (const m of mods) {
  s.set_boolean(`module-${m}`, false); await settle(500);
  const off = !ext._active.has(m);
  s.set_boolean(`module-${m}`, true); await settle(800);
  out.toggled[m] = off && ext._active.has(m);
}
out.a11yAfterToggles = a11y.visible;

// Menus and quick windows, then a whole lock cycle.
const qs = Main.panel.statusArea.quickSettings.menu;
qs.open(true); await wait(400); qs.close(true); await wait(400);
const Shell = imports.gi.Shell;
const editor = Shell.AppSystem.get_default().lookup_app("org.gnome.TextEditor.desktop");
if (editor) {
  editor.open_new_window(-1); await wait(1500);
  editor.get_windows().forEach(w => w.delete(global.get_current_time())); await wait(800);
  out.quickWindow = true;
}
out.broken = s.get_strv("broken-modules");
out.beforeLock = a11y.visible;
Main.screenShield.lock(false); await wait(2500);
out.locked = {a11y: a11y.visible, mods: [...ext._active.keys()]};
Main.screenShield.deactivate(false);
await wait(500); await settle(1800);
out.unlocked = {a11y: a11y.visible, mods: [...ext._active.keys()], broken: s.get_strv("broken-modules")};
return out;
