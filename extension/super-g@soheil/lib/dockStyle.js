// SPDX-License-Identifier: GPL-3.0-or-later
// The Super G look for the dock engine (Dash to Dock) and its motion
// engine (Flourish): palette glass, no hover boxes, a themed apps button and
// small running dots. One-time defaults are applied once and then left to
// the user; the look is reapplied whenever the palette or scheme changes.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Files from './files.js';
import {LiveStylesheet} from './stylesheet.js';
import {resolve} from './themeGen.js';
import {withAlpha} from './color.js';
import {DockMagnifier} from './dockMagnify.js';

const TUNED = `${Files.STATE}/tuned.json`;

export function onceOnly(name, apply) {
    const done = JSON.parse(Files.readText(TUNED) ?? '{}');
    if (done[name])
        return;
    apply();
    done[name] = true;
    Files.writeText(TUNED, JSON.stringify(done, null, 2));
}

function setIf(settings, key, value) {
    const cur = settings.get_value(key).recursiveUnpack();
    if (cur !== value)
        settings.set_value(key, new GLib.Variant(settings.get_value(key).get_type_string(), value));
}

/* ------------------------------------------------------------ dock -- */

export function configureDock(module) {
    const dtd = module.instance.getSettings();
    // The dock's Settings item asks its extension, which isn't a real one here.
    module.instance.openPreferences = () => {
        module.settings.set_string('prefs-open-page', 'dock');
        module.ext.openPreferences();
    };
    // Dash to Dock paints its own background inline when its custom theme
    // or alpha options are on; that would cover our glass.
    setIf(dtd, 'apply-custom-theme', false);
    setIf(dtd, 'custom-background-color', false);
    setIf(dtd, 'customize-alphas', false);
    setIf(dtd, 'transparency-mode', 'DEFAULT');
    onceOnly('dock', () => {
        setIf(dtd, 'dock-position', 'BOTTOM');
        setIf(dtd, 'show-apps-at-top', true);
        setIf(dtd, 'extend-height', false);
        setIf(dtd, 'dock-fixed', false);
        setIf(dtd, 'intellihide', true);
        setIf(dtd, 'running-indicator-style', 'DOT');
        setIf(dtd, 'hide-tooltip', true);
        setIf(dtd, 'show-show-apps-button', true);
        // Apple-sized: about 72 physical pixels at 133% scaling.
        setIf(dtd, 'dash-max-icon-size', 54);
    });

    // The engine's own dots draw over the icon's art; the plain one sits below.
    onceOnly('dock-dot-below', () => setIf(dtd, 'running-indicator-style', 'DEFAULT'));

    const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    const tokens = JSON.parse(Files.readText(`${module.ext.path}/tokens.json`));
    const sheet = new LiveStylesheet('dock');
    const appsIcon = new AppsIcon(module);
    const apply = () => {
        const dark = iface.get_string('color-scheme') === 'prefer-dark';
        sheet.set(dockCss(tokens, module.settings, dark, dtd.get_int('dash-max-icon-size')));
        appsIcon.update(resolve(tokens, {palette: module.settings.get_string('palette'),
            accent: module.settings.get_string('accent')}, dark));
    };
    module.connect(iface, 'changed::color-scheme', apply);
    module.connect(module.settings, 'changed', () => module.later('dock-css', 120, apply));
    module.connect(dtd, 'changed::dash-max-icon-size', apply);
    appsIcon.patch().then(() => {
        apply();
        module.magnifier = new DockMagnifier(module, appsIcon.dockExt);
        module.magnifier.enable();
    }).catch(e => module.ext.reportError(module.name, e));
    module.cleanupExtra = () => {
        module.magnifier?.disable();
        module.magnifier = null;
        sheet.clear();
        appsIcon.unpatch();
    };
}

// The apps button gets an app-style icon (palette squircle with a dot grid)
// so it sits in the dock like any other app. Dash to Dock builds that icon in
// DockShowAppsIcon._createIcon, which is wrapped here.
class AppsIcon {
    constructor(module) {
        this._module = module;
        this._file = null;
    }

    get dockExt() {
        return this._dockExt;
    }

    async patch() {
        const path = this._module.instance.path;
        this._appIcons = await import(`file://${path}/appIcons.js`);
        this._dockExt = await import(`file://${path}/extension.js`);
        const proto = this._appIcons.DockShowAppsIcon.prototype;
        const original = this._original = proto._createIcon;
        // Docks are (re)built asynchronously; repaint the button when they are.
        this._readyId = this._dockExt.dockManager?.connect('docks-ready', () => this._refresh());
        const self = this;
        // Existing icons stay bound to this wrapper after unpatch, and the
        // dock rebuilds them while it shuts down, so it keeps its own original.
        proto._createIcon = function (size) {
            const actor = original.call(this, size);
            if (self._file)
                actor.gicon = new Gio.FileIcon({file: self._file});
            return actor;
        };
    }

    unpatch() {
        if (this._readyId)
            this._dockExt.dockManager?.disconnect(this._readyId);
        this._readyId = 0;
        if (this._original)
            this._appIcons.DockShowAppsIcon.prototype._createIcon = this._original;
        this._original = null;
        this._file = null;
        this._refresh();
    }

    update(c) {
        const tile = c.dark ? '#45475a' : '#ffffff';
        const dot = c.dark ? c.fg : c.fg;
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
<rect x="6" y="6" width="116" height="116" rx="28" fill="${tile}" fill-opacity="${c.dark ? 0.92 : 0.95}"/>
<rect x="6.5" y="6.5" width="115" height="115" rx="27.5" fill="none" stroke="${c.fg}" stroke-opacity="0.12"/>
${[0, 1, 2].flatMap(r => [0, 1, 2].map(k =>
        `<rect x="${33 + k * 24}" y="${33 + r * 24}" width="14" height="14" rx="4.5" fill="${r === 1 && k === 1 ? c.accent : dot}" fill-opacity="${r === 1 && k === 1 ? 1 : 0.72}"/>`)).join('\n')}
</svg>`;
        const path = `${Files.CACHE}/apps-icon-${c.dark ? 'dark' : 'light'}-${c.accent.slice(1)}-${c.fg.slice(1)}.svg`;
        Files.writeText(path, svg);
        this._file = Gio.File.new_for_path(path);
        this._refresh();
    }

    // Each button's BaseIcon keeps the icon builder it was created with
    // (BaseIcon.createIcon), so wrap that per button and rebuild the icon.
    _refresh() {
        for (const dock of this._dockExt?.dockManager?._allDocks ?? []) {
            const apps = dock.dash?._showAppsIcon;
            // Labels off means this one too; it asks for its label itself.
            if (apps && this._module.instance.getSettings().get_boolean('hide-tooltip'))
                apps.showLabel = () => {};
            const base = apps?.icon;
            if (!base?._createIconTexture)
                continue;
            if (this._file && !base._superGCreate) {
                base._superGCreate = base.createIcon;
                base.createIcon = size => {
                    const actor = base._superGCreate(size);
                    if (this._file)
                        actor.gicon = new Gio.FileIcon({file: this._file});
                    return actor;
                };
            } else if (!this._file && base._superGCreate) {
                base.createIcon = base._superGCreate;
                delete base._superGCreate;
            }
            base._createIconTexture(base.iconSize);
        }
    }
}

// Proportions follow Apple's dock: icons ~75% of the dock height, gaps ~10%
// of an icon, corner radius ~30% of the height, light glass, bright top edge.
function dockCss(tokens, settings, dark, iconSize) {
    const c = resolve(tokens, {palette: settings.get_string('palette'), accent: settings.get_string('accent')}, dark);
    const D = '#uiGroup #dashtodockContainer';
    // With Super G glass on, the glass layer draws the whole surface.
    const glassOn = settings.get_boolean('module-glass');
    const glass = glassOn ? 'transparent' : dark ? withAlpha(c.window, 0.38) : withAlpha('#ffffff', 0.3);
    const edge = dark ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.75)';
    const rim = dark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.45)';
    return `/* Generated by super-g: dock. */
${D} #dash { padding: 0; }
${D}.bottom #dash { margin-bottom: 8px; }
${D}.top #dash { margin-top: 8px; }
${D}.left #dash { margin-left: 8px; }
${D}.right #dash { margin-right: 8px; }
/* Blur my Shell clears the dock background with !important; the glass tint
   on top of its blur has to match that to show. */
${D} .dash-background, ${D} .dash-background.transparent-dash {
  background-color: ${glass} !important; border-radius: 26px; border: none; margin: 0;
  box-shadow: ${glassOn ? 'none' : `inset 0 1px 0 ${edge}, inset 0 0 0 1px ${rim}, 0 10px 30px rgba(0,0,0,${dark ? 0.35 : 0.14})`}; }
${D} .dash-item-container > StButton, ${D} .show-apps {
  padding: 9px 3px 11px 3px; margin: 0; }
${D}.left .dash-item-container > StButton, ${D}.left .show-apps { padding: 3px 9px 3px 11px; }
${D}.right .dash-item-container > StButton, ${D}.right .show-apps { padding: 3px 11px 3px 9px; }
${D} .dash-item-container { margin: 0; padding: 0; }
${D} .overview-icon { padding: 0; }
${D} .notification-badge { background-color: #ff3b30; color: #ffffff; font-weight: 600; border-radius: 999px;
  padding: 1px 6px; margin: 0; text-shadow: none; box-shadow: 0 1px 3px rgba(0,0,0,0.3); }
/* Its natural size follows the newest thumbnail, which moved the whole dock. */
${D}.bottom .kiwi-downloads-item, ${D}.top .kiwi-downloads-item { margin: 0; padding: 9px 3px 11px 3px; height: ${iconSize}px; }
${D}.left .kiwi-downloads-item, ${D}.right .kiwi-downloads-item { margin: 0; padding: 3px 9px 3px 11px; width: ${iconSize}px; }
${D} .dash-item-container > StButton:hover, ${D} .dash-item-container > StButton:focus,
${D} .dash-item-container > StButton:active, ${D} .dash-item-container > StButton:checked,
${D} .overview-tile:hover .overview-icon, ${D} .overview-tile:focus .overview-icon,
${D} .overview-tile:checked .overview-icon, ${D} .app-well-app:hover .overview-icon,
${D} .app-well-app:focus .overview-icon, ${D} .app-well-app:checked .overview-icon,
${D} .show-apps .overview-icon, ${D} .show-apps:hover .overview-icon, ${D} .show-apps:checked .overview-icon {
  background-color: transparent; box-shadow: none; }
${D} .overview-icon { background-color: transparent !important; box-shadow: none; }
${D} .overview-tile, ${D} .overview-tile:hover, ${D} .overview-tile:focus { background-color: transparent; }
${D} .app-grid-running-dot { background-color: ${c.fg}; width: 5px; height: 5px; border-radius: 3px; margin: 0; }
${D} .dash-separator { background-color: ${dark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.14)'} !important; }
/* The engine sizes its length; the margins must leave the dock's height alone. */
${D}.bottom .dash-separator, ${D}.top .dash-separator { width: 1px; margin: 7px 5px; }
${D}.left .dash-separator, ${D}.right .dash-separator { height: 1px; margin: 5px 7px; }
${D} .dash-label, #uiGroup .dash-label {
  background-color: ${withAlpha(c.popover, 0.92)}; color: ${c.fg}; border-radius: 999px;
  border: none; box-shadow: inset 0 0 0 1px ${c.hairline}; padding: 4px 12px; }
`;
}

/* ------------------------------------------------------ dock motion -- */

export function configureDockMotion(module) {
    const s = module.instance.getSettings();
    // Hover magnification is ours (lib/dockMagnify.js); Flourish keeps press,
    // launch and attention motion.
    setIf(s, 'custom-hover-enabled', false);
    // Magnification on by default, Apple-like: neighbours make room, a short
    // reach, a quick ease. After this first run the user's choice stands.
    onceOnly('dockmotion', () => {
        setIf(s, 'motion-profile', 'custom');
        setIf(s, 'show-hover-background', false);
    });
    // Click: the magnifier settles the row, then one soft bounce while the app
    // starts, as on a Mac. A squash on press or a stretch fights both.
    onceOnly('dockmotion-launch', () => {
        setIf(s, 'custom-press-enabled', false);
        setIf(s, 'custom-launch-effect', 'bounce');
        setIf(s, 'custom-launch-intensity', 0.45);
        setIf(s, 'custom-launch-repeat', false);
    });
}
